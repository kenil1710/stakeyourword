/**
 * The reproduction the review asked for, on the network this contract runs on.
 *
 * For each commitment it prints, in order: the fee quote the wallet was checked
 * against, the `create_commitment` transaction hash, the receipt as the chain
 * reports it (accepted, then finalized), the resulting commitment id, and the
 * state the frontend reads back afterwards — through the deployed app's own
 * same-origin relay, not a private path.
 *
 * The wallet-confirmation screen is the one piece that cannot appear here:
 * these accounts are local signing keys, so nothing prompts. The preflight that
 * WOULD gate that screen is shown instead, with the exact numbers it checks.
 *
 * Usage: node proof-commitments.mjs [--network=studiodev] [--count=3]
 */
import { readFileSync } from "node:fs";
import { createClient } from "genlayer-js";
import { CHAINS, connect, argOf, sleep, returnedJson, fundOnStudio } from "./harness.mjs";
import { gen } from "./fees.mjs";

const deployed = JSON.parse(readFileSync(new URL("./.deployed.json", import.meta.url), "utf8"));
const address = argOf("address", deployed.address);
const networkName = argOf("network", deployed.network ?? "studiodev");
const APP = (argOf("app", "https://stakeyourword.vercel.app")).replace(/\/$/, "");
const count = Math.max(1, Math.min(6, Number(argOf("count", "3"))));

const GEN = 10n ** 18n;
const STAKE = GEN / 10n;
const PERIOD_MIN = 5;

/*
 * A different committer per commitment: one wallet may only create once every
 * 180 seconds, so reusing one would serialise this behind the contract's own
 * anti-abuse rule.
 */
const PLAN = [
  {
    role: "committer1",
    promise: "I will publish a new post on The Ship Log every week without fail",
    url: `${APP}/fixtures/kept`,
    archive: "",
  },
  {
    role: "committer2",
    promise: "I will ship the settlement path and write it up on the log this week",
    url: `${APP}/fixtures/broken`,
    archive: "",
  },
  {
    role: "committer3",
    promise: "The page at example.com will still describe itself as an illustrative example",
    url: "https://example.com/",
    archive: "https://web.archive.org/web/20250101004557id_/https://example.com/",
  },
  {
    role: "committer4",
    promise: "I will keep a weekly public note of what shipped, on the same page",
    url: `${APP}/fixtures/stale`,
    archive: "",
  },
  {
    role: "committer5",
    promise: "Every week there will be a dated entry on the log describing that week's work",
    url: `${APP}/fixtures/ambiguous`,
    archive: "",
  },
  {
    role: "committer6",
    promise: "I will publish release notes for every version I tag, on the log",
    url: `${APP}/fixtures/kept`,
    archive: "",
  },
].slice(0, count);

const reader = connect({ networkName, address, role: "client" });

/** The exact path the browser takes: the deployed app's same-origin relay. */
const chain = CHAINS[networkName];
const viaApp = createClient({
  chain: {
    ...chain,
    rpcUrls: { ...chain.rpcUrls, default: { ...chain.rpcUrls.default, http: [`${APP}/api/rpc`] } },
  },
});

console.log(`\ncontract  ${address}`);
console.log(`network   ${chain.name} (id ${chain.id})`);
console.log(`app       ${APP}\n`);

const made = [];

for (const item of PLAN) {
  const who = connect({ networkName, address, role: item.role });
  if (chain.isStudio) await fundOnStudio(chain, who.account.address, 20n * GEN);

  console.log("═".repeat(72));
  console.log(`\x1b[1m${item.role} — "${item.promise}"\x1b[0m`);
  console.log("═".repeat(72));

  const args = [
    item.promise, item.url, reader.account.address, PERIOD_MIN, STAKE.toString(), false,
    item.archive,
  ];

  /* 1. The preflight, as the UI runs it ─────────────────────────────────── */
  const chainSide = await reader.viewJson("preflight_create", [
    who.account.address, item.promise, item.url, reader.account.address, PERIOD_MIN,
    STAKE.toString(), false, STAKE.toString(), item.archive,
  ]);
  const quote = await who.quote("create_commitment", args, STAKE);

  console.log(`\n  PREFLIGHT (before anything is signed)`);
  console.log(`    contract would accept   ${chainSide.ok}${chainSide.reason ? ` — ${chainSide.reason}` : ""}`);
  console.log(`    proof source            ${chainSide.source_kind}`);
  console.log(`    checks reachability     ${chainSide.checks_reachability}  (that lives in consensus)`);
  console.log(`    stake                   ${gen(quote.userValue)}`);
  console.log(`    network fee             ${gen(quote.feeValue)}`);
  console.log(`    required total          ${gen(quote.required)}`);
  console.log(`    wallet holds            ${gen(quote.balance)}`);
  console.log(`    affordable              ${quote.ok}`);
  if (!quote.ok) {
    console.log(`    REFUSED LOCALLY: ${quote.reason}`);
    continue;
  }

  /* 2. Submit ───────────────────────────────────────────────────────────── */
  console.log(`\n  SUBMITTING create_commitment with ${gen(STAKE)}…`);
  const out = await who.send("create_commitment", args, STAKE);
  const body = returnedJson(out.returned);

  console.log(`    tx hash                 ${out.hash}`);
  console.log(`    receipt status          ${out.status}`);
  console.log(`    execution               ${out.named ?? "—"}`);
  console.log(`    contract returned       ${out.ok ? JSON.stringify(body) : out.revertReason || out.failure}`);

  if (!out.ok || body?.ok !== true) {
    console.log(`    NOT CREATED\n`);
    continue;
  }
  console.log(`    commitment id           #${body.id}`);
  console.log(`    content hash at create  ${body.content_hash}`);
  console.log(`    source class            ${body.source_kind}`);
  made.push({ ...item, id: body.id, hash: out.hash, committer: who.account.address });

  /* 3. Finalization ─────────────────────────────────────────────────────── */
  console.log(`\n  WAITING FOR FINALIZATION…`);
  let finalStatus = out.status;
  for (let i = 0; i < 25; i++) {
    const tx = await reader.read.getTransaction({ hash: out.hash }).catch(() => null);
    const name = tx?.status !== undefined ? tx.status : null;
    if (name === 7) {
      finalStatus = "FINALIZED";
      break;
    }
    await sleep(8000);
  }
  console.log(`    final status            ${finalStatus}`);

  /* 4. What the frontend reads back ─────────────────────────────────────── */
  const seen = JSON.parse(
    await viaApp.readContract({ address, functionName: "get_commitment", args: [body.id] }),
  );
  console.log(`\n  FRONTEND STATE (read through ${APP}/api/rpc)`);
  console.log(`    ${APP}/commitment/${body.id}`);
  console.log(`    status                  ${seen.status}`);
  console.log(`    staked                  ${gen(seen.total_staked)} over ${seen.periods_funded} period(s)`);
  console.log(`    next deadline           ${new Date(seen.next_deadline * 1000).toISOString()}`);
  console.log(`    source kind             ${seen.source_kind}`);
  console.log(`    created hash            ${seen.created_hash}`);
  console.log(`    fee rate on record      ${seen.bounty_bps}bps (snapshotted at creation)`);
  console.log("");
}

console.log("═".repeat(72));
console.log(`\x1b[1m${made.length} commitment(s) created\x1b[0m`);
for (const m of made) {
  console.log(`  #${m.id}  ${m.hash}  ${APP}/commitment/${m.id}`);
}
const stats = JSON.parse(await viaApp.readContract({ address, functionName: "get_stats", args: [] }));
console.log(`\ncontract now holds ${gen(stats.locked_stakes)} across ${stats.total} commitment(s)`);
console.log(`browse them at ${APP}/browse\n`);
