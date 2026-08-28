import { Suspense } from "react";
import type { Metadata } from "next";
import { BrowseTabs } from "@/components/BrowseTabs";
import { ListSkeleton } from "@/components/States";

export const metadata: Metadata = {
  title: "Browse",
  description: "Every promise on StakeYourWord, and every period waiting to be settled.",
};

export default function BrowsePage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <h1 className="display text-[34px]">Browse</h1>
      <p className="hint mt-2 max-w-2xl">
        Everything on the ledger. Start with what is due — those are periods whose deadline has
        already passed and whose stake is waiting on somebody to settle it.
      </p>

      {/* useSearchParams needs a boundary, or the whole route opts out of
          static rendering. */}
      <Suspense fallback={<div className="mt-8"><ListSkeleton count={3} /></div>}>
        <BrowseTabs />
      </Suspense>
    </div>
  );
}
