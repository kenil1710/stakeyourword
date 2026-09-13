/**
 * The production write failure the review reported — reproduced on Bradbury,
 * refused by the preflight, and then carried through to a successful
 * `create_commitment` on a funded wallet.
 *
 * ## The diagnosis
 *
 *   "LackOfFundForMaxFee followed by an eth_sendRawTransaction JSON-RPC
 *    request-format parse error"
 *
 * Those are one failure, not two, and neither is a contract fault.
 *
 * A GenLayer write is an EVM transaction to the consensus contract. That
 * contract locks `feeValue + userValue` from the sender BEFORE the contract
 * runs, and reverts with `LackOfFundForMaxFee` when the sender cannot cover
 * both. Every Bradbury account this project held was at 0 GEN, so a create
 * carrying 0.1 GEN of stake was rejected before `create_commitment` ever
 * executed.
 *
 * The parse error is the second act. The SDK swallows the failed
 * `eth_estimateGas`, falls back to a default gas limit, and re-sends; the node
 * rejects that too, and THAT error surfaces in the console shaped like a
 * transport problem — burying the cause.
 *
 * ## Why this file pins genlayer-js 1.1.8
 *
 * Bradbury runs the **v0.2** executor line. genlayer-js 2.x encodes calldata
 * for **v0.3** and its method resolution fails there — a read that works under
 * 1.1.8 comes back from 2.0.0-rc.1 as `call to private method
 * __handle_undefined_method__`, which reads like a missing method on a contract
 * that has it. The SDK major has to match the executor line, so the rest of the
 * project (studio-dev, v0.3) uses 2.x and this one file uses 1.x.
 *
 * That version split is also why the preflight here is the DEGRADED one: 1.1.8
 * has no fee-estimation API at all, so the check falls back to "can this wallet
 * cover the stake at minimum". Weaker than a real quote, and it still catches
 * the balance of zero that caused the failure.
 *
 * Usage:
 *   node repro-fee-failure.mjs --network=bradbury
 *   node repro-fee-failure.mjs --network=bradbury --funded=empty --broke=outsider
 */
import { createClient, createAccount } from "genlayer-js-v1";
import { testnetBradbury, studionet } from "genlayer-js-v1/chains";
import { transactionsStatusNumberToName } from "genlayer-js-v1/types";
import { readFileSync } from "node:fs";
import { argOf } from "./harness.mjs";

const CHAINS = { bradbury: testnetBradbury, studionet };
const networkName = argOf("network", "bradbury");
const chain = CHAINS[networkName];
if (!chain) throw new Error(`unknown --network=${networkName}; expected bradbury or studionet`);

/**
 * The StakeYourWord deployment that was live on Bradbury when the review was
 * written. It is a v0.2-runner build of this contract — the current source
 * targets v0.3 and Bradbury cannot load it, which is why studio-dev is where
 * the rest of this project lives.
 */
const ADDRESS = argOf("address", "0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2");

const accounts = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
const brokeRole = argOf("broke", "outsider");
const fundedRole = argOf("funded", "empty");

const GEN = 10n ** 18n;
const STAKE = GEN / 10n;
const PERIOD_MIN = 5;
const PROOF_URL = argOf("url", "https://stakeyourword.vercel.app/fixtures/kept");

/** The v0.2 deployment takes six arguments; `archive_url` does not exist there. */
const argsFor = (beneficiary) => [
  "I will publish a new post on The Ship Log every week without fail",
  PROOF_URL,
  beneficiary,
  PERIOD_MIN,
  STAKE.toString(),
  false,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = (wei, places = 4) => {
  const v = BigInt(wei ?? 0n);
  const frac = (v % GEN).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${v / GEN}.${frac} GEN` : `${v / GEN} GEN`;
};

const read = createClient({ chain });
const clientFor = (role) => createClient({ chain, account: createAccount(accounts[role].key) });
const balanceOf = (address) => read.getBalance({ address }).then(BigInt).catch(() => 0n);

const results = [];
function check(label, passed, detail = "") {
  results.push({ label, passed });
  console.log(
    `${passed ? "\x1b[32m  PASS\x1b[0m" : "\x1b[31m  FAIL\x1b[0m"}  ${label}` +
      (detail ? `  \x1b[2m${detail}\x1b[0m` : ""),
  );
}

/**
 * The preflight, in the only form this network can support.
 *
 * genlayer-js 1.1.8 has no fee-estimation API, so there is no quote to compare
 * against. The stake alone is still a hard lower bound: the consensus contract
 * locks value plus fee, and the fee is never zero, so a wallet that cannot
 * cover the stake cannot cover the transaction whatever the fee turns out to
 * be. Strictly weaker than a real estimate and strictly better than nothing.
 */
async function preflight(address, userValue) {
  const balance = await balanceOf(address);
  const ok = balance > userValue;
  return {
    ok,
    balance,
    userValue,
    reason: ok
      ? ""
      : `You need more than ${gen(userValue)} to create this commitment — the stake itself, ` +
        `plus a network fee this network would not quote. This wallet holds ${gen(balance)}.`,
  };
}

console.log(`\nnetwork   ${chain.name} (id ${chain.id})`);
console.log(`contract  ${ADDRESS}`);
console.log(`proof     ${PROOF_URL}\n`);

/* ══ 1 · The failure, on a wallet that cannot pay ═════════════════════════ */

console.log("═".repeat(72));
console.log("\x1b[1m1 · BEFORE — submit without checking, on an empty wallet\x1b[0m");
console.log("═".repeat(72));

{
  const who = clientFor(brokeRole);
  const balance = await balanceOf(who.account.address);
  console.log(`  ${brokeRole}  ${who.account.address}  ${gen(balance)}`);

  if (balance > 0n) {
    console.log(`  (funded, so the failure cannot reproduce here — pass --broke=<empty role>)\n`);
  } else {
    /*
     * Every JSON-RPC call the SDK makes, recorded.
     *
     * The two symptoms do not both surface as thrown errors: the first is
     * swallowed by the SDK's gas-estimation fallback and only logged. Watching
     * the wire is the only way to show the SEQUENCE, and the sequence is the
     * point — the second error is caused by the first, and read on its own it
     * looks like a client bug.
     */
    const wire = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      let method = "";
      try {
        method = JSON.parse(String(init?.body ?? "{}"))?.method ?? "";
      } catch {
        method = "";
      }
      const res = await realFetch(input, init);
      try {
        const body = await res.clone().json();
        if (body?.error) wire.push({ method, error: String(body.error.message ?? "") });
      } catch {
        // not JSON — nothing to record
      }
      return res;
    };

    let threw = "";
    try {
      await who.writeContract({
        address: ADDRESS,
        functionName: "create_commitment",
        args: argsFor(accounts.beneficiary1.address),
        value: STAKE,
      });
      console.log("  submitted — this wallet could afford it after all");
    } catch (e) {
      threw = `${String(e?.message ?? e)} ${String(e?.details ?? e?.cause?.message ?? "")}`;
    }
    globalThis.fetch = realFetch;

    console.log("\n  RPC errors on the wire, in order:");
    for (const { method, error } of wire) {
      console.log(`    ${method.padEnd(24)} ${error.split("\n")[0].slice(0, 100)}`);
    }
    console.log("");

    const all = wire.map((w) => `${w.method} ${w.error}`).join("\n") + threw;
    check("LackOfFundForMaxFee on the gas estimate", /LackOfFundForMaxFee/i.test(all));
    check("a follow-on eth_sendRawTransaction failure",
      wire.some((w) => w.method === "eth_sendRawTransaction"));
    check("surfacing as an RPC parameter/format error",
      /Invalid parameters were provided|invalid request|request format|parse/i.test(threw));

    const stopped = await preflight(who.account.address, STAKE);
    check("the preflight refuses the same call before signing", !stopped.ok);
    check("and names what is missing", /You need more than/.test(stopped.reason));
    console.log(`\n  "${stopped.reason}"`);
  }
}

/* ══ 2 · The same call, on the funded wallet ══════════════════════════════ */

console.log(`\n${"═".repeat(72)}`);
console.log("\x1b[1m2 · AFTER — preflight, then submit, on a funded wallet\x1b[0m");
console.log("═".repeat(72));

const who = clientFor(fundedRole);
const before = await balanceOf(who.account.address);
console.log(`  ${fundedRole}  ${who.account.address}  ${gen(before)}\n`);

const quote = await preflight(who.account.address, STAKE);
console.log(`  PREFLIGHT`);
console.log(`    stake            ${gen(quote.userValue)}`);
console.log(`    wallet holds     ${gen(quote.balance)}`);
console.log(`    affordable       ${quote.ok}`);
check("the funded wallet passes the preflight", quote.ok, quote.reason);

if (!quote.ok) {
  console.log(`\n  ${quote.reason}\n  Fund it and rerun.\n`);
  process.exit(1);
}

console.log(`\n  SUBMITTING create_commitment with ${gen(STAKE)}…`);
let hash;
try {
  hash = await who.writeContract({
    address: ADDRESS,
    functionName: "create_commitment",
    args: argsFor(accounts.beneficiary1.address),
    value: STAKE,
  });
} catch (e) {
  check("the transaction was accepted for submission", false, String(e?.message ?? e).slice(0, 160));
  process.exit(1);
}
console.log(`    tx hash          ${hash}`);
check("a transaction hash came back immediately", Boolean(hash));

/*
 * Bradbury parks transactions in COMMITTING when a validator round does not
 * complete, and they stay there until somebody pokes them. That poke is
 * `finalizeIdlenessTxs` — the same control the frontend now exposes as a
 * button rather than doing silently behind a write the user already signed.
 */
const TERMINAL = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"];
const started = Date.now();
let nudges = 0;
let tx = null;
let status = null;

for (;;) {
  tx = await read.getTransaction({ hash }).catch(() => null);
  status = transactionsStatusNumberToName[tx?.status] ?? null;
  if (status && TERMINAL.includes(status)) break;
  if (Date.now() - started > (nudges + 1) * 45_000 && nudges < 12) {
    nudges++;
    console.log(`    nudge ${nudges} (status ${status ?? "unknown"})`);
    await who.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  }
  if (Date.now() - started > 900_000) break;
  await sleep(5000);
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`    receipt status   ${status} after ${secs}s, ${nudges} nudge(s)`);
console.log(`    execution        ${tx?.txExecutionResultName ?? "—"}`);
check("the transaction reached a terminal state", Boolean(status && TERMINAL.includes(status)),
  status ?? "never settled");
check("it was accepted, not undetermined", status === "ACCEPTED" || status === "FINALIZED", status ?? "");
check("execution finished with a return, not an error",
  tx?.txExecutionResultName === "FINISHED_WITH_RETURN", tx?.txExecutionResultName ?? "—");

/*
 * The commitment id.
 *
 * Bradbury carries no `consensus_data`, so the contract's return value is not
 * readable from the receipt — that is a property of the transport, not of the
 * contract, and the way to find the id is to read the chain's own state rather
 * than to treat an unreadable return as a failure.
 */
const stats = JSON.parse(await read.readContract({ address: ADDRESS, functionName: "get_stats", args: [] }));
const id = stats.total - 1;
console.log(`\n  COMMITMENT`);
console.log(`    contract now has ${stats.total} commitment(s); newest is #${id}`);

const view = JSON.parse(
  await read.readContract({ address: ADDRESS, functionName: "get_commitment", args: [id] }),
);
check("the commitment exists on chain", view.found === true);
check("it is ACTIVE", view.status === "ACTIVE", view.status);
check("the committer is the funded wallet",
  view.committer.toLowerCase() === who.account.address.toLowerCase(), view.committer);
check("the stake is locked", view.total_staked === STAKE.toString(), gen(view.total_staked));
check("a content hash was stored at creation", /^[0-9a-f]{16}$/.test(view.created_hash ?? ""),
  view.created_hash ?? "—");
console.log(`    id               #${view.id}`);
console.log(`    committer        ${view.committer}`);
console.log(`    staked           ${gen(view.total_staked)} over ${view.periods_funded} period(s)`);
console.log(`    content hash     ${view.created_hash}`);
console.log(`    next deadline    ${new Date(view.next_deadline * 1000).toISOString()}`);

/* ── Finalization ────────────────────────────────────────────────────────── */

console.log(`\n  FINALIZATION`);
if (status === "FINALIZED") {
  console.log(`    already FINALIZED`);
} else {
  console.log(`    ACCEPTED — waiting for finalization (nudging as needed)…`);
  const finalBy = Date.now() + 900_000;
  while (Date.now() < finalBy) {
    const now = await read.getTransaction({ hash }).catch(() => null);
    const name = transactionsStatusNumberToName[now?.status] ?? null;
    if (name === "FINALIZED") {
      status = "FINALIZED";
      break;
    }
    nudges++;
    await who.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
    await sleep(20_000);
  }
  console.log(`    final status     ${status}`);
}
check("the transaction finalized", status === "FINALIZED", status ?? "");

const after = await balanceOf(who.account.address);
console.log(`\n    wallet before    ${gen(before)}`);
console.log(`    wallet after     ${gen(after)}`);
console.log(`    net              -${gen(before - after)}  (stake + network fee)`);

/* ── Summary ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.passed);
console.log(`\n${"─".repeat(72)}`);
console.log(`\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m`);
for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.label}`);
console.log(`\n  create_commitment on ${chain.name}`);
console.log(`    tx    ${hash}`);
console.log(`    id    #${view.id}`);
console.log(`    state ${status}\n`);
process.exit(failed.length ? 1 : 0);
