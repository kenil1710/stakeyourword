/**
 * A single create → verify round trip, to prove the two nondet paths work at
 * all before the rest of the suite is written against them.
 *
 * Usage: node probe.mjs [--network=studionet] [--url=https://example.com]
 */
import { readFileSync } from "node:fs";
import { connect, argOf, sleep, returnedJson } from "./harness.mjs";

const deployed = JSON.parse(readFileSync(new URL("./.deployed.json", import.meta.url), "utf8"));
const address = argOf("address", deployed.address);
const networkName = argOf("network", deployed.network ?? "studionet");
const url = argOf("url", "https://example.com");
const GEN = 10n ** 18n;
const gen = (wei) => `${(Number(wei) / 1e18).toFixed(6)} GEN`;

const owner = connect({ networkName, address, role: "client" });
const committer = connect({ networkName, address, role: "committer1" });
const hunter = connect({ networkName, address, role: "hunter" });

if (owner.chain.isStudio) {
  const { fundOnStudio } = await import("./harness.mjs");
  for (const who of [owner, committer, hunter]) {
    await fundOnStudio(owner.chain, who.account.address, 20n * GEN);
  }
  console.log("funded three accounts on studio");
}

const balOf = async (who) => owner.read.getBalance({ address: who }).catch(() => 0n);

console.log(`\ncontract ${address} on ${networkName}`);
console.log(`proof url ${url}\n`);

// ── create ──────────────────────────────────────────────────────────────────
const PERIOD_MIN = 5;
const STAKE = GEN / 10n;

console.log("create_commitment …");
const created = await committer.send(
  "create_commitment",
  [
    "I will keep this page reachable and unchanged for the probe window",
    url,
    connect({ networkName, address, role: "beneficiary1" }).account.address,
    PERIOD_MIN,
    STAKE.toString(),
    false,
  ],
  STAKE,
);
console.log(`  ${created.status} in ${created.seconds?.toFixed(0)}s`);
if (!created.ok) {
  console.log(`  FAILED: ${created.revertReason || created.failure}`);
  console.log(created.stderr.slice(0, 2000));
  process.exit(1);
}
const body = returnedJson(created.returned);
console.log(`  returned: ${JSON.stringify(body)}`);
if (!body?.ok) {
  console.log(`  contract REJECTED and refunded: ${body?.reason}`);
  process.exit(1);
}
const id = body.id;

const view = await committer.viewJson("get_commitment", [id]);
console.log(`  id=${id} status=${view.status} funded=${view.periods_funded} ` +
  `hash=${view.created_hash} next_deadline=${view.next_deadline}`);
console.log(`  preview: ${JSON.stringify(view.created_preview.slice(0, 120))}`);

// ── wait out the period ─────────────────────────────────────────────────────
const stats = await committer.viewJson("get_stats");
const waitFor = Math.max(0, view.next_deadline - stats.now) + 15;
console.log(`\nwaiting ${waitFor}s for period 1 to come due …`);
await sleep(waitFor * 1000);

const board = await hunter.viewJson("get_verifiable_now");
console.log(`get_verifiable_now -> ${board.length} row(s)` +
  (board[0] ? `, action=${board[0].action} bounty=${gen(BigInt(board[0].bounty))}` : ""));

// ── verify, as a third party so the bounty is exercised ─────────────────────
const before = {
  committer: await balOf(committer.account.address),
  hunter: await balOf(hunter.account.address),
};

console.log("\nverify_commitment (called by hunter, so a bounty is due) …");
const verified = await hunter.send("verify_commitment", [id]);
console.log(`  ${verified.status} in ${verified.seconds?.toFixed(0)}s -> ${verified.returned}`);
if (!verified.ok) {
  console.log(`  FAILED: ${verified.revertReason || verified.failure}`);
  console.log(verified.stderr.slice(0, 3000));
  process.exit(1);
}

const after = await committer.viewJson("get_commitment", [id]);
const row = after.history[after.history.length - 1];
console.log(`\n  verdict      ${row.verdict}  (confidence ${row.confidence})`);
console.log(`  reachable    ${row.reachable}   unchanged ${row.unchanged}   injection ${row.injection_flagged}`);
console.log(`  reasoning    ${row.reasoning}`);
console.log(`  bounty       ${gen(BigInt(row.caller_bounty))} -> ${row.caller}`);
console.log(`  to committer ${gen(BigInt(row.to_committer))}`);
console.log(`  to benef.    ${gen(BigInt(row.to_beneficiary))}`);
console.log(`  status now   ${after.status}`);

const legs = BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary);
console.log(`\n  legs sum to the period stake: ${legs === STAKE ? "YES" : `NO (${legs} vs ${STAKE})`}`);

const s = await committer.viewJson("get_stats");
console.log(`  locked_stakes ${s.locked_stakes}  balance ${s.balance}  unallocated ${s.unallocated}`);
