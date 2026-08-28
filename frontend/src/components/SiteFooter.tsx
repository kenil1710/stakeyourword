import Link from "next/link";
import { NETWORK_LABEL } from "@/lib/genlayer";

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-rule">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="hint max-w-md">
          Built on GenLayer. Validators each fetch the proof page themselves and judge it
          independently — the verdict is what they agree on, not what any one of them says.
        </p>
        <div className="flex items-center gap-4">
          <Link href="/docs" className="link-quiet text-[13px]">
            How it works
          </Link>
          <Link href="/browse" className="link-quiet text-[13px]">
            Browse
          </Link>
          <span className="eyebrow">{NETWORK_LABEL}</span>
        </div>
      </div>
    </footer>
  );
}
