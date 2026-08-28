"use client";

import { useChainNow, useRecent } from "@/hooks/useChain";
import { useWallet } from "./WalletProvider";
import { CommitmentCard } from "./CommitmentCard";
import { Empty, ErrorNote, ListSkeleton } from "./States";

export function RecentList({ count = 8 }: { count?: number }) {
  const { data, error, isLoading, mutate } = useRecent(count);
  const now = useChainNow();
  const { account } = useWallet();

  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <ListSkeleton count={3} />;

  const rows = data ?? [];
  if (!rows.length) {
    return (
      <Empty
        title="No promises yet."
        hint="Be the first. Name a page where the proof will live, put GEN behind it, and let the network read it."
      />
    );
  }

  return (
    <div className="grid gap-4">
      {rows.map((row) => (
        <CommitmentCard key={row.id} commitment={row} now={now} viewer={account} />
      ))}
    </div>
  );
}
