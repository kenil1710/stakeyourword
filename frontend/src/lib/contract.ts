/**
 * Typed access to StakeYourWord.
 *
 * Every view returns a JSON string, so each reader parses once and hands back a
 * real object. Reads go through the no-signer client and are safe to call from
 * anywhere; writes need a wallet and are browser-only.
 */
import { transactionsStatusNumberToName } from "genlayer-js/types";
import type { CalldataEncodable, Hash, TransactionFeeOptions } from "genlayer-js/types";
import { CONTRACT_ADDRESS, getReadClient, getWalletClient } from "./genlayer";
import { quoteWrite, type Quote, type WriteCall } from "./fees";
import type {
  CommitmentDetail,
  CommitmentSummary,
  Preflight,
  Stats,
  TrackRecord,
  WriteResult,
} from "@/types";

async function readJson<T>(functionName: string, args: CalldataEncodable[] = []): Promise<T> {
  const raw = await getReadClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  });
  if (typeof raw !== "string") {
    throw new Error(`${functionName} did not return a JSON string`);
  }
  return JSON.parse(raw) as T;
}

/* ── Reads ─────────────────────────────────────────────────────────────── */

export const getStats = () => readJson<Stats>("get_stats");

export const getRecentCommitments = (count = 20) =>
  readJson<CommitmentSummary[]>("get_recent_commitments", [count]);

export const getActiveCommitments = () => readJson<CommitmentSummary[]>("get_active_commitments");

/** The bounty board: every period past its deadline right now. */
export const getVerifiableNow = () => readJson<CommitmentSummary[]>("get_verifiable_now");

export const getUserCommitments = (who: string) =>
  readJson<CommitmentSummary[]>("get_user_commitments", [who]);

export const getBeneficiaryCommitments = (who: string) =>
  readJson<CommitmentSummary[]>("get_beneficiary_commitments", [who]);

export const getTrackRecord = (who: string) => readJson<TrackRecord>("get_track_record", [who]);

/**
 * Everything `create_commitment` would turn the call down for, answered BEFORE
 * a wallet is opened — and answered by the CONTRACT'S OWN code path, not by a
 * reimplementation of it in TypeScript that would drift the first time either
 * side changed. The one check it cannot make is reachability: that is
 * non-deterministic and only exists inside consensus.
 */
export const preflightCreate = (args: {
  who: string;
  description: string;
  verifyUrl: string;
  beneficiary: string;
  periodMinutes: number;
  stakePerPeriod: bigint;
  recurring: boolean;
  value: bigint;
  archiveUrl?: string;
}) =>
  readJson<Preflight>("preflight_create", [
    args.who,
    args.description,
    args.verifyUrl,
    args.beneficiary,
    args.periodMinutes,
    args.stakePerPeriod.toString(),
    args.recurring,
    args.value.toString(),
    args.archiveUrl ?? "",
  ]);

export async function getCommitment(id: number): Promise<CommitmentDetail | null> {
  const found = await readJson<CommitmentDetail | { found: false }>("get_commitment", [id]);
  return found.found ? (found as CommitmentDetail) : null;
}

/* ── Writes ────────────────────────────────────────────────────────────── */

export interface CreateArgs {
  description: string;
  verifyUrl: string;
  beneficiary: string;
  periodMinutes: number;
  stakePerPeriod: bigint;
  recurring: boolean;
  /** Optional immutable snapshot the committer pins up front. */
  archiveUrl?: string;
  /** Total sent. For a recurring commitment this funds `value / stake` periods. */
  value: bigint;
}

/* ── Call builders ──────────────────────────────────────────────────────── */
/*
 * A write is described as DATA, not performed by a function that also submits
 * it. The lifecycle needs the same description three times — to quote it, to
 * submit it, and to retry it — and a builder that submitted as a side effect
 * would make "retry" mean "build a second, subtly different call".
 *
 * `payees` is every address the call might pay. It is only used to build a fee
 * envelope when the simulation that would normally derive one could not run
 * (see lib/fees.ts), and every one of them is on the commitment record before
 * the call is made — so the envelope can cover a settlement the simulator
 * refused to simulate.
 */

/** Who a settlement can pay: the committer, the beneficiary, and the caller. */
const payeesOf = (row: Pick<CommitmentSummary, "committer" | "beneficiary">, caller: string) => [
  ...new Set([row.committer, row.beneficiary, caller].map((a) => a.toLowerCase())),
];

export const createCall = (args: CreateArgs & { from?: string }): WriteCall => ({
  functionName: "create_commitment",
  args: [
    args.description,
    args.verifyUrl,
    args.beneficiary,
    args.periodMinutes,
    args.stakePerPeriod.toString(),
    args.recurring,
    args.archiveUrl ?? "",
  ],
  value: args.value,
  // A create can only ever pay its own sender back — the uneven-funding refund.
  payees: args.from ? [args.from.toLowerCase()] : [],
});

export const verifyCall = (row: CommitmentSummary, caller: string): WriteCall => ({
  functionName: "verify_commitment",
  args: [row.id],
  payees: payeesOf(row, caller),
});

/**
 * The deterministic close for a period nobody settled in time.
 *
 * `settle_stalled` rather than `settle_lapsed`: the two do the same thing, and
 * this is the name of the failure a user is actually looking at when the button
 * appears — consensus that never formed, or a period nobody called.
 */
export const settleStalledCall = (row: CommitmentSummary, caller: string): WriteCall => ({
  functionName: "settle_stalled",
  args: [row.id],
  payees: payeesOf(row, caller),
});

export const addStakeCall = (row: CommitmentSummary, value: bigint, caller: string): WriteCall => ({
  functionName: "add_stake",
  args: [row.id],
  value,
  // Only the dust refund, back to the sender.
  payees: [caller.toLowerCase()],
});

export const cancelCall = (row: CommitmentSummary, caller: string): WriteCall => ({
  functionName: "cancel_commitment",
  args: [row.id],
  payees: payeesOf(row, caller),
});

/* ── The transaction lifecycle ──────────────────────────────────────────── */

/** What a write costs and whether this wallet can pay for it. */
export const quote = (account: `0x${string}`, call: WriteCall): Promise<Quote> =>
  quoteWrite(account, call);

/**
 * The SDK brands its hash type with a length so a truncated string cannot be
 * mistaken for one. Nothing here can prove that at the type level — the value
 * comes back from the chain — so the cast is made once, here, rather than
 * scattered at every call site.
 */
const asHash = (value: string): Hash => value as Hash;

/**
 * Sign and submit, and return the hash AS SOON AS IT EXISTS.
 *
 * Deliberately does not wait for settlement. The hash is the only thing a user
 * can act on while a transaction is in flight — look it up, wait on it, show it
 * to somebody — and a submit that withholds it until the transaction settles
 * leaves them with nothing but a spinner for the minutes that matter most.
 */
export async function submitWrite(
  account: `0x${string}`,
  call: WriteCall,
  fees: unknown,
): Promise<`0x${string}`> {
  const wallet = getWalletClient(account);
  return (await wallet.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: call.functionName,
    args: call.args,
    value: call.value ?? 0n,
    fees: fees as TransactionFeeOptions,
  })) as `0x${string}`;
}

/** Where a transaction has got to. One poll, no waiting. */
export interface TxSnapshot {
  /** The chain's own status name: PENDING, ACCEPTED, FINALIZED, UNDETERMINED… */
  status: string | null;
  /** True once state has been applied — ACCEPTED or FINALIZED. */
  decided: boolean;
  finalized: boolean;
  /** True when the contract itself errored. `reason` says why. */
  reverted: boolean;
  /** UNDETERMINED: consensus could not agree. Nothing was applied. */
  undetermined: boolean;
  reason: string;
  returned: unknown;
  /** False when the RPC would not answer. Absence of evidence, not absence. */
  answered: boolean;
}

const DECIDED = ["ACCEPTED", "FINALIZED"];

export async function pollTx(hash: string): Promise<TxSnapshot> {
  const blank: TxSnapshot = {
    status: null,
    decided: false,
    finalized: false,
    reverted: false,
    undetermined: false,
    reason: "",
    returned: null,
    answered: false,
  };
  let tx: unknown;
  try {
    tx = await getReadClient().getTransaction({ hash: asHash(hash) });
  } catch {
    // An RPC that will not answer is NOT a transaction that failed. Reporting
    // it as one is how a UI tells someone their money is gone while it is
    // simply mid-flight.
    return blank;
  }

  const raw = tx as {
    status?: number;
    txExecutionResultName?: string;
    consensus_data?: { leader_receipt?: Array<{ result?: { status?: string; payload?: unknown } }> };
  };
  const status =
    transactionsStatusNumberToName[String(raw?.status ?? "") as keyof typeof transactionsStatusNumberToName] ??
    null;
  const receipt = raw?.consensus_data?.leader_receipt?.[0];
  const rolledBack = receipt?.result?.status === "rollback" || receipt?.result?.status === "contract_error";
  const reverted = raw?.txExecutionResultName === "FINISHED_WITH_ERROR" || rolledBack;

  return {
    status,
    decided: Boolean(status && DECIDED.includes(status)) && !reverted,
    finalized: status === "FINALIZED" && !reverted,
    reverted,
    undetermined: status === "UNDETERMINED",
    reason: reverted ? revertReason(receipt) : "",
    returned: reverted ? null : decodeReturn(tx),
    answered: true,
  };
}

/**
 * Ask the network to move a transaction that has stopped moving.
 *
 * Consensus parks a transaction in COMMITTING when a validator round does not
 * complete, and it stays there until somebody pokes it. This is that poke, and
 * it is a transaction of its own — which is exactly why it is a BUTTON rather
 * than something the app does silently: a second wallet prompt arriving in the
 * middle of a write the user already signed is indistinguishable from a bug.
 */
export async function nudgeTx(account: `0x${string}`, hash: string): Promise<void> {
  const wallet = getWalletClient(account);
  await wallet.finalizeIdlenessTxs({ txIds: [asHash(hash)] });
}

/** The reason a `gl.vm.UserError` gave, decoded from whichever field carries it. */
function revertReason(receipt: unknown): string {
  const result = (receipt as { result?: { payload?: unknown; raw?: unknown } })?.result;
  if (!result) return "";
  if (typeof result.payload === "string" && result.payload) return result.payload;
  if (typeof result.raw === "string" && result.raw) {
    try {
      // The leading byte is a status tag, not text.
      return atob(result.raw).replace(/^[\x00-\x1f]+/, "");
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Pull the contract's return value out of a transaction.
 *
 * The payload is an object carrying the value both as raw calldata and as
 * `readable` — a JSON-encoded form. Reading it without checking the shape gets
 * you "[object Object]", and on a revert the same field is a bare reason string.
 */
function decodeReturn(tx: unknown): unknown {
  const payload = (
    tx as {
      consensus_data?: { leader_receipt?: Array<{ result?: { payload?: unknown } }> };
    }
  )?.consensus_data?.leader_receipt?.[0]?.result?.payload;
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload;
  const readable = (payload as { readable?: unknown }).readable;
  if (typeof readable === "string") {
    try {
      return JSON.parse(readable);
    } catch {
      return readable;
    }
  }
  return null;
}

/** Parse whatever a payable method returned into a WriteResult, if it is one. */
export function asWriteResult(returned: unknown): WriteResult | null {
  const value = typeof returned === "string" ? safeParse(returned) : returned;
  if (!value || typeof value !== "object") return null;
  if (!("ok" in value)) return null;
  return value as WriteResult;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
