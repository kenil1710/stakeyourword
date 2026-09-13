"use client";

/**
 * The verification history, newest first.
 *
 * The three money legs are always shown together and always sum to the period
 * stake — that is the invariant the contract enforces at settlement, and
 * showing them as a set is what makes it checkable by eye.
 */
import { Archive, ExternalLink, Radio, ShieldAlert, ShieldCheck, WifiOff } from "lucide-react";
import type { CommitmentDetail, VerificationRow } from "@/types";
import { VerdictPill } from "./Pills";
import { AddressLink } from "./AddressLink";
import { Empty } from "./States";
import { absolute, gen } from "@/lib/format";

export function HistoryList({ detail }: { detail: CommitmentDetail }) {
  const rows = [...detail.history].sort((a, b) => b.period_number - a.period_number);

  if (!rows.length) {
    return (
      <Empty
        title="Nothing settled yet."
        hint="The first row appears when period 1 is verified — or when its grace window closes without anyone checking."
      />
    );
  }

  return (
    <div className="card ruled overflow-hidden">
      {rows.map((row) => (
        <Row key={row.period_number} row={row} />
      ))}
    </div>
  );
}

function Row({ row }: { row: VerificationRow }) {
  const total =
    BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary);

  return (
    <article className="px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Period {row.period_number}</span>
        <VerdictPill verdict={row.verdict} />
        {row.verdict !== "LAPSED" && row.confidence > 0 ? (
          <span className="pill pill-neutral">confidence {row.confidence}</span>
        ) : null}
        {!row.reachable ? (
          <span className="pill pill-lapse">
            <WifiOff size={11} aria-hidden />
            page unreachable
          </span>
        ) : null}
        {row.unchanged ? <span className="pill pill-neutral">page unchanged</span> : null}
        <EvidencePill row={row} />
        {row.reachable && !row.corroborated ? (
          <span className="pill pill-lapse">no independent corroboration</span>
        ) : null}
        {row.injection_flagged ? (
          <span className="pill pill-lapse">
            <ShieldAlert size={11} aria-hidden />
            injection text
          </span>
        ) : null}
        <span className="hint ml-auto">
          due {absolute(row.deadline)} · settled {absolute(row.verified_at)}
        </span>
      </div>

      <p className="mt-3 max-w-3xl text-[14.5px] leading-relaxed text-ink-2">{row.reasoning}</p>

      <div className="sunk mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <Leg label="to committer" wei={row.to_committer} />
        <Leg label="to beneficiary" wei={row.to_beneficiary} />
        <Leg label="finder's fee" wei={row.caller_bounty} accent />
        <span className="hint ml-auto">
          {total > 0n ? `${gen(total)} settled · ` : ""}
          called by <AddressLink address={row.caller} />
        </span>
      </div>

      <Provenance row={row} />
    </article>
  );
}

/**
 * What the verdict was actually read from.
 *
 * This is the distinction the whole deadline-time evidence mechanism exists to
 * make: ARCHIVE means an immutable snapshot from around the deadline — the same
 * bytes for every validator, comparable by hash — and LIVE means today's page,
 * which is a weaker thing to have judged a past deadline on and should say so.
 */
function EvidencePill({ row }: { row: VerificationRow }) {
  if (row.verdict === "LAPSED" || row.evidence_kind === "NONE") return null;
  if (row.evidence_kind === "ARCHIVE") {
    return (
      <span className="pill pill-neutral">
        <Archive size={11} aria-hidden />
        deadline-time snapshot
      </span>
    );
  }
  return (
    <span className="pill pill-neutral">
      <Radio size={11} aria-hidden />
      read live
    </span>
  );
}

/**
 * The evidence trail, in the order somebody auditing it would want it: what was
 * read, when it was captured, what it hashed to, and how far it had moved from
 * the page the promise was made against.
 */
function Provenance({ row }: { row: VerificationRow }) {
  if (!row.content_hash && !row.snapshot_url) return null;

  const drift = row.drift_bps;
  const driftNote =
    drift >= 9800
      ? "byte-for-byte what the page said at creation"
      : drift >= 7500
        ? "barely changed since creation"
        : drift >= 2500
          ? "substantially rewritten since creation"
          : "almost nothing left of the page the promise was made against";

  return (
    <div className="mono mt-2.5 space-y-1 text-[11px] text-muted">
      {row.content_hash ? <p>evidence hash {row.content_hash}</p> : null}
      {row.snapshot_stamp ? <p>captured {formatStamp(row.snapshot_stamp)}</p> : null}
      {row.snapshot_url ? (
        <p className="break-all">
          <a
            className="link-quiet inline-flex items-center gap-1"
            href={row.snapshot_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            the exact snapshot the validators read
            <ExternalLink size={10} aria-hidden />
          </a>
        </p>
      ) : null}
      {row.content_hash ? (
        <p>
          drift {(drift / 100).toFixed(1)}% similar to creation — {driftNote}
        </p>
      ) : null}
      {row.corroborated ? (
        <p className="inline-flex items-center gap-1">
          <ShieldCheck size={10} aria-hidden />
          validators retrieved this evidence independently
        </p>
      ) : null}
      {row.verdict !== "LAPSED" ? (
        <p>
          observations · dated in window {row.dated_in_window ? "yes" : "no"} · artefact found{" "}
          {row.artifact_found ? "yes" : "no"}
        </p>
      ) : null}
    </div>
  );
}

/** `20260828134507` → `2026-08-28 13:45 UTC`. */
function formatStamp(stamp: string): string {
  if (!/^\d{14}$/.test(stamp)) return stamp;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)} UTC`;
}

function Leg({ label, wei, accent }: { label: string; wei: string; accent?: boolean }) {
  const zero = BigInt(wei) === 0n;
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span
        className={`num text-[13px] ${
          zero ? "text-muted" : accent ? "text-accent-ink" : "text-ink"
        }`}
      >
        {gen(wei)}
      </span>
    </span>
  );
}
