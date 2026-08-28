import type { Metadata } from "next";
import { CommitForm } from "@/components/CommitForm";

export const metadata: Metadata = {
  title: "Make a promise",
  description: "Name what you will do, where the proof will live, and what it costs you to fail.",
};

export default function CommitPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="display text-[34px]">Make a promise</h1>
      <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-ink-2">
        Three things and a stake: what you will do, a page that will prove it, and who gets the
        money if you do not. Pick the page before there is anything to hide — once the commitment
        exists, the URL cannot be changed.
      </p>
      <CommitForm />
    </div>
  );
}
