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

/** How the proof source authenticates itself, decided on chain at creation. */
export type SourceKind = "ATTESTED" | "ARCHIVED" | "OPEN";

/** What a verdict was actually read from. */
export type EvidenceKind = "ARCHIVE" | "LIVE" | "NONE";

export interface CommitmentSummary {
  id: number;
  committer: string;
  beneficiary: string;
  description: string;
  verify_url: string;
  url_domain: string;
  /** An immutable snapshot the committer pinned at creation. "" when none. */
  archive_url: string;
  source_kind: SourceKind;
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
  /** True while a verification for this commitment is already in flight. */
  verify_in_flight: boolean;
  /** Unix seconds the in-flight lock expires. 0 when nothing is in flight. */
  verify_lock_until: number;
  /** Past its grace window: only the deterministic close can settle it now. */
  stalled: boolean;
  /** The rates SNAPSHOTTED at creation — not the contract's current ones. */
  bounty_bps: number;
  cancel_bps: number;
}

export interface VerificationRow {
  period_number: number;
  deadline: number;
  verified_at: number;
  verdict: Verdict;
  reasoning: string;
  confidence: number;
  content_hash: string;
  content_sketch: string;
  /**
   * How close the evidence was to what the page said at CREATION, in basis
   * points. 10000 is byte-identical; 0 is nothing in common. Recomputed on
   * chain after consensus, never taken from the leader.
   */
  drift_bps: number;
  evidence_kind: EvidenceKind;
  /** The immutable snapshot the verdict was read from. "" for a live read. */
  snapshot_url: string;
  /** The 14-digit archive timestamp of that snapshot. "" for a live read. */
  snapshot_stamp: string;
  /** Whether validators independently retrieved the evidence themselves. */
  corroborated: boolean;
  dated_in_window: boolean;
  artifact_found: boolean;
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
  created_sketch: string;
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
  /**
   * The HARD CAP on how long after a deadline an archived snapshot may be
   * captured and still count as evidence about it. The window a given
   * commitment actually gets is its own period length, capped at this.
   */
  archive_window_cap_seconds: number;
  /** How long a verification holds the in-flight lock. */
  verify_lock_seconds: number;
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

/**
 * What `preflight_create` answers.
 *
 * The contract's own rejection logic, run as a view before a wallet is opened,
 * so the UI shows the reason the write would actually give rather than a
 * TypeScript guess at it. `checks_reachability` is false and says so: whether
 * the proof URL can be fetched is non-deterministic and only exists inside
 * consensus.
 */
export interface Preflight {
  ok: boolean;
  /** "" when ok. Otherwise the contract's own wording. */
  reason: string;
  /** Wei that must ride with the call. */
  required: string;
  funded_periods: number;
  stake_per_period: string;
  min_stake: string;
  max_stake: string;
  /** Seconds left on this wallet's create cooldown. 0 when clear. */
  cooldown_left: number;
  active: number;
  max_active: number;
  paused: boolean;
  source_kind: SourceKind;
  /** Always false. The reachability check lives in consensus, not in a view. */
  checks_reachability: boolean;
  now: number;
}
