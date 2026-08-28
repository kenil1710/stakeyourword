"use client";

import { useStats } from "@/hooks/useChain";
import { StatTile } from "./StatTile";
import { Skeleton } from "./States";
import { gen, pct } from "@/lib/format";

/**
 * The four numbers worth putting above the fold.
 *
 * `locked_stakes` rather than `balance`: it is the contract's only liability,
 * so it is the honest answer to "how much money is actually riding on this".
 */
export function StatsStrip() {
  const { data, error } = useStats();

  if (error) return null;
  if (!data) {
    return (
      <div className="card-flat grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-16" />
          </div>
        ))}
      </div>
    );
  }

  const decided = data.periods_kept + data.periods_broken;

  return (
    <div className="card-flat grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
      <StatTile label="Promises made" value={data.total} />
      <StatTile label="Staked right now" value={gen(data.locked_stakes, 2)} />
      <StatTile
        label="Periods kept"
        value={decided ? pct(data.kept_bps) : "—"}
        sub={decided ? `${data.periods_kept} of ${decided} decided` : "nothing decided yet"}
      />
      <StatTile
        label="Paid to beneficiaries"
        value={gen(data.total_forfeited, 2)}
        sub={`${gen(data.total_bounties, 2)} in finder's fees`}
      />
    </div>
  );
}
