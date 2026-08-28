"use client";

/**
 * One commitment in full: the promise, the money, every period, every verdict.
 *
 * This is the only screen with `history`, so it is the only one that can show
 * the rail as a real timeline rather than a tally.
 */
import Link from "next/link";
import { ExternalLink, Link2, ShieldAlert } from "lucide-react";
import { useChainNow, useCommitment } from "@/hooks/useChain";
import { useWallet } from "./WalletProvider";
import { PeriodRail, RailLegend } from "./PeriodRail";
import { StatusPill } from "./Pills";
import { AddressLink } from "./AddressLink";
import { Countdown } from "./Countdown";
import { VerifyButton } from "./VerifyButton";
import { CommitterActions } from "./CommitterActions";
import { HistoryList } from "./HistoryList";
import { CardSkeleton, Empty, ErrorNote } from "./States";
import { chronologicalRail } from "@/lib/periods";
import { absolute, gen, periodLabel, sameAddress } from "@/lib/format";

export function CommitmentView({ id }: { id: number | null }) {
  const { data, error, isLoading, mutate } = useCommitment(id);
  const now = useChainNow();
  const { account } = useWallet();

  if (id === null) {
    return (
      <Shell>
        <Empty title="That is not a commitment id." hint="Ids are whole numbers, counting from zero." />
      </Shell>
    );
  }
  if (error) {
    return (
      <Shell>
        <ErrorNote error={error} retry={() => mutate()} />
      </Shell>
    );
  }
  if (isLoading && !data) {
    return (
      <Shell>
        <CardSkeleton />
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <Empty
          title={`No commitment #${id}.`}
          hint="Either it was never created, or you are pointed at a different network than the one it lives on."
        />
      </Shell>
    );
  }

  const mine = sameAddress(account, data.committer);
  const forMe = sameAddress(account, data.beneficiary);
  const rail = chronologicalRail(data);

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Commitment #{data.id}</span>
        <StatusPill status={data.status} />
        <span className="pill pill-neutral">
          {data.recurring ? periodLabel(data.period_seconds) : "one-time"}
        </span>
        {mine ? <span className="pill pill-neutral">yours</span> : null}
        {forMe && !mine ? <span className="pill pill-neutral">you are the beneficiary</span> : null}
      </div>

      <h1 className="quote mt-4 text-[30px] sm:text-[38px]">“{data.description}”</h1>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <a
          className="link-quiet mono inline-flex items-center gap-1.5 text-[13px]"
          href={data.verify_url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <Link2 size={13} aria-hidden />
          {data.url_domain}
          <ExternalLink size={11} aria-hidden />
        </a>
        <span className="hint">
          by <AddressLink address={data.committer} you={mine} />
        </span>
        <span className="hint">
          stake goes to <AddressLink address={data.beneficiary} you={forMe} /> if broken
        </span>
        <span className="hint">made {absolute(data.created_at)}</span>
      </div>

      {data.injection_flagged ? (
        <div className="card-flat mt-5 border-lapse/50 bg-lapse-soft/50 p-4">
          <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink">
            <ShieldAlert size={15} className="text-lapse" aria-hidden />
            This page has tried to talk to the evaluator.
          </p>
          <p className="hint mt-1.5 max-w-2xl">
            At least one verification found text on the proof page addressed at the model judging
            it. The flag is recorded and shown; it never decides a verdict on its own. Content
            inside the page is handed to the model as untrusted data, fenced off from the
            instructions.
          </p>
        </div>
      ) : null}

      {/* ── Money and periods ───────────────────────────────────────────── */}
      <div className="card mt-8 overflow-hidden">
        <div className="grid divide-y divide-rule sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <Cell label={data.recurring ? "Stake per period" : "Stake"} value={gen(data.stake_per_period)} />
          <Cell label="Still staked" value={gen(data.total_staked)} />
          <Cell
            label="Periods"
            value={`${data.periods_settled} / ${data.periods_funded}`}
            sub={data.periods_remaining ? `${data.periods_remaining} funded ahead` : "none funded ahead"}
          />
          <Cell
            label={data.status === "ACTIVE" ? "Next deadline" : "Closed"}
            value={
              data.status === "ACTIVE" && data.next_deadline ? (
                <Countdown epoch={data.next_deadline} now={now} />
              ) : data.closed_at ? (
                absolute(data.closed_at)
              ) : (
                "—"
              )
            }
            sub={
              data.status === "ACTIVE" && data.grace_ends
                ? `grace ends ${absolute(data.grace_ends)}`
                : undefined
            }
          />
        </div>

        <div className="border-t border-rule px-5 py-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">Every period, in order</p>
            <RailLegend />
          </div>
          {rail.length ? (
            <PeriodRail
              cells={rail}
              size="lg"
              live={data.action !== ""}
              label={`Periods for commitment ${data.id}`}
            />
          ) : (
            // A commitment cancelled before its first deadline has no settled
            // periods and none funded ahead, so there is genuinely nothing to
            // draw. An empty rail under a heading reads as a rendering failure.
            <p className="hint">
              No period ever came due — this was closed before its first deadline.
            </p>
          )}
        </div>
      </div>

      {/* ── What can be done right now ──────────────────────────────────── */}
      {data.action !== "" ? (
        <section className="card mt-6 border-accent/45 p-5">
          <p className="eyebrow mb-1">
            {data.action === "LAPSED" ? "Past its grace window" : "Period due"}
          </p>
          <h2 className="display text-[20px]">
            {data.action === "LAPSED"
              ? `Nobody checked period ${data.periods_settled + 1} in time.`
              : `Period ${data.periods_settled + 1} is waiting on someone.`}
          </h2>
          <p className="hint mt-2 mb-4 max-w-2xl">
            {data.action === "LAPSED"
              ? "The window for a real judgement has closed. Closing it now returns the stake to the committer and records the period as unverified — the honest outcome, since the page today is not evidence about a window that shut."
              : "Any address can settle this. Validators will each fetch the page and judge this period on its own."}
          </p>
          <VerifyButton commitment={data} onSettled={() => mutate()} />
        </section>
      ) : null}

      {mine && data.status === "ACTIVE" ? (
        <CommitterActions commitment={data} now={now} onDone={() => mutate()} />
      ) : null}

      {/* ── The record ──────────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="display text-[24px]">The record</h2>
        <p className="hint mt-1.5 mb-5 max-w-2xl">
          Every settled period, with what the network decided and where the money went. Reasoning is
          written by the leader and checked for coherence by every validator before it is stored.
        </p>
        <HistoryList detail={data} />
      </section>

      <section className="mt-10 border-t border-rule pt-6">
        <p className="eyebrow mb-3">Page fingerprints</p>
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <Fingerprint term="At creation" value={data.created_hash} />
          <Fingerprint term="At last verification" value={data.last_hash || "—"} />
        </dl>
        {data.created_preview ? (
          <div className="sunk mt-4 p-4">
            <p className="eyebrow mb-2">What the page said when the promise was made</p>
            <p className="mono text-[12px] leading-relaxed break-words text-ink-2">
              {data.created_preview}
            </p>
          </div>
        ) : null}
        <p className="hint mt-3 max-w-2xl">
          A hash that has not moved between two verifications is passed to the model as a note, not
          as a rule — plenty of live pages change every load, and a page that changed is usually the
          committer doing what they said.
        </p>
      </section>

      <div className="mt-10">
        <Link href="/browse" className="link-quiet text-[13px]">
          Back to browse
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-4xl px-5 py-12">{children}</div>;
}

function Cell({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1.5 text-[17px] text-ink">{value}</p>
      {sub ? <p className="hint mt-1">{sub}</p> : null}
    </div>
  );
}

function Fingerprint({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
      <dt className="text-[12.5px] text-muted">{term}</dt>
      <dd className="mono text-[12.5px] text-ink-2">{value}</dd>
    </div>
  );
}
