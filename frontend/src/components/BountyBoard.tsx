"use client";

/**
 * Every period past its deadline right now — the only screen in the product
 * that asks a stranger to do something, so it is the only one with ochre on it.
 */
import Link from "next/link";
import { Coins } from "lucide-react";
import { useChainNow, useVerifiable } from "@/hooks/useChain";
import { useWallet } from "./WalletProvider";
import { CommitmentCard } from "./CommitmentCard";
import { Empty, ErrorNote, ListSkeleton } from "./States";
import { gen } from "@/lib/format";

export function BountyBoard({ limit }: { limit?: number }) {
  const { data, error, isLoading, mutate } = useVerifiable();
  const now = useChainNow();
  const { account } = useWallet();

  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <ListSkeleton count={2} />;

  const rows = data ?? [];
  if (!rows.length) {
    return (
      <Empty
        title="Nothing is due right now."
        hint="When a period passes its deadline it lands here, and whoever settles it takes a cut of that period's stake."
      />
    );
  }

  const shown = limit ? rows.slice(0, limit) : rows;
  const payable = rows
    .filter((row) => row.action === "VERIFY")
    .reduce((sum, row) => sum + BigInt(row.bounty || "0"), 0n);

  return (
    <div>
      {payable > 0n ? (
        <p className="mb-4 inline-flex items-center gap-2 text-[13.5px] text-ink-2">
          <Coins size={15} className="text-accent" aria-hidden />
          <span className="num text-accent-ink">{gen(payable)}</span>
          in finder&apos;s fees is unclaimed across {rows.length} period
          {rows.length === 1 ? "" : "s"}.
        </p>
      ) : null}

      <div className="grid gap-4">
        {shown.map((row) => (
          <CommitmentCard key={row.id} commitment={row} now={now} viewer={account} />
        ))}
      </div>

      {limit && rows.length > limit ? (
        <Link href="/browse?tab=due" className="btn mt-4 text-[13px]">
          See all {rows.length} due
        </Link>
      ) : null}
    </div>
  );
}
