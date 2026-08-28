import type { Status, Verdict } from "@/types";

/**
 * COMPLETED is deliberately NOT green.
 *
 * It means the commitment ran out of funded periods, not that the promise was
 * kept — a commitment whose every period came back inconclusive closes
 * COMPLETED too. Colouring it as kept would read as a verdict the network never
 * reached. The rail carries the verdicts; this only carries the lifecycle.
 */
const STATUS_STYLE: Record<Status, string> = {
  ACTIVE: "pill-accent",
  COMPLETED: "pill-neutral",
  FAILED: "pill-broken",
  CANCELED: "pill-neutral",
};

/**
 * COMPLETED is not "kept" and FAILED is not "broken" — they are how the
 * commitment CLOSED. A commitment that met one period and broke three still
 * closes COMPLETED (NOTES.md § Recurring lifecycle), so the words stay
 * deliberately about the lifecycle and the rail carries the verdicts.
 */
const STATUS_WORD: Record<Status, string> = {
  ACTIVE: "Active",
  COMPLETED: "Closed",
  FAILED: "Failed",
  CANCELED: "Cancelled",
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill ${STATUS_STYLE[status]}`}>{STATUS_WORD[status]}</span>;
}

const VERDICT_STYLE: Record<Verdict, string> = {
  MET: "pill-kept",
  NOT_MET: "pill-broken",
  INCONCLUSIVE: "pill-neutral",
  LAPSED: "pill-lapse",
};

const VERDICT_WORD: Record<Verdict, string> = {
  MET: "Kept",
  NOT_MET: "Broken",
  INCONCLUSIVE: "Inconclusive",
  LAPSED: "Unverified",
};

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  return <span className={`pill ${VERDICT_STYLE[verdict]}`}>{VERDICT_WORD[verdict]}</span>;
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "kept" | "broken" | "lapse";
  children: React.ReactNode;
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
