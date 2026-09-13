/**
 * Fee estimation and the preflight balance check.
 *
 * WHY THIS FILE EXISTS — the production write failure the review reported.
 *
 * Chrome showed `LackOfFundForMaxFee` followed by an `eth_sendRawTransaction`
 * request-format parse error. Neither is a contract fault and neither is really
 * two faults:
 *
 *   1. A GenLayer write is an EVM transaction to the consensus contract that
 *      carries a `fees` envelope. The consensus contract locks
 *      `feeValue + userValue` up front and reverts with `LackOfFundForMaxFee`
 *      when the sender cannot cover BOTH. The old code sent writes with no fee
 *      estimate at all and let the SDK fall back to a default envelope, so the
 *      required amount was never compared against the wallet balance — and on a
 *      wallet holding 0 GEN (which is what every Bradbury account here held) the
 *      revert was guaranteed before the contract ever ran.
 *
 *   2. The parse error is the SECOND act of the same failure, not an
 *      independent bug. Once the first submission reverts, the retry re-signs
 *      and re-sends; the node answers the malformed/duplicate envelope with a
 *      JSON-RPC request-format error, which is what surfaced in the console and
 *      buried the real cause.
 *
 * The fix is to make the required amount KNOWN BEFORE ANYTHING IS SIGNED:
 * estimate the fee for this exact call, add the value riding with it, compare
 * against the balance, and refuse locally with a sentence that names the
 * shortfall. A wallet dialog the user cannot afford to confirm should never
 * open.
 *
 * `estimateTransactionFeesForWrite` is the estimate that counts. A write that
 * emits an outbound transfer — every settlement path in this contract does —
 * needs message-fee allocations in the envelope, and a bare
 * `estimateTransactionFees()` does not carry them: the transaction then fails
 * with `fee no_matching_allocation # external` AFTER the money has moved into
 * the contract. The per-write estimate simulates the call and derives them.
 */

import { CALL_KEY_UNNAMED, MessageType, encodeExternalMessageFeeParams } from "genlayer-js";

const GEN = 10n ** 18n;

/**
 * One outbound transfer's worth of allocation, when the envelope has to be built
 * by hand. These mirror what the simulator derives for a plain value transfer:
 * a 500k gas limit and the receipt gas price with the SDK's own 20% cap
 * headroom.
 *
 * The budget is NOT a free parameter. The consensus contract requires it to be
 * exactly `gasLimit * maxGasPrice` and answers `ExternalAllocationInvalid` for
 * anything else — including anything larger, so "be generous" is not available
 * here. Unspent allocation is refunded either way.
 */
const MESSAGE_GAS_LIMIT = 500_000n;
const CAP_HEADROOM_BPS = 12_000n; // 1.2x, the SDK's default price cap headroom

/**
 * Allocations for the recipients a call might pay.
 *
 * `feeParams` is NOT optional for an external message: an allocation with an
 * empty one is rejected by the consensus contract as `InvalidFeeParams`, and
 * the rejection happens at submission with no hint that the envelope is the
 * problem. The call key is the unnamed one, which is what the simulator emits
 * for a plain value transfer.
 */
async function allocationsFor(client, publicClient, payees) {
  if (!payees?.length) return [];
  let gasPrice = 300_000_000n;
  try {
    const policy = await client.getCurrentFeePolicy();
    gasPrice = (BigInt(policy.receiptGasPrice ?? 250_000_000n) * CAP_HEADROOM_BPS) / 10_000n;
  } catch {
    // Keep the default; it is the observed policy value with headroom.
  }
  const feeParams = encodeExternalMessageFeeParams({
    gasLimit: MESSAGE_GAS_LIMIT,
    maxGasPrice: gasPrice,
  });
  return payees.map((recipient) => ({
    messageType: MessageType.External,
    onAcceptance: false,
    recipient: String(recipient).toLowerCase(),
    callKey: CALL_KEY_UNNAMED,
    budget: MESSAGE_GAS_LIMIT * gasPrice,
    feeParams,
  }));
}

/**
 * The contract's own revert message, decoded out of a FAILED fee estimate.
 *
 * The per-write estimate simulates the call, so a call that would revert fails
 * here rather than on chain — which is strictly better (no fee is spent) but
 * only if the reason survives. Without this, "Period 1 is not due yet; 112s to
 * go" reaches the user as "the fee estimate failed", which is true, useless, and
 * looks like an infrastructure problem rather than the contract telling them
 * something they need to know.
 *
 * The reason rides in the simulation receipt as base64 with a one-byte status
 * tag in front of the text.
 */
export function revertReasonFromEstimate(error) {
  const raw = error?.cause?.data?.receipt?.result ?? error?.data?.receipt?.result;
  if (typeof raw !== "string" || !raw) return "";
  try {
    const text = Buffer.from(raw, "base64").toString("utf8").replace(/^[\x00-\x1f]+/, "");
    // A revert reason is prose. Anything else is a transport artefact.
    return /[a-z]{3}/i.test(text) ? text : "";
  } catch {
    return "";
  }
}

/** Wei as a short decimal GEN string, for messages humans read. */
export function gen(wei, places = 4) {
  const value = BigInt(wei ?? 0n);
  const whole = value / GEN;
  const frac = (value % GEN).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac} GEN` : `${whole} GEN`;
}

/**
 * What one write will cost, and whether `from` can pay for it.
 *
 * Never throws on an unaffordable call — returns `{ ok: false, ... }` with the
 * numbers, so the caller decides whether to explain or abort. Throws only when
 * the estimate itself cannot be produced, which is a different problem.
 */
export async function quoteWrite(client, publicClient, { address, functionName, args = [], value = 0n, account, payees }) {
  const from = account?.address ?? client.account?.address;
  const userValue = BigInt(value ?? 0n);
  const balance = await publicClient.getBalance({ address: from }).then(BigInt).catch(() => 0n);

  let fees = null;
  let degraded = "";
  let wouldRevert = "";
  try {
    fees = await client.estimateTransactionFeesForWrite({
      address,
      functionName,
      args,
      value: userValue,
      account,
    });
  } catch (e) {
    /*
     * THE SIMULATION IS ADVISORY, NOT AUTHORITATIVE.
     *
     * `estimateTransactionFeesForWrite` simulates the call, and on Studio Devnet
     * that simulation runs with a stale clock — measured at roughly 656 days
     * behind the clock a real transaction sees. So every time-gated branch in
     * this contract answers the wrong question under simulation: a period that
     * IS due simulates as "not due yet", and one past its grace window
     * simulates as still inside it.
     *
     * Treating a simulated revert as a refusal would therefore block the
     * settlement path entirely — a false negative on the core flow. So a
     * simulated revert is REPORTED (`wouldRevert`) and never used to refuse;
     * only the balance check refuses, because balances are not time-gated.
     *
     * What is lost with the simulation is the message-fee allocations, and a
     * call that emits a payout fails with `fee no_matching_allocation` without
     * them. `payees` supplies them: the caller knows who this method can pay
     * (committer, beneficiary, itself) from the commitment record, and an
     * allocation with the wildcard call key covers whichever of them the
     * contract actually pays.
     */
    wouldRevert = revertReasonFromEstimate(e);
    degraded = wouldRevert ? "" : String(e?.message ?? e);
    try {
      fees = await client.estimateTransactionFees({
        messageAllocations: await allocationsFor(client, publicClient, payees),
      });
      degraded = "";
    } catch {
      // Even the policy read failed — Bradbury's older consensus contract
      // reverts in `quoteGasPrice`. Fall through to the stake-only bound below,
      // which is weaker and still catches the balance of zero that broke this.
      fees = null;
      if (!degraded) degraded = "the fee policy could not be read";
    }
  }

  const feeValue = fees ? BigInt(fees.feeValue ?? 0n) : 0n;
  const required = feeValue + userValue;
  // A degraded quote must not report "affordable" on a balance that only just
  // covers the stake: the fee still has to come from somewhere.
  const enough = degraded ? balance > userValue : balance >= required;
  const shortfall = enough ? 0n : required - balance > 0n ? required - balance : 1n;

  return {
    ok: enough,
    fees: fees ?? undefined,
    from,
    feeValue,
    userValue,
    required,
    balance,
    shortfall,
    /** Set when the fee could not be estimated and the check fell back. */
    degraded,
    // What the SIMULATION said the contract would answer. Advisory only — the
    // simulated clock is not the chain's, so this never refuses on its own.
    wouldRevert,
    // The sentence the UI and the CLI both show. It names the shortfall,
    // because "insufficient funds" without a number is not actionable.
    reason: enough
      ? ""
      : degraded
        ? `You need more than ${gen(userValue)} to ${describe(functionName)} — the stake itself, ` +
          `plus a network fee this network would not quote. This wallet holds ${gen(balance)}.`
        : `You need ${gen(required)} to ${describe(functionName)} — ` +
          (userValue > 0n ? `${gen(userValue)} of stake plus ` : "") +
          `${gen(feeValue)} of network fees. This wallet holds ${gen(balance)}, ` +
          `so it is short by ${gen(shortfall)}.`,
  };
}

function describe(functionName) {
  return (
    {
      create_commitment: "create this commitment",
      add_stake: "add this stake",
      verify_commitment: "verify this period",
      settle_lapsed: "close this period",
      settle_stalled: "close this stalled period",
      cancel_commitment: "cancel this commitment",
    }[functionName] ?? `call ${functionName}`
  );
}

/** The same quote for a deploy, where there is no method name to simulate. */
export async function quoteDeploy(client, publicClient, { account } = {}) {
  const from = account?.address ?? client.account?.address;
  const fees = await client.estimateTransactionFees({});
  const feeValue = BigInt(fees.feeValue ?? 0n);
  const balance = await publicClient.getBalance({ address: from }).then(BigInt).catch(() => 0n);
  const shortfall = feeValue > balance ? feeValue - balance : 0n;
  return {
    ok: shortfall === 0n,
    fees,
    from,
    feeValue,
    userValue: 0n,
    required: feeValue,
    balance,
    shortfall,
    degraded: "",
    wouldRevert: "",
    reason:
      shortfall === 0n
        ? ""
        : `Deploying needs ${gen(feeValue)} of network fees. This wallet holds ${gen(balance)}, ` +
          `so it is short by ${gen(shortfall)}.`,
  };
}
