/**
 * Fee estimation and the preflight balance check.
 *
 * WHY THIS FILE EXISTS — the production write failure the review reported.
 *
 * Chrome showed `LackOfFundForMaxFee`, then an `eth_sendRawTransaction`
 * request-format parse error. Those are one failure, not two:
 *
 *   1. A GenLayer write is an EVM transaction to the consensus contract
 *      carrying a `fees` envelope. The consensus contract locks
 *      `feeValue + userValue` up front and reverts with `LackOfFundForMaxFee`
 *      when the sender cannot cover BOTH. This app used to submit writes with
 *      no fee estimate at all, so the required amount was never compared
 *      against the wallet balance before the wallet dialog opened.
 *
 *   2. The parse error is the second act of the same failure. Once the first
 *      submission reverts, the retry re-signs and re-sends; the node answers
 *      the duplicate envelope with a JSON-RPC request-format error, which is
 *      what reached the console and buried the real cause.
 *
 * So the required amount is made KNOWN BEFORE ANYTHING IS SIGNED: estimate the
 * fee for this exact call, add the value riding with it, compare against the
 * balance, and refuse locally with a sentence that names the shortfall. A
 * wallet dialog the user cannot afford to confirm should never open.
 *
 * `estimateTransactionFeesForWrite` is the estimate that counts. A write that
 * emits an outbound transfer — every settlement path in this contract does —
 * needs message-fee allocations in the envelope, and a bare
 * `estimateTransactionFees()` does not carry them: the transaction then fails
 * with `fee no_matching_allocation # external` AFTER the stake has already
 * moved into the contract. The per-write estimate simulates the call and
 * derives them.
 */
import { CALL_KEY_UNNAMED, MessageType, encodeExternalMessageFeeParams } from "genlayer-js";
import type { CalldataEncodable } from "genlayer-js/types";
import { CONTRACT_ADDRESS, getReadClient, getWalletClient, IS_GASLESS } from "./genlayer";
import { gen } from "./format";

export interface WriteCall {
  functionName: string;
  args: CalldataEncodable[];
  value?: bigint;
  /**
   * Every address this call might pay.
   *
   * Needed only when the fee envelope has to be built without the simulation —
   * see `quoteWrite`. All of them are knowable from the commitment record
   * before the call is made.
   */
  payees?: string[];
}

/**
 * One outbound transfer's worth of allocation, mirroring what the simulator
 * derives for a plain value transfer: a 500k gas limit and the receipt gas
 * price with the SDK's own 20% cap headroom.
 *
 * The budget is NOT a free parameter. The consensus contract requires it to be
 * exactly `gasLimit * maxGasPrice` and answers `ExternalAllocationInvalid` for
 * anything else — including anything larger, so "be generous" is not available.
 * `feeParams` is not optional either: an empty one is rejected as
 * `InvalidFeeParams`, at submission, with no hint that the envelope is why.
 */
const MESSAGE_GAS_LIMIT = 500_000n;
const CAP_HEADROOM_BPS = 12_000n;

async function allocationsFor(payees: string[] | undefined, wallet: ReturnType<typeof getWalletClient>) {
  if (!payees?.length) return [];
  let gasPrice = 300_000_000n;
  try {
    const policy = await wallet.getCurrentFeePolicy();
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
    recipient: String(recipient).toLowerCase() as `0x${string}`,
    callKey: CALL_KEY_UNNAMED,
    budget: MESSAGE_GAS_LIMIT * gasPrice,
    feeParams,
  }));
}

export interface Quote {
  /** Whether this wallet can afford the call. Never throws on `false`. */
  ok: boolean;
  /** The fee envelope to hand to `writeContract`. Opaque; pass it through. */
  fees: unknown;
  feeValue: bigint;
  /** The stake or payment riding with the call. */
  userValue: bigint;
  /** What must be in the wallet: `userValue + feeValue`. */
  required: bigint;
  balance: bigint;
  shortfall: bigint;
  /**
   * Set when the network would not quote a fee and the check fell back to
   * "can this wallet at least cover the stake". Weaker, and says so.
   */
  degraded: string;
  /**
   * What the SIMULATION said the contract would answer.
   *
   * ADVISORY ONLY. The simulated clock is hundreds of days behind the chain's,
   * so this never refuses a write on its own — it is shown as a warning and the
   * real transaction is left to be the authority.
   */
  wouldRevert: string;
  /** The sentence to show. Empty when `ok`. */
  reason: string;
}

/** What the user is trying to do, for the shortfall sentence. */
const VERB: Record<string, string> = {
  create_commitment: "create this commitment",
  add_stake: "add this stake",
  verify_commitment: "verify this period",
  settle_lapsed: "close this period",
  settle_stalled: "close this stalled period",
  cancel_commitment: "cancel this commitment",
};

/**
 * What one write will cost, and whether `account` can pay for it.
 *
 * Returns `{ ok: false }` with the numbers rather than throwing, so the caller
 * decides whether to explain or abort. When the network will not quote a fee at
 * all it degrades to a stake-only lower bound rather than throwing — see below.
 */
export async function quoteWrite(account: `0x${string}`, call: WriteCall): Promise<Quote> {
  const wallet = getWalletClient(account);
  const read = getReadClient();
  const userValue = call.value ?? 0n;
  const balance = await read
    .getBalance({ address: account })
    .then(BigInt)
    .catch(() => 0n);

  let fees: unknown = undefined;
  let degraded = "";
  let wouldRevert = "";
  try {
    fees = await wallet.estimateTransactionFeesForWrite({
      address: CONTRACT_ADDRESS,
      functionName: call.functionName,
      args: call.args,
      value: userValue,
    });
  } catch (e) {
    /*
     * THE SIMULATION IS ADVISORY, NOT AUTHORITATIVE.
     *
     * `estimateTransactionFeesForWrite` simulates the call, and on Studio Devnet
     * that simulation runs with a stale clock — measured at roughly 656 days
     * behind the clock a real transaction sees. Every time-gated branch in this
     * contract therefore answers the wrong question under simulation: a period
     * that IS due simulates as "not due yet", one past its grace window
     * simulates as still inside it.
     *
     * Treating a simulated revert as a refusal would block the settlement path
     * entirely — a false negative on the core flow. So a simulated revert is
     * REPORTED (`wouldRevert`) and never used to refuse. Only the balance check
     * refuses, because balances are not time-gated.
     *
     * What is lost with the simulation is the message-fee allocations, and a
     * call that emits a payout fails with `fee no_matching_allocation` without
     * them. `call.payees` supplies them from the commitment record instead.
     */
    wouldRevert = revertReasonFromEstimate(e);
    degraded = wouldRevert ? "" : String((e as { message?: string })?.message ?? e ?? "unavailable");
    try {
      fees = await wallet.estimateTransactionFees({
        messageAllocations: await allocationsFor(call.payees, wallet),
      });
      degraded = "";
    } catch {
      /*
       * Even the policy read failed — Bradbury runs an older consensus contract
       * and reverts in `quoteGasPrice`. Fall through to the stake-only bound
       * below: weaker, and it still catches the balance of zero that broke this.
       */
      fees = undefined;
      if (!degraded) degraded = "the fee policy could not be read";
    }
  }

  const feeValue = BigInt((fees as { feeValue?: bigint } | undefined)?.feeValue ?? 0n);
  const required = feeValue + userValue;
  // A degraded quote must not report "affordable" on a balance that only just
  // covers the stake: the fee still has to come from somewhere.
  const enough = degraded ? balance > userValue : balance >= required;
  const shortfall = enough ? 0n : required > balance ? required - balance : 1n;

  return {
    ok: enough,
    fees,
    feeValue,
    userValue,
    required,
    balance,
    shortfall,
    degraded,
    wouldRevert,
    reason: enough
      ? ""
      : degraded
        ? `You need more than ${gen(userValue)} to ${VERB[call.functionName] ?? call.functionName} — ` +
          `the stake itself, plus a network fee this network would not quote. ` +
          `This wallet holds ${gen(balance)}.`
        : shortfallSentence(call, required, userValue, feeValue, balance, shortfall),
  };
}

function shortfallSentence(
  call: WriteCall,
  required: bigint,
  userValue: bigint,
  feeValue: bigint,
  balance: bigint,
  shortfall: bigint,
): string {
  const verb = VERB[call.functionName] ?? `call ${call.functionName}`;
  const breakdown =
    userValue > 0n
      ? `${gen(userValue)} of stake plus ${gen(feeValue)} of network fees`
      : `${gen(feeValue)} of network fees`;
  return (
    `You need ${gen(required)} to ${verb} — ${breakdown}. ` +
    `This wallet holds ${gen(balance)}, so it is short by ${gen(shortfall)}.`
  );
}

/**
 * The contract's own revert message, decoded out of a FAILED fee estimate.
 *
 * The per-write estimate simulates the call, so a call that would revert fails
 * there rather than on chain — which costs no fee, but only helps if the reason
 * survives. Without this, "Period 1 is not due yet" reaches the user as "the fee
 * estimate failed": true, useless, and shaped like an infrastructure problem
 * rather than the contract telling them something they need to know.
 *
 * The reason rides in the simulation receipt as base64 with a one-byte status
 * tag in front of the text.
 */
export function revertReasonFromEstimate(error: unknown): string {
  const shaped = error as {
    cause?: { data?: { receipt?: { result?: unknown } } };
    data?: { receipt?: { result?: unknown } };
  };
  const raw = shaped?.cause?.data?.receipt?.result ?? shaped?.data?.receipt?.result;
  if (typeof raw !== "string" || !raw) return "";
  try {
    const text = atob(raw).replace(/^[\x00-\x1f]+/, "");
    // A revert reason is prose. Anything else is a transport artefact.
    return /[a-z]{3}/i.test(text) ? text : "";
  } catch {
    return "";
  }
}

/**
 * A human explanation for a chain-level failure.
 *
 * The raw strings are accurate and useless: `LackOfFundForMaxFee` names the
 * mechanism, not the thing the person has to go do about it. Anything not
 * recognised is passed through rather than smoothed into a vague apology — an
 * unfamiliar error is still evidence.
 */
export function explainChainError(raw: unknown): string {
  const text = String((raw as { message?: string })?.message ?? raw ?? "");
  if (!text) return "";

  if (/LackOfFundForMaxFee/i.test(text)) {
    return (
      "The network locks the fee plus your stake before the contract runs, and this wallet " +
      "cannot cover both. Top it up and try again." +
      (IS_GASLESS ? "" : " The exact amount is in the estimate above.")
    );
  }
  if (/FeeValueMustBeNonZero/i.test(text)) {
    return (
      "The transaction went out with no fee attached. This network prices every write, so a " +
      "fee estimate has to ride with it. Reload the page and try again."
    );
  }
  if (/no_matching_allocation/i.test(text)) {
    return (
      "The contract tried to send a payout the fee envelope had no allowance for. That is a " +
      "fee-estimation failure, not a rejection — retry and a fresh estimate will carry it."
    );
  }
  if (/NonceTooLow|nonce too low/i.test(text)) {
    return "Another transaction from this wallet landed first. Wait for it to settle, then retry.";
  }
  if (/user rejected|User denied|ACTION_REJECTED|4001/i.test(text)) {
    return "You dismissed the wallet dialog, so nothing was sent.";
  }
  if (/was reverted|to consensus contract/i.test(text)) {
    return (
      "The network was still settling an earlier transaction for this contract and turned this " +
      "one away. Nothing was spent. Retry in a few seconds."
    );
  }
  if (/rate limit|-32029|-32429|429/i.test(text)) {
    return "The network is rate-limiting this address. Wait a minute and retry.";
  }
  if (/invalid_contract/i.test(text)) {
    return (
      "The address in this build is not a live contract on this network — usually a deploy " +
      "that reverted, or the app pointed at the wrong network."
    );
  }
  if (/fetch failed|Failed to fetch|NetworkError|ECONNRESET|timeout/i.test(text)) {
    return "The network endpoint did not answer. Your transaction may still be in flight — check its status.";
  }
  return text;
}
