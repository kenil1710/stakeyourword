import Link from "next/link";
import { ArrowRight, Gavel, Scale, Link2 } from "lucide-react";
import { StatsStrip } from "@/components/StatsStrip";
import { BountyBoard } from "@/components/BountyBoard";
import { RecentList } from "@/components/RecentList";
import { RailLegend } from "@/components/PeriodRail";

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-5">
      <section className="border-b border-rule py-16 sm:py-24">
        <p className="eyebrow">Promises, with money behind them</p>
        <h1 className="display mt-4 max-w-3xl text-[40px] sm:text-[58px]">
          Say what you will do. Name the page that will prove it.
        </h1>
        <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-2">
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
          <Link href="/browse?tab=due" className="btn">
            <Gavel size={16} aria-hidden />
            Settle one for a fee
          </Link>
        </div>
      </section>

      <section className="py-10">
        <StatsStrip />
      </section>

      <section className="border-t border-rule py-12">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="display text-[26px]">On the table</h2>
            <p className="hint mt-1.5 max-w-xl">
              Periods past their deadline. Anyone can settle one, and the fee comes out of that
              period&apos;s stake whichever way the verdict goes.
            </p>
          </div>
          <Link href="/browse?tab=due" className="link-quiet text-[13px]">
            All open periods
          </Link>
        </div>
        <BountyBoard limit={3} />
      </section>

      <section className="border-t border-rule py-12">
        <h2 className="display text-[26px]">How it holds</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Step
            icon={<Link2 size={17} aria-hidden />}
            title="You name the evidence up front"
            body="A URL, chosen before there is anything to hide. It has to be reachable when you commit, or the stake is refunded and nothing is created — a promise pointing at a dead page could never be judged."
          />
          <Step
            icon={<Scale size={17} aria-hidden />}
            title="Validators read it separately"
            body="Each one fetches the page itself and judges this period on its own. The verdict is what they agree on. A leader that claims a live page is dead gets voted down."
          />
          <Step
            icon={<Gavel size={17} aria-hidden />}
            title="Settlement is somebody's job"
            body="Whoever calls it takes a finder's fee out of that period's stake. Verifying your own promise is free. Nobody profits from a verdict going one way over the other."
          />
        </div>

        <div className="card-flat mt-6 p-5">
          <p className="eyebrow mb-3">Reading a period rail</p>
          <RailLegend />
          <p className="hint mt-3 max-w-2xl">
            One chip per period, left to right. <strong className="text-ink-2">Unverified</strong> is
            its own outcome and not a pass: nobody settled the period inside its grace window, so the
            stake went back and the record says it was never checked.
          </p>
        </div>
      </section>

      <section className="border-t border-rule py-12">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <h2 className="display text-[26px]">Lately</h2>
          <Link href="/browse" className="link-quiet text-[13px]">
            Browse everything
          </Link>
        </div>
        <RecentList count={6} />
      </section>
    </div>
  );
}

function Step({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="card-flat p-5">
      <span className="text-ink-2">{icon}</span>
      <h3 className="mt-3 text-[15px] font-semibold text-ink">{title}</h3>
      <p className="hint mt-2">{body}</p>
    </div>
  );
}
