"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useChainNow, useActive, useRecent, useVerifiable, byNewest } from "@/hooks/useChain";
import { useWallet } from "./WalletProvider";
import { CommitmentCard } from "./CommitmentCard";
import { Empty, ErrorNote, ListSkeleton } from "./States";
import { RailLegend } from "./PeriodRail";

const TABS = [
  { id: "due", label: "Due now" },
  { id: "active", label: "Open" },
  { id: "all", label: "Everything" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function BrowseTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const requested = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : "due";

  const due = useVerifiable();
  const active = useActive();
  const all = useRecent(50);
  const now = useChainNow();
  const { account } = useWallet();

  const source = tab === "due" ? due : tab === "active" ? active : all;
  const rows = source.data ? byNewest(source.data) : [];

  // `replace`, not `push`: flipping a tab should not put a back-button stop
  // between the visitor and the page they arrived from.
  const select = (id: TabId) => router.replace(`${pathname}?tab=${id}`, { scroll: false });

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-2 border-b border-rule pb-3">
        <div role="tablist" aria-label="Which commitments to show" className="flex gap-1">
          {TABS.map((item) => {
            const selected = item.id === tab;
            const count =
              item.id === "due"
                ? due.data?.length
                : item.id === "active"
                  ? active.data?.length
                  : all.data?.length;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => select(item.id)}
                className={`rounded-md px-3 py-1.5 text-[13.5px] font-medium transition-colors ${
                  selected
                    ? "bg-ink text-ground"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {item.label}
                {count === undefined ? "" : ` (${count})`}
              </button>
            );
          })}
        </div>
        <div className="ml-auto hidden sm:block">
          <RailLegend />
        </div>
      </div>

      <div className="mt-6">
        {source.error ? (
          <ErrorNote error={source.error} retry={() => source.mutate()} />
        ) : source.isLoading && !source.data ? (
          <ListSkeleton count={3} />
        ) : rows.length ? (
          <div className="grid gap-4">
            {rows.map((row) => (
              <CommitmentCard key={row.id} commitment={row} now={now} viewer={account} />
            ))}
          </div>
        ) : (
          <Empty
            title={
              tab === "due"
                ? "Nothing is due right now."
                : tab === "active"
                  ? "No open promises."
                  : "The ledger is empty."
            }
            hint={
              tab === "due"
                ? "A period lands here the moment its deadline passes, and whoever settles it takes a cut of that period's stake."
                : "Make the first one — it takes a promise, a URL, and a stake."
            }
          />
        )}
      </div>
    </>
  );
}
