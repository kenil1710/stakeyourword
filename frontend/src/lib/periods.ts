/**
 * The period rail — one chip per period, in order, left to right.
 *
 * Two builders, because the two data sources genuinely differ:
 *
 *   - `chronologicalRail` needs `history`, which only `get_commitment` returns.
 *     Each settled period is placed at its own index, so the rail is a true
 *     timeline: period 4 sits fourth whatever happened to it.
 *
 *   - `tallyRail` is all a list view can honestly build. A summary carries
 *     `periods_met` / `periods_failed` / … as COUNTS with no ordering, so the
 *     chips are grouped by outcome rather than placed in time. It is a tally
 *     wearing the rail's clothes, and it is labelled as one — inventing an
 *     order from counts would be a fabrication the data cannot support, and
 *     fetching every commitment's history to avoid it would turn one list read
 *     into fifty.
 */
import type { CommitmentDetail, CommitmentSummary, Verdict } from "@/types";

export type CellKind = "kept" | "broken" | "lapse" | "unclear" | "due" | "pending";

export interface Cell {
  key: string;
  kind: CellKind;
  /** Period number, shown on the large rail only. */
  label: string;
  /** Tooltip and accessible name. Always says which period and what happened. */
  title: string;
}

const KIND_OF_VERDICT: Record<Verdict, CellKind> = {
  MET: "kept",
  NOT_MET: "broken",
  INCONCLUSIVE: "unclear",
  LAPSED: "lapse",
};

export const KIND_WORD: Record<CellKind, string> = {
  kept: "kept",
  broken: "broken",
  lapse: "unverified",
  unclear: "inconclusive",
  due: "due now",
  pending: "not yet due",
};

export function kindOfVerdict(verdict: Verdict): CellKind {
  return KIND_OF_VERDICT[verdict] ?? "unclear";
}

/**
 * The true timeline. `periods_funded` is `periods_settled + periods_remaining`,
 * so the rail always shows everything paid for — settled behind, funded ahead.
 */
export function chronologicalRail(detail: CommitmentDetail): Cell[] {
  const byPeriod = new Map(detail.history.map((row) => [row.period_number, row]));
  const cells: Cell[] = [];

  for (let n = 1; n <= detail.periods_funded; n++) {
    const row = byPeriod.get(n);
    if (row) {
      const kind = kindOfVerdict(row.verdict);
      cells.push({
        key: `p${n}`,
        kind,
        label: String(n),
        title: `Period ${n}: ${KIND_WORD[kind]}`,
      });
      continue;
    }
    // The first unsettled period is the only one that can be actionable, and
    // only if the chain says so — `action` is computed against the chain's own
    // clock, so the UI never decides "due" for itself.
    const isNext = n === detail.periods_settled + 1;
    const due = isNext && detail.action !== "";
    cells.push({
      key: `p${n}`,
      kind: due ? "due" : "pending",
      label: String(n),
      title: due
        ? `Period ${n}: ${detail.action === "LAPSED" ? "past its grace window" : "due now"}`
        : `Period ${n}: not yet due`,
    });
  }
  return cells;
}

/** Grouped by outcome, not by time. See the note at the top of this file. */
export function tallyRail(summary: CommitmentSummary): Cell[] {
  const cells: Cell[] = [];
  const push = (kind: CellKind, count: number) => {
    for (let i = 0; i < count; i++) {
      cells.push({
        key: `${kind}${i}`,
        kind,
        label: "",
        title: `${count} ${KIND_WORD[kind]}`,
      });
    }
  };

  push("kept", summary.periods_met);
  push("broken", summary.periods_failed);
  push("lapse", summary.periods_lapsed);
  push("unclear", summary.periods_inconclusive);

  const actionable = summary.action === "" ? 0 : 1;
  push("due", actionable);
  push("pending", Math.max(0, summary.periods_remaining - actionable));

  return cells;
}

/** "3 kept · 1 broken · 2 to go", skipping anything at zero. */
export function tallyWords(summary: CommitmentSummary): string {
  const parts: string[] = [];
  if (summary.periods_met) parts.push(`${summary.periods_met} kept`);
  if (summary.periods_failed) parts.push(`${summary.periods_failed} broken`);
  if (summary.periods_lapsed) parts.push(`${summary.periods_lapsed} unverified`);
  if (summary.periods_inconclusive) parts.push(`${summary.periods_inconclusive} inconclusive`);
  if (summary.periods_remaining) parts.push(`${summary.periods_remaining} to go`);
  return parts.length ? parts.join(" · ") : "nothing settled yet";
}
