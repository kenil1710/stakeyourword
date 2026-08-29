"use client";

/**
 * Two headers, one component.
 *
 * The landing page is marketing and must not ask a stranger to connect a
 * wallet before they know what the product is, so on `/` the chrome is a logo,
 * two links, and one way in. Every other route is the app proper, where the
 * network you are on and the account you are signing with are both load-bearing
 * facts that belong on screen at all times. See app/page.tsx for the matching
 * split in the content.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ConnectButton } from "./ConnectButton";
import { NETWORK_LABEL } from "@/lib/genlayer";

const APP_NAV = [
  { href: "/browse", label: "Browse" },
  { href: "/commit", label: "Make a promise" },
  { href: "/docs", label: "How it works" },
];

const MARKETING_NAV = [
  { href: "/docs", label: "How it works" },
  { href: "/browse", label: "Browse" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const isLanding = pathname === "/";
  const nav = isLanding ? MARKETING_NAV : APP_NAV;

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ground/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 no-underline">
          <Mark />
          <span className="font-display text-[17px] font-medium tracking-tight text-ink">
            StakeYourWord
          </span>
        </Link>

        {!isLanding && (
          <span className="pill pill-neutral hidden sm:inline-flex">{NETWORK_LABEL}</span>
        )}

        <nav className="ml-auto hidden items-center gap-1 md:flex">
          {nav.map((item) => {
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
          {isLanding ? (
            <Link href="/commit" className="btn btn-primary text-[13px]">
              Launch app
              <ArrowRight size={15} aria-hidden />
            </Link>
          ) : (
            <ConnectButton />
          )}
        </div>
      </div>

      {/* The nav moves under the bar rather than into a menu: a handful of links
          do not need a drawer, and a drawer is one more thing that can trap
          focus. The landing keeps its two links in the bar itself. */}
      {!isLanding && (
        <nav className="flex items-center gap-1 border-t border-rule px-3 py-1.5 md:hidden">
          {nav.map((item) => {
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
      )}
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
