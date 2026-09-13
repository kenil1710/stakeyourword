/**
 * Drive a stuck Bradbury transaction to a terminal state, by hand.
 *
 * This is the command-line form of the control the frontend now exposes as
 * **Check status** and **Nudge it along** — the "user-controlled transaction
 * finalization/nudge recovery flow" the review asked for, on the network that
 * needs it.
 *
 * ## What "stuck" means here
 *
 * Bradbury's consensus parks a transaction in `COMMITTING` when a validator
 * round does not complete, and in `APPEAL_COMMITTING` when it goes to an appeal
 * round. Neither is a failure: the contract may already have executed
 * successfully — `txExecutionResultName` can read `FINISHED_WITH_RETURN` while
 * the transaction is still non-terminal — but the state is not applied and the
 * money has not moved until the round closes.
 *
 * `finalizeIdlenessTxs` is the poke that moves it on. It is itself a
 * transaction, which is exactly why this is a command you run rather than
 * something the app does silently: a second wallet prompt arriving in the
 * middle of a write the user already signed is indistinguishable from a bug.
 *
 * ## Why it pins genlayer-js 1.1.8
 *
 * Bradbury runs the v0.2 executor line and genlayer-js 2.x encodes calldata for
 * v0.3. See the header of `repro-fee-failure.mjs`.
 *
 * ## Two different targets
 *
 * `--until=terminal` (the default) stops at ACCEPTED: the round has closed, the
 * state is applied and the money has moved. `--until=finalized` keeps going to
 * FINALIZED, which is when it stops being reversible. They are different
 * questions and collapsing them is how a UI tells someone their payout has
 * landed while it is still in flight.
 *
 * Usage:
 *   node nudge.mjs --tx=0x… [--network=bradbury] [--role=empty] [--minutes=30]
 *   node nudge.mjs --tx=0x… --until=finalized
 */
import { createClient, createAccount } from "genlayer-js-v1";
import { testnetBradbury, studionet } from "genlayer-js-v1/chains";
import { transactionsStatusNumberToName } from "genlayer-js-v1/types";
import { readFileSync } from "node:fs";
import { argOf } from "./harness.mjs";

const CHAINS = { bradbury: testnetBradbury, studionet };
const networkName = argOf("network", "bradbury");
const chain = CHAINS[networkName];
if (!chain) throw new Error(`unknown --network=${networkName}`);

const hash = argOf("tx");
if (!hash) throw new Error("pass --tx=0x… — the transaction to drive");

const role = argOf("role", "empty");
const minutes = Number(argOf("minutes", "30"));
const until = argOf("until", "terminal");
if (until !== "terminal" && until !== "finalized") {
  throw new Error(`--until must be terminal or finalized, got: ${until}`);
}
const accounts = JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));

const read = createClient({ chain });
const wallet = createClient({ chain, account: createAccount(accounts[role].key) });

/** States that genuinely end a transaction. NOT the timeout states — Bradbury
 *  rotates past those and carries on, so stopping there abandons a transaction
 *  that is still alive. */
const TERMINAL = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"];
/** Waiting for finalization means ACCEPTED is no longer a stopping point. */
const DONE = until === "finalized" ? ["FINALIZED", "UNDETERMINED", "CANCELED"] : TERMINAL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\nnetwork  ${chain.name}`);
console.log(`tx       ${hash}`);
console.log(`nudging as ${role} (${wallet.account.address})`);
console.log(`waiting for ${until === "finalized" ? "FINALIZED" : "a terminal state"}\n`);

const started = Date.now();
const deadline = started + minutes * 60_000;
let nudges = 0;
let last = null;

for (;;) {
  const tx = await read.getTransaction({ hash }).catch(() => null);
  const status = transactionsStatusNumberToName[tx?.status] ?? null;
  const exec = tx?.txExecutionResultName ?? null;
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  if (status !== last) {
    console.log(`  ${secs.padStart(5)}s  ${status ?? "unknown"}${exec ? `  (${exec})` : ""}`);
    last = status;
  }

  if (status && DONE.includes(status)) {
    console.log(`\n  settled as ${status} after ${secs}s and ${nudges} nudge(s)`);
    if (status === "ACCEPTED") {
      console.log(`  state is applied and the money has moved; it is not irreversible yet.`);
      console.log(`  Run again with --until=finalized to wait that out.`);
    }
    break;
  }

  if (Date.now() > deadline) {
    console.log(`\n  still ${status} after ${secs}s and ${nudges} nudge(s) — giving up the watch.`);
    console.log(`  The transaction is not lost; rerun to keep nudging it.`);
    break;
  }

  nudges++;
  await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  await sleep(20_000);
}

const tx = await read.getTransaction({ hash }).catch(() => null);
console.log(`\n  final status     ${transactionsStatusNumberToName[tx?.status] ?? "unknown"}`);
console.log(`  execution        ${tx?.txExecutionResultName ?? "—"}\n`);
