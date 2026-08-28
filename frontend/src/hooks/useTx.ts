"use client";

/**
 * One write, tracked from click to settlement.
 *
 * The important state is `rejected`. StakeYourWord's payable methods refund and
 * return `{ok: false}` rather than reverting — a revert would roll back the
 * refund and keep the stake (contracts/NOTES.md § Money) — so a rejection
 * arrives as a perfectly successful transaction. A UI that only watches for
 * thrown errors would show "committed!" over a refund. Hence the third
 * terminal state, distinct from both success and failure.
 */
import { useCallback, useState } from "react";
import { asWriteResult } from "@/lib/contract";
import { messageOf } from "@/components/WalletProvider";
import { useRefreshAll } from "./useChain";

export type TxPhase = "idle" | "sending" | "done" | "rejected" | "error";

export interface TxState {
  phase: TxPhase;
  hash: string | null;
  /** Set only in the `rejected` phase: why the contract refunded. */
  reason: string | null;
  /** Wei refunded, as a decimal string. Only in `rejected`. */
  refunded: string | null;
  /** Whatever the method returned, on success. */
  returned: unknown;
  error: string | null;
}

const IDLE: TxState = {
  phase: "idle",
  hash: null,
  reason: null,
  refunded: null,
  returned: null,
  error: null,
};

type Submit = () => Promise<{ hash: string; returned: unknown }>;

export function useTx() {
  const [state, setState] = useState<TxState>(IDLE);
  const refreshAll = useRefreshAll();

  const run = useCallback(
    async (submit: Submit): Promise<TxState> => {
      setState({ ...IDLE, phase: "sending" });
      let settled: TxState;
      try {
        const { hash, returned } = await submit();
        const result = asWriteResult(returned);
        settled =
          result && result.ok === false
            ? {
                ...IDLE,
                phase: "rejected",
                hash,
                reason: result.reason,
                refunded: result.refunded,
              }
            // `returned` holds the PARSED result when the method returned a
            // WriteResult, so callers read `.id` rather than re-parsing. A
            // method that returns something else (a bare verdict string) is
            // passed through untouched.
            : { ...IDLE, phase: "done", hash, returned: result ?? returned };
      } catch (e) {
        const message = messageOf(e);
        // An empty message is the user closing the wallet dialog. That is not a
        // failure to report — it is the absence of an attempt.
        settled = message ? { ...IDLE, phase: "error", error: message } : IDLE;
      }

      setState(settled);
      // Even a rejection moved money (the refund) and burned a nonce, so every
      // terminal state that reached the chain invalidates the reads.
      if (settled.phase !== "idle" && settled.phase !== "error") refreshAll();
      return settled;
    },
    [refreshAll],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, busy: state.phase === "sending", run, reset };
}
