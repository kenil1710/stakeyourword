/**
 * Root layout.
 *
 * The three font families are wired here as CSS variables because
 * `globals.css` reads them by name — `--font-display` is
 * `var(--font-newsreader), Georgia, serif`, and if the variable is never
 * defined the whole `var()` chain becomes invalid at computed-value time and
 * the fallback stack goes with it. `next/font` self-hosts each face and emits
 * its own fallback metrics, so there is no layout shift and no request to
 * Google at run time.
 */
import type { Metadata } from "next";
import { Newsreader, Public_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-public-sans",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "StakeYourWord",
    template: "%s · StakeYourWord",
  },
  description:
    "Make a public promise, put GEN behind it, and let a network of validators read the proof page and decide whether you kept it.",
  openGraph: {
    title: "StakeYourWord",
    description:
      "A promise with money behind it, checked on a schedule by validators who each read the page themselves.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${publicSans.variable} ${jetbrains.variable}`}
    >
      <body>
        <WalletProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
