"use client";

/**
 * Contract reads, and the clock they carry.
 *
 * Every read goes through SWR so a page that needs the same view twice makes
 * one request. Nothing fetches during prerender: SWR fetches from an effect,
 * so the server and the first client render both see `undefined` and agree.
 */
import useSWR, { useSWRConfig } from "swr";
import { useSyncExternalStore } from "react";
import * as api from "@/lib/contract";
import type { CommitmentSummary, Stats } from "@/types";

/** Long enough not to spend Studio's per-day quota on an idle tab. */
const POLL_MS = 20_000;
const FAST_POLL_MS = 10_000;

const shared = {
  revalidateOnFocus: true,
  shouldRetryOnError: true,
  errorRetryCount: 3,
} as const;

/**
 * `get_stats` plus the local time the answer arrived.
 *
 * The timestamp is attached HERE, in the fetcher, rather than recorded by an
 * effect once the data lands. It is a property of the read — the moment the
 * chain's clock was observed — so it belongs to the value, and carrying it that
 * way keeps `useChainNow` a pure function of data with no state of its own.
 */
export interface StatsSnapshot extends Stats {
  /** `Date.now()` when this read came back. Milliseconds, local clock. */
  readAt: number;
}

async function fetchStats(): Promise<StatsSnapshot> {
  const stats = await api.getStats();
  return { ...stats, readAt: Date.now() };
}

export function useStats() {
  return useSWR("stats", fetchStats, { ...shared, refreshInterval: POLL_MS });
}

export function useRecent(count = 12) {
  return useSWR(["recent", count], () => api.getRecentCommitments(count), {
    ...shared,
    refreshInterval: POLL_MS,
  });
}

export function useActive() {
  return useSWR("active", api.getActiveCommitments, { ...shared, refreshInterval: POLL_MS });
}

/** The bounty board polls faster: its rows are money nobody has claimed yet. */
export function useVerifiable() {
  return useSWR("verifiable", api.getVerifiableNow, {
    ...shared,
    refreshInterval: FAST_POLL_MS,
  });
}

export function useCommitment(id: number | null) {
  return useSWR(id === null ? null : ["commitment", id], () => api.getCommitment(id!), {
    ...shared,
    refreshInterval: FAST_POLL_MS,
  });
}

export function useTrackRecord(address: string | null) {
  return useSWR(address ? ["track", address.toLowerCase()] : null, () => api.getTrackRecord(address!), shared);
}

export function useUserCommitments(address: string | null) {
  return useSWR(
    address ? ["byUser", address.toLowerCase()] : null,
    () => api.getUserCommitments(address!),
    { ...shared, refreshInterval: POLL_MS },
  );
}

export function useBeneficiaryCommitments(address: string | null) {
  return useSWR(
    address ? ["byBeneficiary", address.toLowerCase()] : null,
    () => api.getBeneficiaryCommitments(address!),
    shared,
  );
}

/**
 * A one-second tick, shared by every countdown on the page.
 *
 * One interval for the whole app rather than one per component, and read
 * through `useSyncExternalStore` so the tick lives outside React instead of
 * being pushed in by an effect. `getServerSecond` returns 0 so server and
 * hydration renders agree — nothing time-shaped is drawn from it anyway,
 * because `useChainNow` returns null until a read has landed.
 */
let second = typeof window === "undefined" ? 0 : Math.floor(Date.now() / 1000);
const tickers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function subscribeSecond(onChange: () => void): () => void {
  tickers.add(onChange);
  if (ticker === null) {
    second = Math.floor(Date.now() / 1000);
    ticker = setInterval(() => {
      second = Math.floor(Date.now() / 1000);
      for (const fn of tickers) fn();
    }, 1000);
  }
  return () => {
    tickers.delete(onChange);
    if (tickers.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

const getSecond = () => second;
const getServerSecond = () => 0;

/**
 * The chain's clock, ticking locally between reads.
 *
 * Countdowns must not run on the browser's clock: a machine a few minutes fast
 * would show a period as due before the contract agrees, and the verify button
 * would revert on a deadline the user could see had passed. So the base is
 * `get_stats().now` and only the DELTA since that read is measured locally — a
 * wrong wall clock no longer matters, just a wrong tick rate.
 *
 * Null until the first read lands, so nothing time-dependent renders before
 * there is a real chain time to render it from.
 */
export function useChainNow(): number | null {
  const { data } = useStats();
  const now = useSyncExternalStore(subscribeSecond, getSecond, getServerSecond);
  if (!data) return null;
  // Clamped: a read that lands a moment in the "future" of the last tick must
  // never run a countdown backwards.
  const elapsed = Math.max(0, now - Math.floor(data.readAt / 1000));
  return data.now + elapsed;
}

/**
 * Invalidate every read after a write.
 *
 * A settled transaction has changed something on almost every view — a new
 * commitment moves the stats, the recent list and the author's profile at once
 * — and chasing exactly which keys went stale is how a UI ends up showing a
 * bounty that was claimed two minutes ago.
 */
export function useRefreshAll() {
  const { mutate } = useSWRConfig();
  return () => mutate(() => true, undefined, { revalidate: true });
}

/** Newest first, by id. The chain's list order is an implementation detail. */
export function byNewest(rows: CommitmentSummary[]): CommitmentSummary[] {
  return [...rows].sort((a, b) => b.id - a.id);
}
