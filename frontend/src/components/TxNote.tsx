"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
  Wallet,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type { TxState } from "@/hooks/useTx";
import { explorerUrl } from "@/lib/genlayer";
import { gen } from "@/lib/format";

/**
 * The receipt: what happened, what it cost, and what you can still do about it.
 *
 * Five outcomes that must not be collapsed into two:
 *
 *   blocked   — refused before signing. Nothing was sent, nothing was spent.
 *               The message names the shortfall.
 *   pending   — submitted, hash known, consensus undecided.
 *   accepted  — decided and applied. The money has moved.
 *   finalized — irreversible.
 *   rejected  — the transaction SUCCEEDED and the contract sent the stake back.
 *               Showing it as an error would be wrong (nothing failed);
 *               showing it as a success would be worse (the promise does not
 *               exist).
 *
 * While a transaction is in flight the user gets the controls, not a spinner
 * with no exit: Check status polls on demand, Nudge asks the network to move a
 * transaction that has parked, Retry re-submits with a fresh estimate.
 */
export function TxNote({
  tx,
  doneLabel,
  onCheck,
  onNudge,
  onRetry,
}: {
  tx: TxState;
  doneLabel?: string;
  onCheck?: () => void;
  onNudge?: () => void;
  onRetry?: () => void;
}) {
  if (tx.phase === "idle") return null;

  const tone =
    tx.phase === "finalized" || tx.phase === "accepted"
      ? "border-kept/40 bg-kept-soft/50"
      : tx.phase === "rejected" || tx.phase === "blocked" || tx.phase === "warned"
        ? "border-accent/40 bg-accent-soft/50"
        : tx.phase === "error"
          ? "border-broken/40 bg-broken-soft/40"
          : "border-rule bg-surface-2";

  return (
    <div className={`card-flat mt-4 p-4 ${tone}`} role="status" aria-live="polite">
      <div className="flex items-start gap-2.5">
        <Icon phase={tx.phase} />

        <div className="min-w-0 flex-1">
          <Headline tx={tx} doneLabel={doneLabel} />
          <Steps tx={tx} />
          <HashLine hash={tx.hash} />
          <Controls tx={tx} onCheck={onCheck} onNudge={onNudge} onRetry={onRetry} />
        </div>
      </div>
    </div>
  );
}

function Icon({ phase }: { phase: TxState["phase"] }) {
  const common = "mt-0.5 shrink-0";
  if (phase === "finalized" || phase === "accepted")
    return <CircleCheck size={16} className={`${common} text-kept`} aria-hidden />;
  if (phase === "rejected" || phase === "blocked" || phase === "warned")
    return <Info size={16} className={`${common} text-accent-ink`} aria-hidden />;
  if (phase === "error")
    return <CircleAlert size={16} className={`${common} text-broken`} aria-hidden />;
  return <LoaderCircle size={16} className={`${common} animate-spin text-muted`} aria-hidden />;
}

function Headline({ tx, doneLabel }: { tx: TxState; doneLabel?: string }) {
  switch (tx.phase) {
    case "checking":
      return <Line>Estimating the fee and checking your balance…</Line>;

    case "blocked":
      return (
        <>
          <Line>Not sent — this wallet cannot cover it.</Line>
          <p className="mt-1 text-[13px] text-ink-2">{tx.reason}</p>
          <p className="hint mt-1.5">
            Nothing was signed and nothing was spent. Top the wallet up and try again.
          </p>
        </>
      );

    case "warned":
      return (
        <>
          <Line>The network expects the contract to turn this down.</Line>
          <p className="mt-1 text-[13px] text-ink-2">{tx.reason}</p>
          {/*
            * Advisory, and it says so. The fee simulation runs on a clock
            * hundreds of days behind the chain's, so anything the contract
            * gates on time reads wrong here — a period that IS due simulates
            * as "not due yet". Sending anyway lets the real transaction, with
            * the real clock, be the authority.
            */}
          <p className="hint mt-1.5">
            This came from a simulation whose clock runs behind the chain&apos;s, so anything
            timing-related may be wrong. You can send it anyway and let the real transaction
            decide.
          </p>
        </>
      );

    case "signing":
      return (
        <>
          <Line>Waiting for you to confirm in your wallet…</Line>
          {tx.quote ? (
            <p className="hint mt-1">
              {tx.quote.userValue > 0n ? `${gen(tx.quote.userValue)} of stake plus ` : ""}
              {gen(tx.quote.feeValue)} of network fees.
            </p>
          ) : null}
        </>
      );

    case "pending":
      return (
        <>
          <Line>Submitted. Waiting for the validators.</Line>
          <p className="hint mt-1">
            {tx.elapsed > 0 ? `${tx.elapsed}s so far. ` : ""}
            Each validator fetches the proof independently, so this takes a minute or two.
          </p>
        </>
      );

    case "accepted":
      return (
        <>
          <Line>{doneLabel ?? "Done."}</Line>
          <p className="hint mt-1">
            Accepted — the state is applied and the money is decided. It is not finalized yet, so
            payouts are still landing.
          </p>
        </>
      );

    case "finalized":
      return (
        <>
          <Line>{doneLabel ?? "Done."}</Line>
          <p className="hint mt-1">Finalized. This is now irreversible.</p>
        </>
      );

    case "rejected":
      return (
        <>
          <Line>The contract turned this down and sent your stake back.</Line>
          <p className="mt-1 text-[13px] text-ink-2">{tx.reason}</p>
          {tx.refunded && tx.refunded !== "0" ? (
            <p className="hint mt-1">Refunded {gen(tx.refunded)}.</p>
          ) : null}
        </>
      );

    case "error":
      return (
        <>
          <Line>That transaction did not go through.</Line>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{tx.error}</p>
        </>
      );

    default:
      return null;
  }
}

const Line = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[13.5px] font-semibold text-ink">{children}</p>
);

/**
 * pending → accepted → finalized, drawn as three states rather than described
 * in prose, because "accepted but not finalized" is the one a user has to be
 * able to see at a glance.
 */
function Steps({ tx }: { tx: TxState }) {
  const shown = ["pending", "accepted", "finalized", "rejected"];
  if (!shown.includes(tx.phase)) return null;

  const reached = (step: "pending" | "accepted" | "finalized") => {
    if (step === "pending") return true;
    if (step === "accepted") return tx.phase !== "pending";
    return tx.phase === "finalized";
  };

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {(["pending", "accepted", "finalized"] as const).map((step, i) => (
        <span key={step} className="flex items-center gap-1.5">
          {i > 0 ? <span className="text-muted" aria-hidden>→</span> : null}
          <span
            className={`mono inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] uppercase tracking-wide ${
              reached(step)
                ? "border-kept/40 bg-kept-soft/60 text-ink"
                : "border-rule text-muted"
            }`}
          >
            {reached(step) ? (
              <CircleCheck size={10} aria-hidden />
            ) : (
              <CircleDashed size={10} aria-hidden />
            )}
            {step}
          </span>
        </span>
      ))}
      {tx.status ? <span className="hint ml-1">chain says {tx.status}</span> : null}
    </div>
  );
}

/**
 * The hash, shown the moment it exists.
 *
 * Copyable text rather than only a link, because Studio Devnet ships no block
 * explorer — `explorerUrl` returns null there, and a dead link is worse than a
 * string you can paste into whatever you do have.
 */
function HashLine({ hash }: { hash: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!hash) return null;
  const href = explorerUrl("tx", hash);

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      <code className="mono rounded bg-surface-2 px-1.5 py-0.5 text-[11.5px] break-all text-ink-2">
        {hash}
      </code>
      <button
        type="button"
        className="link-quiet inline-flex items-center gap-1 text-[11.5px]"
        onClick={() => {
          navigator.clipboard?.writeText(hash).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => undefined,
          );
        }}
      >
        <Copy size={11} aria-hidden />
        {copied ? "Copied" : "Copy"}
      </button>
      {href ? (
        <a
          className="link-quiet inline-flex items-center gap-1 text-[11.5px]"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
        >
          Explorer
          <ExternalLink size={11} aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

/**
 * The controls, and the point of the whole exercise: the lifecycle belongs to
 * the person who signed the transaction, not to a test harness.
 */
function Controls({
  tx,
  onCheck,
  onNudge,
  onRetry,
}: {
  tx: TxState;
  onCheck?: () => void;
  onNudge?: () => void;
  onRetry?: () => void;
}) {
  const inFlight = tx.phase === "pending" || tx.phase === "accepted";
  const canRetry = tx.phase === "error" || tx.phase === "blocked" || tx.phase === "warned";
  if (!inFlight && !canRetry) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {inFlight && onCheck ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCheck}>
          <RefreshCw size={13} aria-hidden />
          Check status
        </button>
      ) : null}

      {inFlight && tx.phase === "pending" && onNudge ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onNudge}>
          <Zap size={13} aria-hidden />
          {tx.stuck ? "Speed it up" : "Nudge it along"}
        </button>
      ) : null}

      {canRetry && onRetry ? (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
          {tx.phase === "blocked" ? <Wallet size={13} aria-hidden /> : <RefreshCw size={13} aria-hidden />}
          {tx.phase === "blocked" ? "Check again" : tx.phase === "warned" ? "Send it anyway" : "Retry"}
        </button>
      ) : null}

      {tx.stuck && tx.phase === "pending" ? (
        <p className="hint w-full">
          This has been in flight for {tx.elapsed}s. Consensus parks a transaction when a validator
          round does not complete; nudging asks the network to move it on. The nudge is its own
          transaction, so your wallet will ask again.
        </p>
      ) : null}

      {tx.nudges > 0 ? (
        <p className="hint w-full">
          Nudged {tx.nudges} time{tx.nudges === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
