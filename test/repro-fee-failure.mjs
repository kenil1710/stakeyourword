/**
 * Reproduces the production write failure the review reported, then shows the
 * fix refusing it first.
 *
 *   "LackOfFundForMaxFee followed by an eth_sendRawTransaction JSON-RPC
 *    request-format parse error"
 *
 * ## The diagnosis
 *
 * Those are one failure, not two, and neither is a contract fault.
 *
 * A GenLayer write is an EVM transaction to the consensus contract carrying a
 * `fees` envelope. The consensus contract locks `feeValue + userValue` from the
 * sender BEFORE the contract runs, and reverts with `LackOfFundForMaxFee` when
 * the sender cannot cover both. Every Bradbury account this project holds has a
 * zero balance — Bradbury has no faucet call, only a Cloudflare-gated web
 * faucet — so a create carrying 0.1 GEN of stake was rejected before
 * `create_commitment` ever executed.
 *
 * The parse error is the second act. Once the first submission reverts, the
 * SDK's retry re-signs and re-sends; the node answers the re-sent envelope with
 * a JSON-RPC request-format error, and THAT is what surfaced in the Chrome
 * console — burying the real cause under a transport error that looks like a
 * client bug.
 *
 * ## The fix
 *
 * Quote the write, add the value riding with it, compare against the balance,
 * and refuse locally with the shortfall named. A wallet dialog the user cannot
 * afford to confirm should never open. `fees.mjs` is that check; this script
 * runs the same call both ways against the same network so the difference is
 * visible rather than claimed.
 *
 * Usage: node repro-fee-failure.mjs [--network=bradbury]
 *
 * Nothing here needs a funded account — that is the point.
 */
import { createClient, createAccount } from "genlayer-js";
import { CHAINS, accounts, argOf } from "./harness.mjs";
import { quoteWrite, gen } from "./fees.mjs";

const networkName = argOf("network", "bradbury");
const chain = CHAINS[networkName];
if (!chain) throw new Error(`unknown --network=${networkName}`);

// The StakeYourWord deployment that was live on Bradbury when the review was
// written. The address matters only as a valid recipient: the transaction is
// rejected by the consensus contract before it reaches any contract code.
const ADDRESS = argOf("address", "0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2");

const role = argOf("role", "empty");
const key = accounts()[role]?.key;
if (!key) throw new Error(`no key for role ${role} — run: node accounts.mjs`);

const account = createAccount(key);
const wallet = createClient({ chain, account });
const read = createClient({ chain });

const GEN = 10n ** 18n;
const STAKE = GEN / 10n;
const CALL = {
  functionName: "create_commitment",
  args: [
    "I will publish a new post on The Ship Log every week without fail",
    "https://stakeyourword.vercel.app/fixtures/kept",
    "0x1ec3D2A3cb0C71906de4D4BfDE804273EF0ea261",
    5,
    STAKE.toString(),
    false,
  ],
  value: STAKE,
};

const balance = await read.getBalance({ address: account.address }).catch(() => 0n);

console.log(`\nnetwork  ${chain.name} (id ${chain.id})`);
console.log(`wallet   ${account.address}`);
console.log(`balance  ${gen(balance)}`);
console.log(`calling  create_commitment with ${gen(STAKE)} of stake\n`);

if (balance > 0n) {
  console.log(
    "NOTE: this wallet is funded, so the failure below will not reproduce.\n" +
      "      Use --role=empty, which accounts.mjs never funds.\n",
  );
}

/* ── 1. The old path: submit with no estimate and no balance check ──────── */

/*
 * Every JSON-RPC call the SDK makes, recorded.
 *
 * The two symptoms the review reported do not both surface as thrown errors:
 * the first is swallowed by the SDK's gas-estimation fallback and only logged.
 * Watching the wire is the only way to show the SEQUENCE, which is the whole
 * point — the second error is caused by the first, and read on its own it looks
 * like a client bug.
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
  const clone = res.clone();
  try {
    const body = await clone.json();
    if (body?.error) wire.push({ method, error: String(body.error.message ?? "") });
  } catch {
    // not JSON — nothing to record
  }
  return res;
};

console.log("─".repeat(68));
console.log("BEFORE — submit without quoting the fee (what production did)");
console.log("─".repeat(68));

let threw = "";
try {
  const hash = await wallet.writeContract({ address: ADDRESS, ...CALL });
  console.log(`  submitted ${hash}`);
  console.log("  (no revert — this wallet could afford it after all)");
} catch (e) {
  threw = `${String(e?.message ?? e)} ${String(e?.details ?? e?.cause?.message ?? "")}`;
}

console.log("\n  RPC errors seen on the wire, in order:");
for (const { method, error } of wire) {
  console.log(`    ${method.padEnd(24)} ${error.split("\n")[0].slice(0, 110)}`);
}

const all = wire.map((w) => `${w.method} ${w.error}`).join("\n") + threw;
const lack = /LackOfFundForMaxFee/i.test(all);
const send = wire.some((w) => w.method === "eth_sendRawTransaction");
const format = /Invalid parameters were provided|invalid request|request format|parse/i.test(threw);

console.log("");
console.log(`  1. LackOfFundForMaxFee on the gas estimate      ${lack ? "YES" : "no"}`);
console.log(`  2. a follow-on eth_sendRawTransaction failure   ${send ? "YES" : "no"}`);
console.log(`  3. surfacing as an RPC parameter/format error   ${format ? "YES" : "no"}`);
if (lack && send) {
  console.log(
    "\n  That is the reported failure, end to end: the consensus contract\n" +
      "  locks fee + stake before the contract runs and this wallet holds\n" +
      "  neither, the SDK swallows the estimate error and falls back to a\n" +
      "  default gas limit, and the resubmission fails again — this time as a\n" +
      "  transport-shaped error that hides the cause.",
  );
}

globalThis.fetch = realFetch;

/* ── 2. The fix: quote first, refuse locally, never open the wallet ─────── */

console.log(`\n${"─".repeat(68)}`);
console.log("AFTER — quote the fee and check the balance before signing");
console.log("─".repeat(68));

try {
  const quote = await quoteWrite(wallet, read, { address: ADDRESS, ...CALL, account });
  console.log(`  fee estimate     ${gen(quote.feeValue)}`);
  console.log(`  stake            ${gen(quote.userValue)}`);
  console.log(`  required total   ${gen(quote.required)}`);
  console.log(`  wallet holds     ${gen(quote.balance)}`);
  console.log(`  shortfall        ${gen(quote.shortfall)}`);
  console.log(`  affordable       ${quote.ok}`);
  if (!quote.ok) {
    console.log(`\n  REFUSED LOCALLY. Nothing signed, nothing spent.`);
    console.log(`  "${quote.reason}"`);
  }
} catch (e) {
  // On Bradbury the estimate itself can fail for an account with no history.
  // That is still a refusal BEFORE signing, and it is still not a revert.
  console.log(`  the estimate could not be produced: ${String(e?.message ?? e).split("\n")[0]}`);
  console.log(
    `\n  REFUSED BEFORE SIGNING ANYWAY. The wallet dialog never opens on a\n` +
      `  transaction whose cost is unknown, which is the same guarantee.`,
  );
}

console.log("");
