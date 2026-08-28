/**
 * The shapes `get_*` actually return.
 *
 * Every wei amount crosses the wire as a decimal STRING, never a number: a
 * stake is an 18-decimal integer and `JSON.parse` would silently round it past
 * 2^53. Convert with `BigInt(...)` at the point of use, never with `Number`.
 */

export type Verdict = "MET" | "NOT_MET" | "INCONCLUSIVE" | "LAPSED";
export type Status = "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELED";
export type Frequency = "ONE_TIME" | "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";

/** What a period is waiting for, as computed on chain by `_derived`. */
export type Action = "" | "VERIFY" | "LAPSED";

export interface CommitmentSummary {
  id: number;
  committer: string;
  beneficiary: string;
  description: string;
  verify_url: string;
  url_domain: string;
  stake_per_period: string;
  total_staked: string;
  period_seconds: number;
  frequency: Frequency;
  recurring: boolean;
  periods_settled: number;
  periods_met: number;
  periods_failed: number;
  periods_inconclusive: number;
  periods_lapsed: number;
  status: Status;
  created_at: number;
  closed_at: number;
  periods_remaining: number;
  periods_funded: number;
  next_deadline: number;
  grace_ends: number;
  action: Action;
  /** The exact bounty this call would pay, in wei. "0" unless `action` is VERIFY. */
  bounty: string;
}

export interface VerificationRow {
  period_number: number;
  deadline: number;
  verified_at: number;
  verdict: Verdict;
  reasoning: string;
  confidence: number;
  content_hash: string;
  unchanged: boolean;
  reachable: boolean;
  injection_flagged: boolean;
  caller: string;
  caller_bounty: string;
  to_committer: string;
  to_beneficiary: string;
}

export interface CommitmentDetail extends CommitmentSummary {
  found: true;
  created_hash: string;
  created_preview: string;
  last_hash: string;
  injection_flagged: boolean;
  history: VerificationRow[];
}

export interface TrackRecord {
  address: string;
  kept: number;
  broken: number;
  unclear: number;
  lapsed: number;
  /** kept + broken. Periods that were actually adjudicated. */
  decided: number;
  /** Basis points of `decided` that were kept. */
  kept_bps: number;
  streak: number;
  best_streak: number;
  received: string;
  active: number;
}

export interface Stats {
  total: number;
  completed: number;
  failed: number;
  canceled: number;
  periods_kept: number;
  periods_broken: number;
  periods_unclear: number;
  periods_lapsed: number;
  kept_bps: number;
  total_staked_alltime: string;
  total_returned: string;
  total_forfeited: string;
  total_bounties: string;
  total_refunded: string;
  locked_stakes: string;
  balance: string;
  unallocated: string;
  last_out_epoch: number;
  bounty_bps: number;
  cancel_fee_bps: number;
  min_stake: string;
  max_stake: string;
  max_funded_periods: number;
  max_active_per_wallet: number;
  min_period_minutes: number;
  paused: boolean;
  owner: string;
  /** The chain's clock, so countdowns are not driven by the browser's. */
  now: number;
}

/**
 * What a payable method returns.
 *
 * `ok: false` is a REJECTION, not a failed transaction: the contract refunded
 * the stake and returned successfully, because a revert on a payable path would
 * have kept the money. The UI must read this, never just the transaction status.
 */
export type WriteResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; reason: string; refunded: string };
