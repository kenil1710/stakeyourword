/**
 * Formatting for wei, clocks and addresses.
 *
 * Wei is always a bigint or a decimal string here. `Number` is never allowed
 * near a stake: 0.1 GEN is 10^17, and the moment that becomes a float the last
 * digits are gone. The contract sends every amount as a string for exactly this
 * reason — see contracts/NOTES.md on why `format(f, '.18f')` is unavailable
 * on chain and all decimal work happens here instead.
 */

const WEI_PER_GEN = 10n ** 18n;

/** Parse a user-typed GEN amount into wei without ever touching a float. */
export function parseGen(input: string): bigint | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d*\.?\d*$/.test(text) || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > 18) return null;
  const padded = frac.padEnd(18, "0");
  try {
    return BigInt(whole || "0") * WEI_PER_GEN + BigInt(padded || "0");
  } catch {
    return null;
  }
}

/**
 * Wei to a GEN string, trimmed of trailing zeros.
 *
 * `maxDecimals` caps the display, but a non-zero amount never renders as "0" —
 * it falls back to a "< 0.0001" form, because showing a real stake as nothing
 * is worse than showing an imprecise one.
 */
export function formatGen(wei: bigint | string, maxDecimals = 4): string {
  const value = typeof wei === "string" ? BigInt(wei || "0") : wei;
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = abs / WEI_PER_GEN;
  const frac = abs % WEI_PER_GEN;
  const fracText = frac.toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");

  if (whole === 0n && fracText === "" && abs > 0n) {
    const smallest = `0.${"0".repeat(maxDecimals - 1)}1`;
    return `${negative ? "-" : ""}< ${smallest}`;
  }
  const body = fracText ? `${whole}.${fracText}` : whole.toString();
  return `${negative ? "-" : ""}${body}`;
}

/** Wei to "0.1 GEN". */
export function gen(wei: bigint | string, maxDecimals = 4): string {
  return `${formatGen(wei, maxDecimals)} GEN`;
}

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  if (!address || address.length < 12) return address ?? "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** A duration in seconds as "3d 4h", "12m", "45s". Two units at most. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < MINUTE) return `${total}s`;
  if (total < HOUR) {
    const m = Math.floor(total / MINUTE);
    const s = total % MINUTE;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  if (total < DAY) {
    const h = Math.floor(total / HOUR);
    const m = Math.floor((total % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** "in 3d 4h" / "4h ago", relative to the CHAIN's clock, not the browser's. */
export function relative(epoch: number, now: number): string {
  if (!epoch) return "—";
  const delta = epoch - now;
  return delta >= 0 ? `in ${duration(delta)}` : `${duration(-delta)} ago`;
}

/** An absolute UTC stamp, for anything that needs to be unambiguous. */
export function absolute(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/** A period length in seconds as the label a person would use. */
export function periodLabel(seconds: number): string {
  if (seconds === DAY) return "daily";
  if (seconds === 7 * DAY) return "weekly";
  if (seconds === 30 * DAY) return "monthly";
  return `every ${duration(seconds)}`;
}

/** Basis points as a whole-number percentage. */
export function pct(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}
