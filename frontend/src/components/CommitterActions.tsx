"use client";

/**
 * What the committer — and only the committer — can do to a live commitment.
 *
 * Cancelling is the one destructive control in the product, so it is behind a
 * deliberate second click that states the fee in GEN before it is charged.
 * Both actions are gated by the contract too; this only keeps the UI from
 * offering something that would revert.
 */
import { useState } from "react";
import { CircleX, LoaderCircle, Plus } from "lucide-react";
import type { CommitmentDetail } from "@/types";
import { useStats } from "@/hooks/useChain";
import { useTx } from "@/hooks/useTx";
import { useWallet } from "./WalletProvider";
import { TxNote } from "./TxNote";
import { addStake, cancelCommitment } from "@/lib/contract";
import { gen, sameAddress } from "@/lib/format";

const MAX_FUNDED_PERIODS = 52;

export function CommitterActions({
  commitment,
  now,
  onDone,
}: {
  commitment: CommitmentDetail;
  now: number | null;
  onDone: () => void;
}) {
  const { data: stats } = useStats();
  const { account } = useWallet();
  const fund = useTx();
  const cancel = useTx();
  const [periods, setPeriods] = useState("1");
  const [confirming, setConfirming] = useState(false);

  const stake = BigInt(commitment.stake_per_period);
  const wanted = Math.max(0, Math.floor(Number(periods || 0)));
  const value = stake * BigInt(wanted);

  const headroom = MAX_FUNDED_PERIODS - commitment.periods_funded;
  const canFund = commitment.recurring && headroom > 0;
  const fundProblem =
    wanted < 1
      ? "Add at least one period."
      : wanted > headroom
        ? `Only ${headroom} more period${headroom === 1 ? "" : "s"} can be funded.`
        : "";

  // The contract refuses a cancel once the period is due — that is what stops a
  // committer cancelling out of a verdict they can already see coming.
  const dueAlready = now !== null && commitment.next_deadline > 0 && now >= commitment.next_deadline;
  const selfBeneficiary = sameAddress(commitment.committer, commitment.beneficiary);
  const feeBps = stats?.cancel_fee_bps ?? 1000;
  const remaining = BigInt(commitment.total_staked);
  const fee = selfBeneficiary ? 0n : (remaining / 10000n) * BigInt(feeBps);

  // The signer is the connected wallet, never the record's stored committer —
  // reading the address off the data would build a transaction the connected
  // account cannot sign the moment the caller renders this for someone else.
  if (!sameAddress(account, commitment.committer)) return null;
  const signer = account as `0x${string}`;

  return (
    <section className="card mt-6 p-5">
      <p className="eyebrow mb-4">Yours to manage</p>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">Fund more periods</h3>
          <p className="hint mt-1.5">
            {!commitment.recurring
              ? "A one-time promise has no future periods to fund."
              : headroom <= 0
                ? `All ${MAX_FUNDED_PERIODS} fundable periods are already covered.`
                : `${gen(stake)} each. When the money runs out the commitment closes on its own.`}
          </p>

          {canFund ? (
            <>
              <div className="mt-3 flex items-center gap-2">
                <input
                  className="field field-mono w-24"
                  value={periods}
                  inputMode="numeric"
                  aria-label="Periods to add"
                  onChange={(e) => setPeriods(e.target.value.replace(/\D/g, ""))}
                />
                <span className="hint">
                  = {gen(value)} {fundProblem ? "" : `for ${wanted} more`}
                </span>
              </div>
              {fundProblem ? <p className="mt-1.5 text-[12.5px] text-broken">{fundProblem}</p> : null}
              <button
                type="button"
                className="btn mt-3 text-[13px]"
                disabled={fund.busy || Boolean(fundProblem)}
                onClick={async () => {
                  const out = await fund.run(() => addStake(signer, commitment.id, value));
                  if (out.phase === "done") onDone();
                }}
              >
                {fund.busy ? (
                  <LoaderCircle size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Plus size={14} aria-hidden />
                )}
                Add {gen(value)}
              </button>
              <TxNote tx={fund} doneLabel="Funded. The new periods are on the rail." />
            </>
          ) : null}
        </div>

        <div>
          <h3 className="text-[14px] font-semibold text-ink">Cancel</h3>
          <p className="hint mt-1.5">
            {dueAlready
              ? "A deadline has already passed. It has to be settled before you can cancel — that is what stops a cancel being used to dodge a verdict."
              : selfBeneficiary
                ? `You are your own beneficiary, so there is no fee. All ${gen(remaining)} comes back.`
                : `${gen(remaining - fee)} comes back to you and ${gen(fee)} goes to your beneficiary.`}
          </p>

          {!dueAlready ? (
            !confirming ? (
              <button
                type="button"
                className="btn mt-3 text-[13px]"
                onClick={() => setConfirming(true)}
              >
                <CircleX size={14} aria-hidden />
                Cancel this commitment
              </button>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn text-[13px]"
                  disabled={cancel.busy}
                  onClick={async () => {
                    const out = await cancel.run(() => cancelCommitment(signer, commitment.id));
                    setConfirming(false);
                    if (out.phase === "done") onDone();
                  }}
                >
                  {cancel.busy ? (
                    <LoaderCircle size={14} className="animate-spin" aria-hidden />
                  ) : null}
                  Yes, cancel and pay {gen(fee)}
                </button>
                <button
                  type="button"
                  className="btn text-[13px]"
                  disabled={cancel.busy}
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </button>
              </div>
            )
          ) : null}
          <TxNote tx={cancel} doneLabel="Cancelled. The stake has been returned." />
        </div>
      </div>
    </section>
  );
}
