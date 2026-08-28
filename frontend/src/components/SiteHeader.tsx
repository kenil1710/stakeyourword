"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { NETWORK_LABEL } from "@/lib/genlayer";

const NAV = [
  { href: "/browse", label: "Browse" },
  { href: "/commit", label: "Make a promise" },
  { href: "/docs", label: "How it works" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ground/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 no-underline">
          <Mark />
          <span className="font-display text-[17px] font-medium tracking-tight text-ink">
            StakeYourWord
          </span>
        </Link>

        <span className="pill pill-neutral hidden sm:inline-flex">{NETWORK_LABEL}</span>

        <nav className="ml-auto hidden items-center gap-1 md:flex">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-2 text-[13.5px] font-medium no-underline transition-colors ${
                  active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto md:ml-0">
          <ConnectButton />
        </div>
      </div>

      {/* The nav moves under the bar rather than into a menu: three links do not
          need a drawer, and a drawer is one more thing that can trap focus. */}
      <nav className="flex items-center gap-1 border-t border-rule px-3 py-1.5 md:hidden">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium no-underline ${
                active ? "bg-surface-2 text-ink" : "text-ink-2"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="7" fill="var(--ink)" />
      <rect x="7" y="8" width="6" height="6" rx="1.5" fill="var(--kept)" />
      <rect x="15" y="8" width="6" height="6" rx="1.5" fill="var(--kept)" />
      <rect x="7" y="18" width="6" height="6" rx="1.5" fill="var(--broken)" />
      <rect x="15" y="18" width="6" height="6" rx="1.5" fill="var(--accent)" />
      <rect x="23" y="8" width="2" height="6" rx="1" fill="var(--muted)" />
      <rect x="23" y="18" width="2" height="6" rx="1" fill="var(--muted)" />
    </svg>
  );
}
