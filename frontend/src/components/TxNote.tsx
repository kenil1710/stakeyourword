"use client";

import { CircleAlert, CircleCheck, ExternalLink, Info } from "lucide-react";
import type { TxState } from "@/hooks/useTx";
import { explorerUrl } from "@/lib/genlayer";
import { gen } from "@/lib/format";

/**
 * The outcome of a write, in three flavours that must not be collapsed.
 *
 * `rejected` is the one that matters: the transaction SUCCEEDED and the
 * contract sent the money back. Showing it as an error would be wrong (nothing
 * failed) and showing it as a success would be worse (the promise does not
 * exist). It gets its own voice — the reason, and the amount returned.
 */
export function TxNote({ tx, doneLabel }: { tx: TxState; doneLabel?: string }) {
  if (tx.phase === "idle" || tx.phase === "sending") return null;

  const tone =
    tx.phase === "done"
      ? "border-kept/40 bg-kept-soft/50"
      : tx.phase === "rejected"
        ? "border-accent/40 bg-accent-soft/50"
        : "border-broken/40 bg-broken-soft/40";

  return (
    <div className={`card-flat mt-4 p-4 ${tone}`} role="status">
      <div className="flex items-start gap-2.5">
        {tx.phase === "done" ? (
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-kept" aria-hidden />
        ) : tx.phase === "rejected" ? (
          <Info size={16} className="mt-0.5 shrink-0 text-accent-ink" aria-hidden />
        ) : (
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-broken" aria-hidden />
        )}

        <div className="min-w-0 flex-1">
          {tx.phase === "done" ? (
            <p className="text-[13.5px] font-semibold text-ink">{doneLabel ?? "Done."}</p>
          ) : null}

          {tx.phase === "rejected" ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink">
                The contract turned this down and sent your stake back.
              </p>
              <p className="mt-1 text-[13px] text-ink-2">{tx.reason}</p>
              {tx.refunded && tx.refunded !== "0" ? (
                <p className="hint mt-1">Refunded {gen(tx.refunded)}.</p>
              ) : null}
            </>
          ) : null}

          {tx.phase === "error" ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink">That transaction did not go through.</p>
              <p className="mono mt-1 text-[12px] leading-relaxed break-words text-ink-2">
                {tx.error}
              </p>
            </>
          ) : null}

          {tx.hash ? (
            <a
              className="link-quiet mono mt-2 inline-flex items-center gap-1 text-[11.5px]"
              href={explorerUrl("tx", tx.hash)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {tx.hash.slice(0, 18)}…
              <ExternalLink size={11} aria-hidden />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
