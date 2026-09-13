"use client";

/**
 * The create form.
 *
 * Every check here is a MIRROR of `_create_problem` in the contract, and the
 * contract stays authoritative — this exists so a typo costs a keystroke
 * instead of a round trip through consensus. Where the two could drift, the
 * bounds come from `get_stats` (min/max stake, the wallet's active count)
 * rather than from constants copied into TypeScript.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, ShieldCheck, Wallet } from "lucide-react";
import { useStats, useTrackRecord } from "@/hooks/useChain";
import { useTx } from "@/hooks/useTx";
import { useWallet } from "./WalletProvider";
import { TxNote } from "./TxNote";
import { createCall, preflightCreate, quote } from "@/lib/contract";
import type { Quote } from "@/lib/fees";
import { FAUCET_URL } from "@/lib/genlayer";
import type { Preflight } from "@/types";
import { absolute, duration, gen, parseGen, periodLabel } from "@/lib/format";

const MIN_DESC = 12;
const MAX_DESC = 300;
const MAX_URL = 500;
const MIN_PERIOD_MINUTES = 5;
const MAX_PERIOD_MINUTES = 43200;
const MAX_FUNDED_PERIODS = 52;
const MAX_ACTIVE = 5;

const PRESETS = [
  { minutes: 5, label: "5 minutes", note: "for trying it out" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
  { minutes: 43200, label: "Monthly" },
] as const;

interface Draft {
  description: string;
  url: string;
  beneficiary: string;
  archive: string;
  recurring: boolean;
  minutes: number;
  customMinutes: string;
  stake: string;
  periods: string;
}

const EMPTY: Draft = {
  description: "",
  url: "",
  beneficiary: "",
  archive: "",
  recurring: true,
  minutes: 10080,
  customMinutes: "",
  stake: "0.1",
  periods: "4",
};

export function CommitForm() {
  const { account, available, onCorrectNetwork, connect, switchNetwork } = useWallet();
  const { data: stats } = useStats();
  const { data: record } = useTrackRecord(account);
  const tx = useTx();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const minutes = draft.minutes === 0 ? Number(draft.customMinutes || 0) : draft.minutes;
  const stakeWei = parseGen(draft.stake);
  const periods = draft.recurring ? Math.floor(Number(draft.periods || 0)) : 1;
  const value = stakeWei === null ? null : stakeWei * BigInt(Math.max(0, periods));

  const errors = useMemo(
    () => validate({ draft, minutes, stakeWei, periods, stats }),
    [draft, minutes, stakeWei, periods, stats],
  );
  const blocking = Object.values(errors).filter(Boolean).length > 0;
  const show = (field: keyof typeof errors) => (touched ? errors[field] : "");

  const atCap = (record?.active ?? 0) >= MAX_ACTIVE;

  const call = useMemo(
    () =>
      stakeWei === null || value === null
        ? null
        : createCall({
            from: account ?? undefined,
            description: draft.description.trim(),
            verifyUrl: draft.url.trim(),
            beneficiary: draft.beneficiary.trim(),
            archiveUrl: draft.archive.trim(),
            periodMinutes: minutes,
            stakePerPeriod: stakeWei,
            recurring: draft.recurring,
            value,
          }),
    [draft, minutes, stakeWei, periods, value, account],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (blocking || !account || !call) return;
    await tx.run(account, call);
  }

  // A created commitment is a different page, not a cleared form.
  const settled = tx.phase === "accepted" || tx.phase === "finalized";
  const created = settled ? (tx.returned as { id?: number; funded_periods?: number } | null) : null;
  if (created?.id !== undefined) {
    return (
      <div className="card mt-8 p-6">
        <p className="eyebrow">Commitment #{created.id}</p>
        <h2 className="display mt-2 text-[24px]">It is on the record.</h2>
        <p className="mt-3 max-w-xl text-[15px] text-ink-2">
          {created.funded_periods === 1
            ? "One period is funded."
            : `${created.funded_periods} periods are funded.`}{" "}
          The first deadline is {periodLabel(minutes * 60)} from now. When it passes, anyone can ask
          the network to read your page — including you, for free.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={`/commitment/${created.id}`} className="btn btn-primary">
            Open it
            <ArrowRight size={16} aria-hidden />
          </Link>
          <button
            type="button"
            className="btn"
            onClick={() => {
              tx.reset();
              setDraft(EMPTY);
              setTouched(false);
            }}
          >
            Make another
          </button>
        </div>
        <TxNote tx={tx} doneLabel="Created." onCheck={tx.check} onNudge={tx.nudge} />
      </div>
    );
  }

  return (
    <form className="mt-8" onSubmit={submit} noValidate>
      <fieldset className="card p-6" disabled={tx.busy}>
        <legend className="sr-only">The promise</legend>

        <Field
          label="What are you promising?"
          hint="Write it so a stranger reading your page could tell whether you did it. Vague promises come back inconclusive, and an inconclusive period pays nobody."
          error={show("description")}
        >
          <textarea
            className="field min-h-[92px] resize-y"
            value={draft.description}
            maxLength={MAX_DESC}
            placeholder="I will publish a new post on my blog every week."
            onChange={(e) => set("description", e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <p className="hint mt-1.5 text-right">
            <span className="mono">{draft.description.trim().length}</span> / {MAX_DESC}
          </p>
        </Field>

        <Field
          label="Where will the proof be?"
          hint="One URL, checked at every deadline. It must be reachable right now — a promise pointing at a dead page could never be judged, so the contract refunds instead of creating it."
          error={show("url")}
        >
          <input
            className="field field-mono"
            value={draft.url}
            maxLength={MAX_URL}
            inputMode="url"
            placeholder="https://example.com/blog"
            onChange={(e) => set("url", e.target.value)}
            onBlur={() => setTouched(true)}
          />
        </Field>

        <Field
          label="Pin an immutable snapshot (optional)"
          hint="A URL whose bytes cannot change — an archive.org capture, an IPFS or Arweave link. When you pin one, every validator judges the same fixed bytes and they can compare hashes exactly, instead of each reading a page that might have moved between fetches. Leave it blank and the network looks for an archived snapshot from around each deadline by itself."
          error={show("archive")}
        >
          <input
            className="field field-mono"
            value={draft.archive}
            maxLength={MAX_URL}
            inputMode="url"
            placeholder="https://web.archive.org/web/…id_/https://example.com/blog"
            spellCheck={false}
            onChange={(e) => set("archive", e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <SourceBadge url={draft.url} archive={draft.archive} />
        </Field>

        <Field
          label="Who gets the stake if you break it?"
          hint="Any address. Pick someone you would rather not pay — that is the whole mechanism. Naming yourself is allowed and waives the cancellation fee, but it also means breaking the promise costs you nothing."
          error={show("beneficiary")}
        >
          <input
            className="field field-mono"
            value={draft.beneficiary}
            placeholder="0x…"
            spellCheck={false}
            onChange={(e) => set("beneficiary", e.target.value)}
            onBlur={() => setTouched(true)}
          />
          {account ? (
            <button
              type="button"
              className="link-quiet mt-1.5 text-[12px]"
              onClick={() => set("beneficiary", account)}
            >
              Use my own address
            </button>
          ) : null}
        </Field>

        <div className="my-6 border-t border-rule" />

        <Field label="How often?" hint="" error={show("minutes")}>
          <div className="flex flex-wrap gap-2">
            <Toggle
              active={!draft.recurring}
              onClick={() => set("recurring", false)}
              label="Once"
              note="a single deadline"
            />
            <Toggle
              active={draft.recurring}
              onClick={() => set("recurring", true)}
              label="Repeating"
              note="one deadline per period"
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Toggle
                key={preset.minutes}
                active={draft.minutes === preset.minutes}
                onClick={() => set("minutes", preset.minutes)}
                label={draft.recurring ? preset.label : `In ${preset.label.toLowerCase()}`}
                note={"note" in preset ? preset.note : undefined}
              />
            ))}
            <Toggle
              active={draft.minutes === 0}
              onClick={() => set("minutes", 0)}
              label="Custom"
            />
          </div>

          {draft.minutes === 0 ? (
            <div className="mt-3 flex items-center gap-2">
              <input
                className="field field-mono w-32"
                value={draft.customMinutes}
                inputMode="numeric"
                placeholder="minutes"
                onChange={(e) => set("customMinutes", e.target.value.replace(/\D/g, ""))}
                onBlur={() => setTouched(true)}
              />
              <span className="hint">
                minutes — between 5 and {MAX_PERIOD_MINUTES.toLocaleString()} (30 days)
              </span>
            </div>
          ) : null}
        </Field>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field
            label={draft.recurring ? "Stake per period" : "Stake"}
            hint={
              stats
                ? `Between ${gen(stats.min_stake)} and ${gen(stats.max_stake)}.`
                : " "
            }
            error={show("stake")}
          >
            <div className="flex items-center gap-2">
              <input
                className="field field-mono"
                value={draft.stake}
                inputMode="decimal"
                onChange={(e) => set("stake", e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <span className="eyebrow shrink-0">GEN</span>
            </div>
          </Field>

          {draft.recurring ? (
            <Field
              label="Periods to fund now"
              hint={`Up to ${MAX_FUNDED_PERIODS}. You can add more later; when the money runs out, the commitment closes.`}
              error={show("periods")}
            >
              <input
                className="field field-mono"
                value={draft.periods}
                inputMode="numeric"
                onChange={(e) => set("periods", e.target.value.replace(/\D/g, ""))}
                onBlur={() => setTouched(true)}
              />
            </Field>
          ) : null}
        </div>

        <Summary
          recurring={draft.recurring}
          minutes={minutes}
          periods={periods}
          stakeWei={stakeWei}
          value={value}
          bountyBps={stats?.bounty_bps ?? 500}
          cancelFeeBps={stats?.cancel_fee_bps ?? 1000}
          now={stats?.now ?? null}
        />
      </fieldset>

      {stats?.paused ? (
        <Note tone="broken">
          New commitments are paused right now. Existing ones still settle normally — pausing
          cannot touch money that is already staked.
        </Note>
      ) : null}

      {atCap ? (
        <Note tone="broken">
          You already have {MAX_ACTIVE} active commitments, which is the cap. Settle or close one
          before making another.
        </Note>
      ) : null}

      {touched && blocking ? (
        <Note tone="broken">
          <span className="inline-flex items-center gap-1.5">
            <CircleAlert size={14} aria-hidden />
            {Object.values(errors).find(Boolean)}
          </span>
        </Note>
      ) : null}

      <PreflightPanel account={account} call={call} ready={!blocking} draft={draft}
        minutes={minutes} stakeWei={stakeWei} value={value} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {available === null ? null : !account ? (
          <button type="button" className="btn btn-primary" onClick={connect}>
            <Wallet size={16} aria-hidden />
            Connect to commit
          </button>
        ) : !onCorrectNetwork ? (
          <button type="button" className="btn btn-bounty" onClick={switchNetwork}>
            Switch network to commit
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn-primary"
            disabled={tx.busy || stats?.paused || atCap}
          >
            {tx.busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : null}
            {tx.phase === "checking"
              ? "Estimating the fee…"
              : tx.phase === "signing"
                ? "Confirm in your wallet…"
                : tx.busy
                  ? "Checking your page is reachable…"
                  : value === null || value === 0n
                    ? "Stake and commit"
                    : `Stake ${gen(value)} and commit`}
          </button>
        )}
        <p className="hint">
          One transaction. The stake leaves your wallet now and only the contract can move it back.
        </p>
      </div>

      <TxNote tx={tx} onCheck={tx.check} onNudge={tx.nudge} onRetry={tx.retry} />
    </form>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6 first:mt-0">
      <label className="label">{label}</label>
      {hint ? <p className="hint mb-2 max-w-2xl">{hint}</p> : null}
      {children}
      {error ? <p className="mt-1.5 text-[12.5px] text-broken">{error}</p> : null}
    </div>
  );
}

function Toggle({
  active,
  onClick,
  label,
  note,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  note?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-left text-[13.5px] font-medium transition-colors ${
        active
          ? "border-ink bg-ink text-ground"
          : "border-rule-2 bg-surface text-ink-2 hover:border-ink-2 hover:text-ink"
      }`}
    >
      {label}
      {note ? (
        <span className={`block text-[11px] font-normal ${active ? "opacity-70" : "text-muted"}`}>
          {note}
        </span>
      ) : null}
    </button>
  );
}

/**
 * What the network will actually say, asked before anything is signed.
 *
 * Two questions, two sources, and neither is a guess:
 *
 *   `preflight_create` is the CONTRACT'S OWN rejection logic run as a view, so
 *   the reason shown here is the reason the write would give — not a
 *   TypeScript reimplementation of it that drifts the first time either side
 *   changes. The validation above this panel still exists, but it is a
 *   convenience; this is the authority.
 *
 *   The fee quote is the estimate the transaction will actually carry, checked
 *   against the wallet balance. This is the check whose absence produced
 *   `LackOfFundForMaxFee` in production: the consensus contract locks the fee
 *   plus the stake before the contract runs, and a wallet that cannot cover
 *   both reverts before anything happens. Knowing the number here means the
 *   wallet dialog never opens on a transaction the user cannot afford.
 */
function PreflightPanel({
  account,
  call,
  ready,
  draft,
  minutes,
  stakeWei,
  value,
}: {
  account: `0x${string}` | null;
  call: ReturnType<typeof createCall> | null;
  ready: boolean;
  draft: Draft;
  minutes: number;
  stakeWei: bigint | null;
  value: bigint | null;
}) {
  const [chain, setChain] = useState<Preflight | null>(null);
  const [fee, setFee] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");

  const key =
    account && call && ready && stakeWei !== null && value !== null
      ? JSON.stringify([account, draft.description.trim(), draft.url.trim(), draft.archive.trim(),
          draft.beneficiary.trim(), minutes, stakeWei.toString(), draft.recurring, value.toString()])
      : null;

  useEffect(() => {
    if (!key || !account || !call || stakeWei === null || value === null) {
      setChain(null);
      setFee(null);
      setFailed("");
      return;
    }
    let cancelled = false;
    // Debounced: this runs on every keystroke of a valid draft, and both calls
    // are network round trips.
    const timer = setTimeout(async () => {
      setBusy(true);
      setFailed("");
      try {
        const [onChain, quoted] = await Promise.all([
          preflightCreate({
            who: account,
            description: draft.description.trim(),
            verifyUrl: draft.url.trim(),
            beneficiary: draft.beneficiary.trim(),
            archiveUrl: draft.archive.trim(),
            periodMinutes: minutes,
            stakePerPeriod: stakeWei,
            recurring: draft.recurring,
            value,
          }),
          quote(account, call).catch(() => null),
        ]);
        if (cancelled) return;
        setChain(onChain);
        setFee(quoted);
      } catch (e) {
        if (!cancelled) setFailed(String((e as { message?: string })?.message ?? e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` collapses the whole draft into one dependency on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;

  if (busy && !chain) {
    return (
      <div className="card-flat mt-4 flex items-center gap-2 p-4 text-[13px] text-ink-2">
        <LoaderCircle size={14} className="animate-spin" aria-hidden />
        Asking the contract what it would do…
      </div>
    );
  }

  if (failed) {
    return (
      <Note tone="accent">
        The preflight could not reach the network, so this has not been checked yet. You can still
        submit — the contract runs the same checks and refunds if it turns the call down.
      </Note>
    );
  }

  if (!chain) return null;

  const short = fee && !fee.ok;
  const tone = !chain.ok || short ? "broken" : "kept";

  return (
    <div
      className={`card-flat mt-4 p-4 ${
        tone === "broken" ? "border-broken/40 bg-broken-soft/40" : "border-kept/40 bg-kept-soft/40"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {tone === "broken" ? (
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-broken" aria-hidden />
        ) : (
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-kept" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          {!chain.ok ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink">The contract would turn this down.</p>
              <p className="mt-1 text-[13px] text-ink-2">{chain.reason}</p>
              {chain.cooldown_left > 0 ? (
                <p className="hint mt-1">{chain.cooldown_left}s left on the cooldown.</p>
              ) : null}
            </>
          ) : short ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink">
                This wallet cannot cover it yet.
              </p>
              <p className="mt-1 text-[13px] text-ink-2">{fee!.reason}</p>
              {FAUCET_URL ? (
                <a
                  className="link-quiet mt-1.5 inline-block text-[12px]"
                  href={FAUCET_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Get testnet GEN from the faucet
                </a>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[13.5px] font-semibold text-ink">Ready to sign.</p>
              <dl className="mono mt-2 grid gap-x-4 gap-y-1 text-[12px] text-ink-2 sm:grid-cols-2">
                <QuoteRow label="stake" value={gen(value ?? 0n)} />
                {fee && !fee.degraded ? <QuoteRow label="network fee" value={gen(fee.feeValue)} /> : null}
                {fee && !fee.degraded ? <QuoteRow label="total" value={gen(fee.required)} /> : null}
                {fee ? <QuoteRow label="your balance" value={gen(fee.balance)} /> : null}
                <QuoteRow label="periods funded" value={String(chain.funded_periods)} />
                <QuoteRow label="proof source" value={chain.source_kind} />
              </dl>
              {fee?.degraded ? (
                // Say the check is weaker rather than showing a confident zero.
                <p className="hint mt-2">
                  This network would not quote a fee, so only the stake has been checked against
                  your balance. The transaction still costs more than the stake alone.
                </p>
              ) : null}
            </>
          )}

          {/*
            * The one check that CANNOT happen here, stated rather than implied.
            * Reachability is non-deterministic — it only exists inside
            * consensus — so a clean preflight is not a promise the create will
            * succeed, and saying so is the difference between a surprising
            * refund and an expected one.
            */}
          <p className="hint mt-2">
            This does not check that your proof page is reachable — that happens inside consensus,
            where every validator fetches it. If it cannot be reached, the contract refunds your
            stake instead of creating the commitment.
          </p>
        </div>
      </div>
    </div>
  );
}

const QuoteRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3 border-b border-rule/50 pb-0.5">
    <dt className="text-muted">{label}</dt>
    <dd className="text-ink">{value}</dd>
  </div>
);

/** What kind of evidence this commitment will be judged on, named up front. */
function SourceBadge({ url, archive }: { url: string; archive: string }) {
  const pinned = archive.trim().length > 0;
  const host = (() => {
    try {
      return new URL(url.trim()).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const ARCHIVES = ["web.archive.org", "archive.ph", "archive.today", "ipfs.io",
    "cloudflare-ipfs.com", "gateway.pinata.cloud", "arweave.net"];
  const kind = pinned ? "ATTESTED" : ARCHIVES.includes(host) ? "ARCHIVED" : "OPEN";

  const copy = {
    ATTESTED:
      "Validators will judge the exact bytes you pinned, and compare hashes with each other.",
    ARCHIVED: "Your proof URL is already content-addressed, so its bytes cannot move under it.",
    OPEN:
      "An ordinary page. Validators each fetch it and must corroborate one another before any decisive verdict settles.",
  }[kind];

  if (!url.trim()) return null;
  return (
    <p className="hint mt-1.5 inline-flex items-start gap-1.5">
      <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        <span className="mono">{kind}</span> — {copy}
      </span>
    </p>
  );
}

function Note({ tone, children }: { tone: "broken" | "accent"; children: React.ReactNode }) {
  const style =
    tone === "broken" ? "border-broken/40 bg-broken-soft/40" : "border-accent/40 bg-accent-soft/40";
  return <div className={`card-flat mt-4 p-4 text-[13px] text-ink-2 ${style}`}>{children}</div>;
}

/** What this actually costs, and what happens to it — before the wallet opens. */
function Summary({
  recurring,
  minutes,
  periods,
  stakeWei,
  value,
  bountyBps,
  cancelFeeBps,
  now,
}: {
  recurring: boolean;
  minutes: number;
  periods: number;
  stakeWei: bigint | null;
  value: bigint | null;
  bountyBps: number;
  cancelFeeBps: number;
  now: number | null;
}) {
  if (stakeWei === null || value === null || minutes < MIN_PERIOD_MINUTES) return null;

  const seconds = minutes * 60;
  const bounty = (stakeWei / 10000n) * BigInt(bountyBps);

  return (
    <div className="sunk mt-6 p-4">
      <p className="eyebrow mb-3">What you are signing</p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Row term="Leaves your wallet now" detail={gen(value)} />
        <Row
          term={recurring ? "Periods funded" : "Deadline"}
          detail={recurring ? `${periods} × ${periodLabel(seconds)}` : `in ${duration(seconds)}`}
        />
        <Row
          term="First deadline"
          detail={now ? absolute(now + seconds) : `in ${duration(seconds)}`}
        />
        <Row term="Grace window closes" detail={`${duration(seconds)} after that`} />
        <Row
          term="If a period is kept"
          detail={`${gen(stakeWei - bounty)} back to you, ${gen(bounty)} to whoever settled it`}
        />
        <Row
          term="If a period is broken"
          detail={`${gen(stakeWei - bounty)} to your beneficiary, ${gen(bounty)} to whoever settled it`}
        />
      </dl>
      <p className="hint mt-3 border-t border-rule pt-3">
        Settling your own period costs you nothing — the fee is only paid to someone else. An
        inconclusive or unverified period returns the full stake and pays no fee. Cancelling early
        is only possible before a deadline lands, and costs {cancelFeeBps / 100}% to your
        beneficiary.
      </p>
    </div>
  );
}

function Row({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-rule/60 pb-1.5">
      <dt className="text-[12.5px] text-muted">{term}</dt>
      <dd className="mono text-[12.5px] text-ink-2">{detail}</dd>
    </div>
  );
}

/* ── Validation: a mirror of `_create_problem`. ──────────────────────────── */

function validate({
  draft,
  minutes,
  stakeWei,
  periods,
  stats,
}: {
  draft: Draft;
  minutes: number;
  stakeWei: bigint | null;
  periods: number;
  stats: { min_stake: string; max_stake: string } | undefined;
}): Record<"description" | "url" | "archive" | "beneficiary" | "minutes" | "stake" | "periods", string> {
  const description = draft.description.trim();
  const url = draft.url.trim();
  const archive = draft.archive.trim();
  const beneficiary = draft.beneficiary.trim();

  const out = { description: "", url: "", archive: "", beneficiary: "", minutes: "", stake: "", periods: "" };

  if (description.length < MIN_DESC) out.description = `Describe the promise in at least ${MIN_DESC} characters.`;
  else if (description.length > MAX_DESC) out.description = `Too long — ${MAX_DESC} characters at most.`;

  // https ONLY, and the message says why rather than reading as a typo: an
  // http page has no authenticated origin, so nothing fetched over it can be
  // attributed to the publisher the committer named.
  if (!url) out.url = "A proof URL is required.";
  else if (url.length > MAX_URL) out.url = "URL is too long (500 characters at most).";
  else if (/^http:\/\//i.test(url))
    out.url = "Use https:// — an http page has no authenticated origin, so nothing on it can be attributed to its publisher.";
  else if (!/^https:\/\//i.test(url)) out.url = "URL must start with https://";
  else if (/\s/.test(url)) out.url = "URL must not contain spaces.";

  if (archive) {
    if (archive.length > MAX_URL) out.archive = "Snapshot URL is too long (500 characters at most).";
    else if (!/^https:\/\//i.test(archive)) out.archive = "The snapshot URL must start with https://";
    else if (/\s/.test(archive)) out.archive = "The snapshot URL must not contain spaces.";
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(beneficiary)) out.beneficiary = "Beneficiary must be a 20-byte hex address.";
  else if (/^0x0{40}$/i.test(beneficiary)) out.beneficiary = "Beneficiary cannot be the zero address.";

  if (!minutes || minutes < MIN_PERIOD_MINUTES || minutes > MAX_PERIOD_MINUTES) {
    out.minutes = "Period must be between 5 minutes and 30 days.";
  }

  if (stakeWei === null) out.stake = "Enter an amount in GEN, like 0.25.";
  else if (stakeWei <= 0n) out.stake = "The stake has to be more than zero.";
  else if (stats && stakeWei < BigInt(stats.min_stake)) out.stake = `Minimum is ${gen(stats.min_stake)}.`;
  else if (stats && stakeWei > BigInt(stats.max_stake)) out.stake = `Maximum is ${gen(stats.max_stake)}.`;

  if (draft.recurring) {
    if (!periods || periods < 1) out.periods = "Fund at least one period.";
    else if (periods > MAX_FUNDED_PERIODS) out.periods = `At most ${MAX_FUNDED_PERIODS} periods at once.`;
  }

  return out;
}
