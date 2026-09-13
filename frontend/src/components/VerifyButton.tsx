"use client";

/**
 * The one control a stranger is asked to press, and the only ochre one.
 *
 * Which method to call is NOT decided here. `action` comes from the contract's
 * own `_derived`, computed against the chain's clock: VERIFY inside the grace
 * window, LAPSED past it. A UI that worked it out from timestamps would
 * disagree with the chain the moment a browser clock drifted, and the
 * disagreement would surface as a revert the user could see was wrong.
 */
import { Gavel, Hourglass, LoaderCircle } from "lucide-react";
import { useTx } from "@/hooks/useTx";
import { useWallet } from "./WalletProvider";
import { TxNote } from "./TxNote";
import { settleStalledCall, verifyCall } from "@/lib/contract";
import { gen, sameAddress } from "@/lib/format";
import type { CommitmentSummary } from "@/types";

export function VerifyButton({
  commitment,
  onSettled,
}: {
  commitment: CommitmentSummary;
  onSettled?: () => void;
}) {
  const { account, onCorrectNetwork, connect, switchNetwork, available } = useWallet();
  const tx = useTx();

  if (commitment.action === "") return null;

  const lapsing = commitment.action === "LAPSED";
  // Self-verification is free by design: the bounty is zero when the caller is
  // the committer, so an honest committer can close their own period at no
  // cost. Promising them a bounty here would be a lie the contract corrects.
  const isCommitter = sameAddress(account, commitment.committer);
  const bounty = BigInt(commitment.bounty || "0");
  const paysBounty = !lapsing && !isCommitter && bounty > 0n;
  /*
   * The contract refuses a second verification while one is in flight, and the
   * refusal is a revert. Showing the lock is the difference between "someone is
   * already doing this" and a transaction that fails for no visible reason.
   */
  const locked = !lapsing && commitment.verify_in_flight && !tx.busy && tx.phase === "idle";

  async function act() {
    if (!account) return;
    const result = await tx.run(
      account,
      lapsing ? settleStalledCall(commitment, account) : verifyCall(commitment, account),
    );
    if (result.phase === "accepted" || result.phase === "finalized") onSettled?.();
  }

  if (available === null) return <div className="h-[38px]" aria-hidden />;

  if (!account) {
    return (
      <div>
        <button type="button" className="btn btn-bounty" onClick={connect}>
          <Gavel size={15} aria-hidden />
          {paysBounty ? `Connect to claim ${gen(bounty)}` : "Connect to settle this"}
        </button>
        <p className="hint mt-2">
          {lapsing
            ? "This period is past its grace window. Closing it returns the stake and records the period as unverified."
            : "Anyone can call this. The fee comes out of this period's stake either way the verdict goes."}
        </p>
      </div>
    );
  }

  if (!onCorrectNetwork) {
    return (
      <button type="button" className="btn btn-bounty" onClick={switchNetwork}>
        Switch network to settle
      </button>
    );
  }

  if (locked) {
    return (
      <div>
        <button type="button" className="btn" disabled>
          <Hourglass size={15} aria-hidden />
          A verification is already in flight
        </button>
        <p className="hint mt-2">
          Somebody called this already and the network has not finished. The contract holds the
          lock so two verifications cannot settle the same period; it clears on its own when the
          first one lands or gives up.
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={`btn ${lapsing ? "" : "btn-bounty"}`}
        onClick={act}
        disabled={tx.busy}
      >
        {tx.busy ? (
          <LoaderCircle size={15} className="animate-spin" aria-hidden />
        ) : lapsing ? (
          <Hourglass size={15} aria-hidden />
        ) : (
          <Gavel size={15} aria-hidden />
        )}
        {tx.phase === "checking"
          ? "Estimating the fee…"
          : tx.phase === "signing"
            ? "Confirm in your wallet…"
            : tx.busy
              ? lapsing
                ? "Closing the period…"
                : "Validators are reading the page…"
              : lapsing
                ? "Close this period"
                : paysBounty
                  ? `Verify and claim ${gen(bounty)}`
                  : "Verify this period"}
      </button>

      <p className="hint mt-2">
        {tx.busy && !lapsing
          ? "Each validator fetches the page independently and judges it on its own. This takes a minute or two."
          : lapsing
            ? "No model runs. The stake goes back to the committer and the period is recorded as unverified — never as kept."
            : isCommitter
              ? "You are the committer, so this costs you no fee — the whole stake settles normally."
              : `The fee is ${gen(bounty)}, carved from this period's stake whichever way the verdict goes. An inconclusive verdict pays nothing.`}
      </p>

      <TxNote
        tx={tx}
        doneLabel={lapsing ? "Period closed as unverified." : "Settled. The verdict is on the record."}
        onCheck={tx.check}
        onNudge={tx.nudge}
        onRetry={tx.retry}
      />
    </div>
  );
}
