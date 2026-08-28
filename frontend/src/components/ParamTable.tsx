"use client";

/**
 * The live parameters, read from the contract rather than transcribed.
 *
 * Documentation that restates a number the chain owns goes stale silently, and
 * a stale limit in the docs is worse than no limit in the docs — it is the one
 * a reader will size their stake against.
 */
import { useStats } from "@/hooks/useChain";
import { Skeleton } from "./States";
import { duration, gen, pct, shortAddress } from "@/lib/format";

export function ParamTable() {
  const { data, error } = useStats();

  if (error) {
    return <p className="hint">The contract did not answer, so these are not shown rather than guessed.</p>;
  }
  if (!data) {
    return (
      <div className="card-flat p-5">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="mt-2 h-4 w-full first:mt-0" />
        ))}
      </div>
    );
  }

  const rows: Array<[string, string]> = [
    ["Finder's fee", pct(data.bounty_bps)],
    ["Early-cancellation fee", pct(data.cancel_fee_bps)],
    ["Stake per period", `${gen(data.min_stake)} – ${gen(data.max_stake)}`],
    ["Period length", `${duration(data.min_period_minutes * 60)} – 30d`],
    ["Periods funded at once", `up to ${data.max_funded_periods}`],
    ["Open promises per wallet", `up to ${data.max_active_per_wallet}`],
    ["Currently staked", gen(data.locked_stakes)],
    ["Owner", shortAddress(data.owner)],
    ["New commitments", data.paused ? "paused" : "open"],
  ];

  return (
    <div className="card-flat ruled overflow-hidden">
      {rows.map(([term, value]) => (
        <div key={term} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2.5">
          <span className="text-[13px] text-muted">{term}</span>
          <span className="mono text-[13px] text-ink">{value}</span>
        </div>
      ))}
    </div>
  );
}
