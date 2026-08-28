"use client";

/**
 * The verification history, newest first.
 *
 * The three money legs are always shown together and always sum to the period
 * stake — that is the invariant the contract enforces at settlement, and
 * showing them as a set is what makes it checkable by eye.
 */
import { ShieldAlert, WifiOff } from "lucide-react";
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

      {row.content_hash ? (
        <p className="mono mt-2 text-[11px] text-muted">page hash {row.content_hash}</p>
      ) : null}
    </article>
  );
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
