"use client";

/**
 * One write, tracked from the estimate to finalization — and handed to the user
 * to drive, not to a background loop to hide.
 *
 * Three things this has to get right that a naive version does not:
 *
 * 1. THE PREFLIGHT COMES FIRST. A write is quoted and balance-checked before
 *    the wallet dialog opens, so an unaffordable call is refused here with a
 *    sentence naming the shortfall instead of reverting on chain with
 *    `LackOfFundForMaxFee`. `blocked` is that state, and it is not an error:
 *    nothing was signed and nothing was spent.
 *
 * 2. `rejected` IS NOT FAILURE. StakeYourWord's payable methods refund and
 *    return `{ok: false}` rather than reverting — a revert would roll back the
 *    refund and keep the stake (contracts/NOTES.md § Money) — so a rejection
 *    arrives as a perfectly successful transaction. A UI that only watches for
 *    thrown errors would show "committed!" over a refund.
 *
 * 3. THE HASH APPEARS IMMEDIATELY, and the phases after it are real. `pending`,
 *    `accepted` and `finalized` are distinct because they mean different
 *    things: accepted is when state applies and the money is decided, finalized
 *    is when it stops being reversible. Collapsing them into "done" tells
 *    someone their payout has landed while it is still in flight.
 *
 * Polling stops on its own after `WATCH_MS`. What it does not do is give up:
 * the state becomes `stuck`, and the user gets Check status / Nudge / Retry.
 * The test harness has always had `finalizeIdlenessTxs`; the point of this hook
 * is that a person with a browser now has it too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  asWriteResult,
  nudgeTx,
  pollTx,
  quote as quoteCall,
  submitWrite,
  type TxSnapshot,
} from "@/lib/contract";
import type { WriteCall, Quote } from "@/lib/fees";
import { explainChainError } from "@/lib/fees";
import { useRefreshAll } from "./useChain";

export type TxPhase =
  /** Nothing in flight. */
  | "idle"
  /** Estimating the fee and checking the balance. No wallet dialog yet. */
  | "checking"
  /** Refused before signing — cannot afford it. `reason` says by how much. */
  | "blocked"
  /**
   * The simulation says the contract would refuse, but the simulation's clock
   * is not the chain's — so this is a warning, not a refusal. `reason` carries
   * the contract's own message and `retry()` sends it anyway.
   */
  | "warned"
  /** The wallet dialog is open. */
  | "signing"
  /** Submitted. `hash` is set. Consensus has not decided yet. */
  | "pending"
  /** Decided and applied. The money has moved; finalization is still pending. */
  | "accepted"
  /** Irreversible. */
  | "finalized"
  /** The contract refunded and returned ok:false. A SUCCESSFUL transaction. */
  | "rejected"
  /** The transaction reverted, or never made it out. `error` says why. */
  | "error";

export interface TxState {
  phase: TxPhase;
  hash: string | null;
  /** The chain's own status name, verbatim, for the receipt line. */
  status: string | null;
  /** Why the contract refunded (`rejected`), or why the preflight refused. */
  reason: string | null;
  /** Wei refunded, as a decimal string. Only in `rejected`. */
  refunded: string | null;
  /** Whatever the method returned, on success. */
  returned: unknown;
  error: string | null;
  /** The estimate this write was submitted with. Kept for the receipt. */
  quote: Quote | null;
  /** True once a pending transaction has outlived the watch window. */
  stuck: boolean;
  /** How many times the user has nudged this transaction. */
  nudges: number;
  /** Seconds since submission. Drives the "this is taking a while" copy. */
  elapsed: number;
}

const IDLE: TxState = {
  phase: "idle",
  hash: null,
  status: null,
  reason: null,
  refunded: null,
  returned: null,
  error: null,
  quote: null,
  stuck: false,
  nudges: 0,
  elapsed: 0,
};

/** How long to poll before handing the controls over. */
const WATCH_MS = 240_000;
const POLL_MS = 4_000;

export function useTx() {
  const [state, setState] = useState<TxState>(IDLE);
  const refreshAll = useRefreshAll();

  /*
   * The call and the account are kept in refs, not state, so Retry can rebuild
   * the SAME write without the component having to hold it — and so the poll
   * loop below can read them without being torn down and restarted on every
   * phase change.
   */
  const lastCall = useRef<{ account: `0x${string}`; call: WriteCall } | null>(null);
  /** The simulated revert already shown, so it interrupts once and not twice. */
  const warnedFor = useRef<string>("");
  const startedAt = useRef<number>(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const apply = useCallback(
    (snap: TxSnapshot, hash: string): TxState | null => {
      if (!snap.answered) return null;

      if (snap.reverted) {
        return {
          ...IDLE,
          phase: "error",
          hash,
          status: snap.status,
          quote: null,
          error: explainChainError(snap.reason) || snap.reason || "The transaction reverted.",
        };
      }
      if (snap.undetermined) {
        return {
          ...IDLE,
          phase: "error",
          hash,
          status: snap.status,
          error:
            "The validators could not agree, so nothing was applied and nothing was spent from " +
            "the stake. Retrying is safe.",
        };
      }
      if (!snap.decided) return null;

      // A rejection is a SUCCESSFUL transaction whose return value says so.
      const result = asWriteResult(snap.returned);
      if (result && result.ok === false) {
        return {
          ...IDLE,
          phase: "rejected",
          hash,
          status: snap.status,
          reason: result.reason,
          refunded: result.refunded,
        };
      }
      return {
        ...IDLE,
        phase: snap.finalized ? "finalized" : "accepted",
        hash,
        status: snap.status,
        // `returned` holds the PARSED result when the method returned a
        // WriteResult, so callers read `.id` rather than re-parsing.
        returned: result ?? snap.returned,
      };
    },
    [],
  );

  /* ── The watch loop ─────────────────────────────────────────────────────
   * Runs only while a transaction is in flight, and stops itself at WATCH_MS
   * rather than polling an endpoint forever behind a tab nobody is looking at.
   */
  useEffect(() => {
    const { phase, hash } = state;
    if (!hash) return;
    if (phase !== "pending" && phase !== "accepted") return;
    if (state.stuck) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      if (cancelled || !live.current) return;

      const snap = await pollTx(hash);
      if (cancelled || !live.current) return;

      const next = apply(snap, hash);
      if (next) {
        setState({ ...next, quote: state.quote, nudges: state.nudges, elapsed });
        if (next.phase !== "error") refreshAll();
        return;
      }
      // Still in flight. Keep the clock honest, and surrender the controls
      // once the watch window is up.
      setState((prev) =>
        prev.hash === hash
          ? {
              ...prev,
              status: snap.status ?? prev.status,
              elapsed,
              stuck: Date.now() - startedAt.current > WATCH_MS,
            }
          : prev,
      );
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state, apply, refreshAll]);

  /** Quote, preflight, sign, submit. Returns the state it settled into. */
  const run = useCallback(
    async (account: `0x${string}`, call: WriteCall): Promise<TxState> => {
      lastCall.current = { account, call };
      setState({ ...IDLE, phase: "checking" });

      let quoted: Quote;
      try {
        quoted = await quoteCall(account, call);
      } catch (e) {
        const settled: TxState = {
          ...IDLE,
          phase: "error",
          error:
            explainChainError(e) ||
            "The fee estimate failed, so nothing was sent. The network may be busy — try again.",
        };
        setState(settled);
        return settled;
      }

      if (!quoted.ok) {
        // Refused BEFORE the wallet opens. Nothing signed, nothing spent.
        const settled: TxState = {
          ...IDLE,
          phase: "blocked",
          quote: quoted,
          reason: quoted.reason,
        };
        setState(settled);
        return settled;
      }

      /*
       * A simulated revert is shown ONCE and then overridable.
       *
       * It cannot be treated as a refusal — the simulator's clock runs hundreds
       * of days behind the chain's, so every time gate in this contract reads
       * wrong under simulation and a period that IS due looks "not due yet".
       * But it is usually right about everything else, and spending a fee to
       * discover the contract says no is worse than being asked.
       *
       * `warnedFor` makes it a one-time interruption: pressing "send it anyway"
       * runs the same call and this branch stands aside.
       */
      if (quoted.wouldRevert && warnedFor.current !== quoted.wouldRevert) {
        warnedFor.current = quoted.wouldRevert;
        const settled: TxState = {
          ...IDLE,
          phase: "warned",
          quote: quoted,
          reason: quoted.wouldRevert,
        };
        setState(settled);
        return settled;
      }

      setState({ ...IDLE, phase: "signing", quote: quoted });

      let hash: `0x${string}`;
      try {
        hash = await submitWrite(account, call, quoted.fees);
      } catch (e) {
        const message = String((e as { message?: string })?.message ?? e ?? "");
        // An empty message, or an explicit rejection, is the user closing the
        // wallet dialog. That is not a failure to report — it is the absence
        // of an attempt.
        if (!message || /user rejected|User denied|ACTION_REJECTED|\b4001\b/i.test(message)) {
          setState(IDLE);
          return IDLE;
        }
        const settled: TxState = {
          ...IDLE,
          phase: "error",
          quote: quoted,
          error: explainChainError(e) || message,
        };
        setState(settled);
        return settled;
      }

      startedAt.current = Date.now();
      const submitted: TxState = { ...IDLE, phase: "pending", hash, status: "SUBMITTED", quote: quoted };
      setState(submitted);
      return submitted;
    },
    [],
  );

  /** One poll, on demand. The "Check status" button. */
  const check = useCallback(async (): Promise<void> => {
    const hash = state.hash;
    if (!hash) return;
    const snap = await pollTx(hash);
    const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
    if (!snap.answered) {
      setState((prev) => ({ ...prev, elapsed }));
      return;
    }
    const next = apply(snap, hash);
    if (next) {
      setState({ ...next, quote: state.quote, nudges: state.nudges, elapsed });
      if (next.phase !== "error") refreshAll();
      return;
    }
    setState((prev) => ({ ...prev, status: snap.status ?? prev.status, elapsed }));
  }, [state.hash, state.quote, state.nudges, apply, refreshAll]);

  /**
   * Ask the network to move a transaction that has stopped moving.
   *
   * This is itself a transaction, so it opens a second wallet dialog — which is
   * precisely why it is a button the user presses rather than something the app
   * does behind their back.
   */
  const nudge = useCallback(async (): Promise<void> => {
    const hash = state.hash;
    const account = lastCall.current?.account;
    if (!hash || !account) return;
    try {
      await nudgeTx(account, hash);
      setState((prev) => ({ ...prev, nudges: prev.nudges + 1, stuck: false }));
      startedAt.current = Date.now() - WATCH_MS / 2;
    } catch (e) {
      const message = String((e as { message?: string })?.message ?? e ?? "");
      if (!message || /user rejected|User denied|ACTION_REJECTED|\b4001\b/i.test(message)) return;
      setState((prev) => ({ ...prev, error: explainChainError(e) || message }));
    }
  }, [state.hash]);

  /** Submit the same call again, with a fresh estimate. */
  const retry = useCallback(async (): Promise<TxState> => {
    const last = lastCall.current;
    if (!last) return state;
    return run(last.account, last.call);
  }, [run, state]);

  const reset = useCallback(() => {
    lastCall.current = null;
    warnedFor.current = "";
    setState(IDLE);
  }, []);

  return {
    ...state,
    /** True while the user cannot start another write. */
    busy: state.phase === "checking" || state.phase === "signing" || state.phase === "pending",
    /** True once the write has landed one way or another. */
    settled:
      state.phase === "accepted" ||
      state.phase === "finalized" ||
      state.phase === "rejected" ||
      state.phase === "error",
    run,
    check,
    nudge,
    retry,
    reset,
  };
}
