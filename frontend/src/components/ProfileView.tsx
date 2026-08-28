"use client";

/**
 * One address, and what the ledger says about it.
 *
 * `kept_bps` is computed over DECIDED periods only — kept plus broken — so an
 * unreachable page or a period nobody checked cannot move the rate in either
 * direction. The unverified and inconclusive counts are shown beside it rather
 * than folded into it, because folding them in is exactly how a broken promise
 * would get laundered into a track record.
 */
import { Flame } from "lucide-react";
import {
  useBeneficiaryCommitments,
  useChainNow,
  useTrackRecord,
  useUserCommitments,
} from "@/hooks/useChain";
import { useWallet } from "./WalletProvider";
import { CommitmentCard } from "./CommitmentCard";
import { StatTile } from "./StatTile";
import { CardSkeleton, Empty, ErrorNote, ListSkeleton } from "./States";
import { gen, pct, sameAddress, shortAddress } from "@/lib/format";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function ProfileView({ address }: { address: string }) {
  const valid = ADDRESS_RE.test(address);
  const record = useTrackRecord(valid ? address : null);
  const made = useUserCommitments(valid ? address : null);
  const owed = useBeneficiaryCommitments(valid ? address : null);
  const now = useChainNow();
  const { account } = useWallet();

  const isYou = sameAddress(account, address);

  if (!valid) {
    return (
      <Shell>
        <Empty
          title="That is not an address."
          hint="A profile URL ends in a 20-byte hex address, starting 0x."
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="eyebrow">{isYou ? "Your record" : "Track record"}</p>
      <h1 className="display mono mt-2 text-[28px] break-all sm:text-[34px]">
        {shortAddress(address)}
      </h1>
      <p className="mono hint mt-1 break-all">{address}</p>

      {record.error ? (
        <div className="mt-8">
          <ErrorNote error={record.error} retry={() => record.mutate()} />
        </div>
      ) : !record.data ? (
        <div className="mt-8">
          <CardSkeleton />
        </div>
      ) : (
        <>
          <div className="card-flat mt-8 grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
            <StatTile
              label="Kept rate"
              value={record.data.decided ? pct(record.data.kept_bps) : "—"}
              sub={
                record.data.decided
                  ? `${record.data.kept} of ${record.data.decided} decided`
                  : "nothing decided yet"
              }
            />
            <StatTile
              label="Current streak"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {record.data.streak}
                  {record.data.streak > 0 ? (
                    <Flame size={16} className="text-accent" aria-hidden />
                  ) : null}
                </span>
              }
              sub={`best ${record.data.best_streak}`}
            />
            <StatTile label="Open promises" value={record.data.active} sub="5 at a time is the cap" />
            <StatTile
              label="Received as beneficiary"
              value={gen(record.data.received, 2)}
              sub="from promises others broke"
            />
          </div>

          <div className="card-flat mt-4 grid grid-cols-2 divide-x divide-y divide-rule sm:grid-cols-4 sm:divide-y-0">
            <StatTile label="Periods kept" value={record.data.kept} />
            <StatTile label="Periods broken" value={record.data.broken} />
            <StatTile
              label="Inconclusive"
              value={record.data.unclear}
              sub="page could not settle it"
            />
            <StatTile
              label="Unverified"
              value={record.data.lapsed}
              sub="nobody checked in time"
            />
          </div>
        </>
      )}

      <Section
        title={isYou ? "Your promises" : "Promises made"}
        state={made}
        now={now}
        viewer={account}
        empty={{
          title: isYou ? "You have not made a promise yet." : "No promises from this address.",
          hint: isYou
            ? "Name something you will do, a page that will prove it, and someone you would rather not pay."
            : undefined,
        }}
      />

      <Section
        title={isYou ? "Promises pointed at you" : "Beneficiary of"}
        note="If one of these is broken, the stake comes to this address."
        state={owed}
        now={now}
        viewer={account}
        empty={{ title: "Nobody has named this address as their beneficiary." }}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-5 py-12">{children}</div>;
}

function Section({
  title,
  note,
  state,
  now,
  viewer,
  empty,
}: {
  title: string;
  note?: string;
  state: ReturnType<typeof useUserCommitments>;
  now: number | null;
  viewer: string | null;
  empty: { title: string; hint?: string };
}) {
  return (
    <section className="mt-12">
      <h2 className="display text-[22px]">{title}</h2>
      {note ? <p className="hint mt-1.5 mb-5">{note}</p> : <div className="mb-5" />}

      {state.error ? (
        <ErrorNote error={state.error} retry={() => state.mutate()} />
      ) : state.isLoading && !state.data ? (
        <ListSkeleton count={2} />
      ) : state.data?.length ? (
        <div className="grid gap-4">
          {state.data.map((row) => (
            <CommitmentCard key={row.id} commitment={row} now={now} viewer={viewer} />
          ))}
        </div>
      ) : (
        <Empty title={empty.title} hint={empty.hint} />
      )}
    </section>
  );
}
