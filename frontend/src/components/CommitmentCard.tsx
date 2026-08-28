"use client";

/**
 * One commitment as a ledger row.
 *
 * The promise is quoted verbatim and never truncated — it is the one piece of
 * user writing on the page, and a promise with the end cut off is not a promise
 * anyone can check. Everything else on the card is fixed-height, so a long
 * quote grows the card rather than eating the numbers.
 */
import Link from "next/link";
import { ArrowRight, Link2 } from "lucide-react";
import type { CommitmentSummary } from "@/types";
import { tallyRail, tallyWords } from "@/lib/periods";
import { gen, periodLabel, sameAddress } from "@/lib/format";
import { PeriodRail } from "./PeriodRail";
import { StatusPill } from "./Pills";
import { AddressLink } from "./AddressLink";
import { Countdown } from "./Countdown";

export function CommitmentCard({
  commitment,
  now,
  viewer,
}: {
  commitment: CommitmentSummary;
  now: number | null;
  viewer?: string | null;
}) {
  const due = commitment.action !== "";
  const mine = sameAddress(viewer, commitment.committer);

  return (
    <article
      className={`card overflow-hidden transition-colors ${due ? "border-accent/45" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-2.5">
        <span className="eyebrow">#{commitment.id}</span>
        <StatusPill status={commitment.status} />
        <span className="pill pill-neutral">
          {commitment.recurring ? periodLabel(commitment.period_seconds) : "one-time"}
        </span>
        {due ? (
          <span className="pill pill-accent">
            {commitment.action === "LAPSED" ? "past grace" : "due now"}
          </span>
        ) : null}
        {mine ? <span className="pill pill-neutral">yours</span> : null}

        <span className="ml-auto">
          {commitment.status === "ACTIVE" && commitment.next_deadline ? (
            <Countdown epoch={commitment.next_deadline} now={now} prefix="due" />
          ) : null}
        </span>
      </div>

      <div className="px-5 py-4">
        <Link href={`/commitment/${commitment.id}`} className="block no-underline">
          <p className="quote text-[19px] text-ink">“{commitment.description}”</p>
        </Link>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <a
            className="link-quiet mono inline-flex items-center gap-1.5 text-[12px]"
            href={commitment.verify_url}
            target="_blank"
            rel="noreferrer noopener"
            title={commitment.verify_url}
          >
            <Link2 size={12} aria-hidden />
            {commitment.url_domain}
          </a>
          <span className="hint">
            by <AddressLink address={commitment.committer} you={mine} />
          </span>
          <span className="hint">
            to <AddressLink address={commitment.beneficiary} />
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-rule bg-sunk px-5 py-3">
        <div>
          <p className="eyebrow">
            {commitment.recurring ? "Stake per period" : "Stake"}
          </p>
          <p className="num mt-1 text-[17px] text-ink">{gen(commitment.stake_per_period)}</p>
        </div>

        <div className="min-w-0">
          {/* Grouped by outcome, not by time — a summary carries counts and no
              order. The detail page has history and shows the real timeline. */}
          <p className="eyebrow mb-1.5">{tallyWords(commitment)}</p>
          <PeriodRail
            cells={tallyRail(commitment)}
            size="sm"
            live={due}
            label={`Period tally for commitment ${commitment.id}`}
          />
        </div>

        <Link
          href={`/commitment/${commitment.id}`}
          className="btn ml-auto shrink-0 px-3 py-1.5 text-[13px]"
        >
          {due ? "Settle" : "Open"}
          <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </article>
  );
}
