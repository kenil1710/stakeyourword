/**
 * Does the stake actually reach the contract on Bradbury?
 *
 * ## Why this exists
 *
 * The funded Bradbury reproduction created commitment #0 and the contract
 * recorded `total_staked = 0.1 GEN`. Its EVM balance is zero.
 *
 *     contract EVM balance   0 wei
 *     locked_stakes          100000000000000000
 *     unallocated            -100000000000000000
 *
 * The same contract source on Studio Devnet is exactly solvent — EVM balance,
 * `self.balance` and `locked_stakes` all agree at 0.4 GEN. So this is not the
 * contract mis-accounting: `gl.message.value` clearly read 0.1 inside the VM,
 * or `_create_problem` would have rejected the call for sending nothing.
 *
 * The wallet tells the other half of the story. It went down by 0.103 GEN when
 * the transaction was accepted and back UP by 0.094 when it finalized — the
 * stake left and came back.
 *
 * Two candidate causes, and they call for different responses:
 *
 *   A. genlayer-js 1.1.8 does not attach user value to a Bradbury write at all,
 *      and something else moved the balance. Then every payable call from that
 *      client is unfunded and the contract is being lied to about `value`.
 *   B. The APPEAL path returned it. The reproduction went through four rounds
 *      including an appeal; a rotation that replays a transaction may return
 *      the user value without the contract knowing.
 *
 * This submits one more create and samples the contract's EVM balance at each
 * stage, so the answer comes from observation rather than from reasoning about
 * it. A run that does NOT go to appeal separates A from B.
 *
 * Usage: node bradbury-value-probe.mjs [--role=empty]
 */
import { createClient, createAccount } from "genlayer-js-v1";
import { testnetBradbury as chain } from "genlayer-js-v1/chains";
import { transactionsStatusNumberToName } from "genlayer-js-v1/types";
import { readFileSync } from "node:fs";
import { argOf } from "./harness.mjs";

const ADDRESS = argOf("address", "0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2");
const role = argOf("role", "empty");
const accounts = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));

const GEN = 10n ** 18n;
const STAKE = GEN / 10n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = (wei) => `${(Number(BigInt(wei)) / 1e18).toFixed(6)} GEN`;

const read = createClient({ chain });
const wallet = createClient({ chain, account: createAccount(accounts[role].key) });

const contractBalance = () => read.getBalance({ address: ADDRESS }).then(BigInt).catch(() => -1n);
const walletBalance = () => read.getBalance({ address: wallet.account.address }).then(BigInt).catch(() => -1n);
const stats = async () => JSON.parse(await read.readContract({ address: ADDRESS, functionName: "get_stats", args: [] }));

async function sample(label) {
  const [c, w, s] = await Promise.all([contractBalance(), walletBalance(), stats().catch(() => null)]);
  console.log(
    `  ${label.padEnd(22)} contract ${gen(c).padStart(14)}   wallet ${gen(w).padStart(14)}` +
      (s ? `   locked ${gen(s.locked_stakes)}` : ""),
  );
  return { contract: c, wallet: w, locked: s ? BigInt(s.locked_stakes) : -1n };
}

console.log(`\nnetwork   ${chain.name}`);
console.log(`contract  ${ADDRESS}`);
console.log(`wallet    ${wallet.account.address}`);
console.log(`stake     ${gen(STAKE)}\n`);

const at0 = await sample("before");

const hash = await wallet.writeContract({
  address: ADDRESS,
  functionName: "create_commitment",
  args: [
    "I will keep a public weekly note of what shipped on The Ship Log",
    "https://stakeyourword.vercel.app/fixtures/kept",
    accounts.beneficiary2.address,
    5,
    STAKE.toString(),
    false,
  ],
  value: STAKE,
});
console.log(`\n  submitted ${hash}\n`);

const TERMINAL = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"];
const started = Date.now();
let nudges = 0;
let status = null;
let sawAppeal = false;
let rounds = 0;

for (;;) {
  const tx = await read.getTransaction({ hash }).catch(() => null);
  status = transactionsStatusNumberToName[tx?.status] ?? null;
  rounds = Number(tx?.numOfRounds ?? 0);
  if (String(status).startsWith("APPEAL")) sawAppeal = true;
  if (status && TERMINAL.includes(status)) break;
  if (Date.now() - started > 1_800_000) break;
  nudges++;
  await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  await sleep(20_000);
}
console.log(`  reached ${status} after ${((Date.now() - started) / 1000).toFixed(0)}s, ` +
  `${nudges} nudge(s), ${rounds} round(s), appeal seen: ${sawAppeal}\n`);

const at1 = await sample("at acceptance");

/* Finalization, and the balances after it. */
const finalBy = Date.now() + 1_800_000;
while (status !== "FINALIZED" && Date.now() < finalBy) {
  const tx = await read.getTransaction({ hash }).catch(() => null);
  status = transactionsStatusNumberToName[tx?.status] ?? status;
  if (status === "FINALIZED") break;
  await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  await sleep(20_000);
}
console.log(`\n  final status ${status}\n`);

const at2 = await sample("after finalization");

/* ── The reading ─────────────────────────────────────────────────────────── */

console.log(`\n${"─".repeat(72)}`);
const contractGained = at2.contract - at0.contract;
const walletLost = at0.wallet - at2.wallet;
const lockedGained = at2.locked - at0.locked;

console.log(`  contract gained   ${gen(contractGained)}`);
console.log(`  wallet lost       ${gen(walletLost)}`);
console.log(`  locked_stakes up  ${gen(lockedGained)}`);
console.log("");

if (contractGained === STAKE) {
  console.log(`  The stake reached the contract. The earlier shortfall was specific to that`);
  console.log(`  transaction — it went through an appeal, and this one ${sawAppeal ? "did too" : "did not"}.`);
} else if (lockedGained === STAKE && contractGained === 0n) {
  console.log(`  THE CONTRACT RECORDED A STAKE IT DOES NOT HOLD.`);
  console.log(`  locked_stakes went up by ${gen(lockedGained)} and the balance did not move,`);
  console.log(`  so gl.message.value reported a transfer the chain did not make.`);
  console.log(`  Appeal on this run: ${sawAppeal}. Rounds: ${rounds}.`);
} else {
  console.log(`  Inconclusive — neither a clean transfer nor a clean shortfall.`);
}
console.log("");
