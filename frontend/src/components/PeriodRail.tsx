"use client";

/**
 * The signature device: one chip per period, in order, left to right.
 *
 * It appears at three sizes and never means anything other than periods. The
 * only animation in the product lives on the one chip asking to be acted on.
 */
import type { Cell } from "@/lib/periods";

const SIZE = { lg: "chip-lg", md: "chip-md", sm: "chip-sm" } as const;

const KIND = {
  kept: "chip-kept",
  broken: "chip-broken",
  lapse: "chip-lapse",
  unclear: "chip-unclear",
  due: "chip-due",
  pending: "chip-pending",
} as const;

export function PeriodRail({
  cells,
  size = "md",
  live = false,
  label = "Periods",
}: {
  cells: Cell[];
  size?: keyof typeof SIZE;
  /** Pulse the due chip. Only ever true where the action is actually offered. */
  live?: boolean;
  label?: string;
}) {
  if (!cells.length) return null;
  return (
    <div className="rail scroll-x" role="list" aria-label={label}>
      {cells.map((cell) => (
        <div
          key={cell.key}
          role="listitem"
          title={cell.title}
          aria-label={cell.title}
          className={`chip ${SIZE[size]} ${KIND[cell.kind]} ${
            live && cell.kind === "due" ? "chip-due-live" : ""
          }`}
        >
          {size === "sm" ? "" : cell.label}
        </div>
      ))}
    </div>
  );
}

/** The rail's key. Rendered once per page at most, never beside every rail. */
export function RailLegend() {
  const items: Array<[keyof typeof KIND, string]> = [
    ["kept", "Kept"],
    ["broken", "Broken"],
    ["unclear", "Inconclusive"],
    ["lapse", "Unverified"],
    ["due", "Due now"],
    ["pending", "Ahead"],
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {items.map(([kind, text]) => (
        <li key={kind} className="flex items-center gap-1.5">
          <span className={`chip chip-sm ${KIND[kind]}`} aria-hidden />
          <span className="text-[12px] text-muted">{text}</span>
        </li>
      ))}
    </ul>
  );
}
