/**
 * Typed access to StakeYourWord.
 *
 * Every view returns a JSON string, so each reader parses once and hands back a
 * real object. Reads go through the no-signer client and are safe to call from
 * anywhere; writes need a wallet and are browser-only.
 */
import { TransactionStatus } from "genlayer-js/types";
import type { CalldataEncodable } from "genlayer-js/types";
import { CONTRACT_ADDRESS, getReadClient, getWalletClient } from "./genlayer";
import type {
  CommitmentDetail,
  CommitmentSummary,
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
  /** Total sent. For a recurring commitment this funds `value / stake` periods. */
  value: bigint;
}

/**
 * Submit a write and wait for it to settle.
 *
 * Returns the transaction's own outcome. Callers must ALSO check the returned
 * `WriteResult` on payable methods: the contract refunds rather than reverting
 * on bad input, so a rejection arrives as a perfectly successful transaction
 * whose return value says `ok: false`.
 */
async function submit(
  account: `0x${string}`,
  functionName: string,
  args: CalldataEncodable[],
  value = 0n,
): Promise<{ hash: string; returned: unknown }> {
  const wallet = getWalletClient(account);
  const hash = await wallet.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value,
  });
  /*
   * Studionet settles on its own, so this just polls until it does.
   *
   * KNOWN GAP FOR BRADBURY: transactions there routinely park in COMMITTING
   * and need `finalizeIdlenessTxs` to move on — `test/harness.mjs` nudges every
   * 45s for exactly this reason. Nudging is itself a transaction, so doing it
   * automatically here would fire a second wallet prompt in the middle of a
   * write the user has already signed. Before pointing this app at Bradbury,
   * that needs to become a visible "this is taking a while — nudge it?" control
   * rather than a silent retry, or writes will appear to hang forever.
   */
  const receipt = await wallet.waitForTransactionReceipt({
    hash,
    // The SDK types this as its own enum, not a bare string. Passing the enum
    // member keeps the two spellings from drifting.
    status: TransactionStatus.ACCEPTED,
    retries: 200,
    interval: 2_000,
  });
  return { hash, returned: decodeReturn(receipt) };
}

/**
 * Pull the contract's return value out of a receipt.
 *
 * The payload is an object carrying the value both as raw calldata and as
 * `readable` — a JSON-encoded form. Reading it without checking the shape gets
 * you "[object Object]", and on a revert the same field is a bare reason string.
 */
function decodeReturn(receipt: unknown): unknown {
  const payload = (receipt as { consensus_data?: { leader_receipt?: Array<{ result?: { payload?: unknown } }> } })
    ?.consensus_data?.leader_receipt?.[0]?.result?.payload;
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

export async function createCommitment(account: `0x${string}`, args: CreateArgs) {
  return submit(
    account,
    "create_commitment",
    [
      args.description,
      args.verifyUrl,
      args.beneficiary,
      args.periodMinutes,
      args.stakePerPeriod.toString(),
      args.recurring,
    ],
    args.value,
  );
}

export const verifyCommitment = (account: `0x${string}`, id: number) =>
  submit(account, "verify_commitment", [id]);

export const settleLapsed = (account: `0x${string}`, id: number) =>
  submit(account, "settle_lapsed", [id]);

export const addStake = (account: `0x${string}`, id: number, value: bigint) =>
  submit(account, "add_stake", [id], value);

export const cancelCommitment = (account: `0x${string}`, id: number) =>
  submit(account, "cancel_commitment", [id]);
