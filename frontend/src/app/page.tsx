/**
 * The landing page is marketing only.
 *
 * Nothing here reads the chain and nothing here offers an action that needs a
 * wallet. A stranger should be able to understand the product, and decide
 * whether they want it, before anything asks them to connect. Live boards and
 * settlement live in /browse, which is where somebody who has already decided
 * goes. See SiteHeader for the matching split in the chrome.
 */
import Link from "next/link";
import { ArrowRight, Eye, Scale, Coins, FileSignature } from "lucide-react";
import { HeroLedger } from "@/components/HeroLedger";

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-5">
      {/* ── 1 · Hero ──────────────────────────────────────────────────── */}
      <section className="hero-glow grid items-center gap-12 border-b border-rule py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-24">
        <div>
          <p className="eyebrow">Promises, with money behind them</p>
          <h1 className="display mt-4 text-[42px] sm:text-[56px]">
            Say what you will do. Name the page that will prove it.
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2">
            Stake GEN against keeping your word. At each deadline a network of validators fetches
            your proof page — each one independently — and they decide together whether you kept it.
            Kept, the stake comes home. Broken, it goes to whoever you named. Nobody, including us,
            can overrule that.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/commit" className="btn btn-primary">
              Make a promise
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link href="/docs" className="btn">
              How it works
            </Link>
          </div>
        </div>

        <div className="lg:pl-4">
          <HeroLedger />
        </div>
      </section>

      {/* ── 2 · How it works ──────────────────────────────────────────── */}
      <section className="border-b border-rule py-14">
        <h2 className="display text-[30px]">How it works</h2>
        <p className="hint mt-2 max-w-xl">
          Four steps, and only the first one is yours to get right.
        </p>

        {/* Numbered because this genuinely is a sequence — each step depends on
            the one before it, and the order is what makes the guarantee hold. */}
        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step
            n="01"
            icon={<FileSignature size={17} aria-hidden />}
            title="Name the evidence first"
            body="A URL, chosen before there is anything to hide. It has to be reachable the moment you commit, or your stake is refunded and nothing is created."
          />
          <Step
            n="02"
            icon={<Coins size={17} aria-hidden />}
            title="Stake it and set the clock"
            body="Put GEN behind the promise and pick how long a period runs. The stake is locked for as many periods as you funded."
          />
          <Step
            n="03"
            icon={<Eye size={17} aria-hidden />}
            title="Validators read it separately"
            body="At each deadline they each fetch the page themselves and judge that period alone. The verdict is what they agree on, not what any one of them says."
          />
          <Step
            n="04"
            icon={<Scale size={17} aria-hidden />}
            title="The money moves itself"
            body="Kept, the period's stake returns to you. Broken, it goes to the person you named. No appeal, no support ticket, no us."
          />
        </ol>
      </section>

      {/* ── 3 · A worked example ──────────────────────────────────────── */}
      <section className="border-b border-rule py-14">
        <h2 className="display text-[30px]">Where the money actually goes</h2>
        <p className="hint mt-2 max-w-xl">
          One promise, 0.50 GEN staked across five weekly periods, 0.10 GEN riding on each. This is
          an illustration — nothing here is a live commitment.
        </p>

        <div className="card-flat mt-8 overflow-hidden">
          <div className="border-b border-rule px-5 py-4">
            <blockquote className="quote text-[18px]">
              “I will publish a new post on The Ship Log every week without fail.”
            </blockquote>
          </div>
          <div className="scroll-x">
            <table className="w-full min-w-[540px] text-left">
              <thead>
                <tr className="border-b border-rule">
                  <Th>Period</Th>
                  <Th>Verdict</Th>
                  <Th>To you</Th>
                  <Th>To the beneficiary</Th>
                  <Th>Finder’s fee</Th>
                </tr>
              </thead>
              <tbody className="ruled">
                <Row n="1" kind="kept" verdict="Kept" mine="0.095" theirs="0" fee="0.005" />
                <Row n="2" kind="kept" verdict="Kept" mine="0.095" theirs="0" fee="0.005" />
                <Row n="3" kind="broken" verdict="Broken" mine="0" theirs="0.095" fee="0.005" />
                <Row n="4" kind="kept" verdict="Kept" mine="0.100" theirs="0" fee="0" note="settled it yourself" />
                <Row n="5" kind="lapse" verdict="Unverified" mine="0.100" theirs="0" fee="0" note="nobody checked in time" />
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-rule bg-sunk px-5 py-3.5">
            <span className="text-[13px] text-ink-2">
              You kept three of the four that were judged.
            </span>
            <span className="num text-[13px] text-ink">
              0.390 back · 0.095 given away · 0.015 in fees
            </span>
          </div>
        </div>

        <p className="hint mt-4 max-w-2xl">
          <strong className="text-ink-2">Unverified is not a pass.</strong> If nobody settles a
          period inside its grace window the stake simply returns to you, and the record says so
          permanently. It never counts toward your kept rate.
        </p>
      </section>

      {/* ── 4 · Why this matters ──────────────────────────────────────── */}
      <section className="border-b border-rule py-14">
        <h2 className="display text-[30px]">Why put it on a chain at all</h2>
        <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          <Point title="The judge is not a person">
            An accountability app has to decide who rules on the evidence, and every answer that
            ends in a human ends in someone who can be argued with. Here a network of validators
            each reads the page and the verdict is their agreement.
          </Point>
          <Point title="The evidence is named before the fact">
            You commit to a URL while you still have nothing to hide. Moving the goalposts later
            means moving a page that was already written down.
          </Point>
          <Point title="Nobody profits from the verdict">
            Whoever settles a period is paid the same fee whichever way it goes. There is no side
            of the outcome that pays better, so there is nothing to buy.
          </Point>
          <Point title="We cannot give you your money back">
            The contract pays out on its own. That is the point — a promise you could talk your way
            out of is the promise you already broke.
          </Point>
        </div>
      </section>

      {/* ── 5 · Use cases ─────────────────────────────────────────────── */}
      <section className="border-b border-rule py-14">
        <h2 className="display text-[30px]">What people stake on</h2>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Use title="Shipping on a cadence" body="A newsletter every Friday, a release every fortnight, a devlog every week. The proof page is the archive that already exists." />
          <Use title="Writing in public" body="A post, a chapter, a paper section. Name the page it lands on and let the deadline do the work." />
          <Use title="Client deliverables" body="Name the client as the beneficiary. If you miss the date they are paid without having to ask you for anything." />
          <Use title="Keeping a repo alive" body="A commit, a changelog entry, a triaged issue queue. Point at the page that shows it." />
          <Use title="Training and habits" body="A public log, a race result, a leaderboard. Anything with a page that updates when you did the thing." />
          <Use title="Bets between friends" body="Name each other as beneficiaries. The loser does not get to relitigate it." />
        </ul>
      </section>

      {/* ── 6 · Closing call to action ────────────────────────────────── */}
      <section className="pt-16 pb-2 text-center sm:pt-20 sm:pb-4">
        <h2 className="display mx-auto max-w-2xl text-[34px] sm:text-[42px]">
          What would you keep if it cost you to break it?
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-[16px] leading-relaxed text-ink-2">
          Pick something you have already been meaning to do. Name the page that will show you did
          it. Put enough behind it that skipping a week stings.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/commit" className="btn btn-primary">
            Make a promise
            <ArrowRight size={16} aria-hidden />
          </Link>
          <Link href="/browse" className="btn">
            See what others promised
          </Link>
        </div>
      </section>
    </div>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────── */

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="card-flat p-5">
      <div className="flex items-center justify-between">
        <span className="text-ink-2">{icon}</span>
        <span className="eyebrow">{n}</span>
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-ink">{title}</h3>
      <p className="hint mt-2">{body}</p>
    </li>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-rule-2 pl-5">
      <h3 className="text-[15.5px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

function Use({ title, body }: { title: string; body: string }) {
  return (
    <li className="card-flat p-5">
      <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
      <p className="hint mt-1.5">{body}</p>
    </li>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="eyebrow px-5 py-2.5 font-normal">{children}</th>;
}

function Row({
  n,
  kind,
  verdict,
  mine,
  theirs,
  fee,
  note,
}: {
  n: string;
  kind: "kept" | "broken" | "lapse";
  verdict: string;
  mine: string;
  theirs: string;
  fee: string;
  note?: string;
}) {
  return (
    <tr>
      <td className="px-5 py-3">
        <span className={`chip chip-md chip-${kind}`} aria-hidden>
          {n}
        </span>
      </td>
      <td className="px-5 py-3">
        <span className={`pill pill-${kind === "lapse" ? "lapse" : kind}`}>{verdict}</span>
        {note ? <span className="hint mt-1 block">{note}</span> : null}
      </td>
      <td className="num px-5 py-3 text-[13px] text-ink">{mine}</td>
      <td className="num px-5 py-3 text-[13px] text-ink">{theirs}</td>
      <td className="num px-5 py-3 text-[13px] text-muted">{fee}</td>
    </tr>
  );
}
