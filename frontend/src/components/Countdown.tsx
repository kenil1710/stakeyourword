"use client";

import { absolute, relative } from "@/lib/format";

/**
 * A deadline, relative to the CHAIN's clock.
 *
 * `now` comes from `get_stats().now` and is null until that read lands, so
 * nothing time-shaped renders before there is a chain time to render it from —
 * which is also what keeps the server and client renders identical.
 */
export function Countdown({
  epoch,
  now,
  prefix,
}: {
  epoch: number;
  now: number | null;
  prefix?: string;
}) {
  if (!epoch) return <span className="text-muted">—</span>;
  if (now === null) return <span className="mono text-muted">·····</span>;

  const overdue = epoch <= now;
  return (
    <span
      className={`mono text-[13px] ${overdue ? "text-accent-ink" : "text-ink-2"}`}
      title={absolute(epoch)}
    >
      {prefix ? `${prefix} ` : ""}
      {relative(epoch, now)}
    </span>
  );
}
