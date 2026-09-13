import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RailLegend } from "@/components/PeriodRail";
import { ParamTable } from "@/components/ParamTable";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "What the contract does with your stake, how a verdict is reached, and every way money can leave.",
};

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="display text-[34px]">How it works</h1>
      <p className="mt-3 text-[15.5px] leading-relaxed text-ink-2">
        StakeYourWord is one contract on GenLayer. It holds staked GEN, asks a network of
        validators to read a page at each deadline, and moves the money the way the verdict says.
        There is no admin verdict and no protocol cut.
      </p>

      <Section title="Making a promise">
        <p>
          You give four things: what you are promising, a URL where the proof will live, an address
          that gets the money if you break it, and how long a period lasts. Then you send the stake.
        </p>
        <p>
          The URL must be <strong>https</strong>. An http page has no authenticated origin, so
          nothing fetched over it can be attributed to the publisher you named — and attribution is
          the whole point of nominating a page.
        </p>
        <p>
          The URL is checked for reachability before the commitment is created. If the page cannot
          be fetched, nothing is created and the stake is refunded in the same transaction — a
          promise pointing at a dead page could never be judged, so it is better not to exist.
        </p>
        <p>
          What the page says at that moment is <strong>hashed and fingerprinted on chain</strong>,
          and that fingerprint is what every later deadline measures drift against. You can also pin
          an immutable snapshot — an archive capture, an IPFS or Arweave link — and when you do,
          every validator judges the same fixed bytes rather than each fetching a page that might
          move between them.
        </p>
        <p>
          A repeating promise funds as many periods as the money covers. Anything left over that
          does not fill a whole period is refunded immediately rather than held as dust.
        </p>
      </Section>

      <Section title="How a period is judged">
        <p>
          From a period&apos;s deadline until one full period later, anyone can call for a
          verification. Validators each retrieve the evidence independently and each decide whether
          the promise was kept <em>for that period</em>.
        </p>
        <p>
          <strong>The evidence is what the page said at the deadline, not what it says now.</strong>{" "}
          If you pinned a snapshot, that is what is read. Otherwise the contract asks a public
          archive for a capture from around the deadline and reads that. Only when neither exists
          does it fall back to the live page — and the record says which of the three it was, so a
          verdict reached on today&apos;s page about a window that closed last week is visible as
          exactly that.
        </p>
        <p>There are three verdicts a model can reach:</p>
        <ul>
          <li>
            <strong>Kept</strong> — the page shows the promise was met for this period. Your stake
            comes back, less the finder&apos;s fee.
          </li>
          <li>
            <strong>Broken</strong> — it shows it was not. The stake goes to your beneficiary, less
            the finder&apos;s fee.
          </li>
          <li>
            <strong>Inconclusive</strong> — the page could not settle it either way, or could not be
            reached at all. The stake comes back in full and nobody is paid a fee. Benefit of the
            doubt is deliberate: an unreachable page is not evidence that you failed.
          </li>
        </ul>
        <p>
          A fourth outcome, <strong>unverified</strong>, is not a judgement at all. If nobody calls
          before the grace window closes — or if consensus never forms — the period is closed
          without any model running: the stake returns to the committer and the record says it was
          never checked. It is never counted as kept, and it is scored separately. Anyone can
          trigger that close; a refund path only the owner could trigger would not be a guarantee.
        </p>
      </Section>

      <Section title="What validators actually compare">
        <p>
          Agreeing on a label is not agreement. So a validator does not sign off on a leader&apos;s
          verdict until it has retrieved the evidence itself and compared more than the word:
        </p>
        <ul>
          <li>
            <strong>The verdict</strong>, exactly. There is no adjacent-value tolerance.
          </li>
          <li>
            <strong>The evidence hash</strong>, exactly, whenever both read an archived snapshot. An
            immutable capture is the same bytes for everyone, so it is the one axis that can be
            compared byte-for-byte rather than approximately.
          </li>
          <li>
            <strong>How far the page has drifted</strong> from what it said when the promise was
            made, bucketed coarsely so an ad slot or a timestamp cannot manufacture a disagreement.
          </li>
          <li>
            <strong>Three extracted observations</strong> — whether the page carries a date inside
            the window, whether a concrete artefact of the work is present, and whether the content
            is speaking to the evaluator. Two of the three must match.
          </li>
        </ul>
        <p>
          And when a validator <em>cannot</em> retrieve the evidence, it does not shrug and agree.
          Its own failed fetch corroborates nothing, so the only thing it will sign off on is the
          outcome that costs nobody their stake: inconclusive. Accepting a reachable leader on
          nothing but its own word is the hole that rule closes.
        </p>
        <p>
          One more rule runs after consensus, on the contract&apos;s own arithmetic rather than
          anybody&apos;s report of it: <strong>a kept verdict on evidence byte-identical to what the
          page said at creation is downgraded to inconclusive</strong> and the stake comes back.
          Nothing new on the page you nominated is not evidence that anything was done.
        </p>
      </Section>

      <Section title="Reading a rail">
        <div className="card-flat p-5">
          <RailLegend />
        </div>
        <p>
          One chip per period, left to right, in order. On a commitment&apos;s own page the rail is
          a true timeline. On a list card it is a tally — the summary a list read returns carries
          counts with no ordering, so the chips are grouped by outcome rather than placed in time.
        </p>
      </Section>

      <Section title="Where the money goes">
        <p>
          The contract takes nothing. Every transfer is either a return of principal, the
          finder&apos;s fee, or the early-cancellation fee — and the last two both go to users.
        </p>
        <ul>
          <li>
            <strong>The finder&apos;s fee</strong> comes out of that period&apos;s stake, whichever
            way the verdict goes. It is what pays a stranger to do the chore of settling.
          </li>
          <li>
            <strong>Settling your own period is free.</strong> When the caller is the committer, the
            fee is zero and the whole stake settles normally. That also means you cannot front-run a
            settlement to claw back the fee on a period you were about to lose.
          </li>
          <li>
            <strong>Inconclusive and unverified pay no fee.</strong> The fee rewards producing a
            settlement, not producing a transaction.
          </li>
          <li>
            <strong>Cancelling</strong> is only possible before a deadline lands — once a period is
            due, the only way out is settlement. It costs a percentage to your beneficiary, waived
            if you named yourself.
          </li>
        </ul>
      </Section>

      <Section title="What the owner cannot do">
        <p>
          Pausing stops new commitments and new stake. It does <em>not</em> touch verification,
          catch-up settlement or cancellation — an owner who could withhold every settlement
          indefinitely would have the same power as one who could change a verdict, just by a slower
          route.
        </p>
        <p>
          The fee rates are capped by constants in the contract and cannot be raised past them. No
          address can overrule a verdict, and no address can reach a stake: everything the contract
          holds beyond the sum of active stakes is the only thing that can ever be swept, and even
          that waits out an hour after the last outbound transfer.
        </p>
      </Section>

      <Section title="Prompt safety">
        <p>
          The page content handed to the model is fenced off and labelled untrusted, and the fence
          token names are stripped out of the content first so a page cannot close the fence and
          impersonate the instructions. Invisible characters are removed before that strip, or a
          zero-width space inside a token would smuggle it through.
        </p>
        <p>
          When a page contains text addressed at the evaluator, that is flagged on the record and
          shown on the commitment. The flag never decides a verdict — detection lists are always
          incomplete, so the real defence is the framing, not the list.
        </p>
      </Section>

      <Section title="What it costs to send a transaction">
        <p>
          Every write is an EVM transaction to the consensus contract, and the network locks the
          fee <em>plus</em> whatever stake rides with it before the contract runs. A wallet that
          cannot cover both is rejected on chain before anything happens.
        </p>
        <p>
          So nothing here opens a wallet dialog you cannot afford to confirm. Each write is quoted
          first and the estimate is checked against your balance; if it comes up short, the app
          refuses locally and tells you the exact amount missing. Nothing is signed and nothing is
          spent.
        </p>
        <p>
          One honest caveat about that check: the network estimates a fee by{" "}
          <em>simulating</em> the call, and this network&apos;s simulator runs on a clock
          hundreds of days behind the chain&apos;s. So anything the contract decides by time —
          whether a period is due, whether its grace window has closed — reads wrong in the
          simulation. When the simulation says the contract would refuse, you are told once and
          given a &ldquo;send it anyway&rdquo; button rather than being blocked, because the real
          transaction runs on the real clock. Only the balance check refuses outright; balances
          are not time-dependent.
        </p>
        <p>
          After you sign, the hash appears immediately and the transaction is tracked through{" "}
          <strong>pending → accepted → finalized</strong>. Accepted means the state is applied and
          the money is decided; finalized means it is irreversible. If it parks in between — which
          consensus does when a validator round does not complete — you get the controls:{" "}
          <em>Check status</em> polls on demand, <em>Nudge</em> asks the network to move it on, and{" "}
          <em>Retry</em> sends it again with a fresh estimate.
        </p>
      </Section>

      <Section title="The limits, as deployed">
        <ParamTable />
      </Section>

      <div className="mt-12 flex flex-wrap gap-3 border-t border-rule pt-8">
        <Link href="/commit" className="btn btn-primary">
          Make a promise
          <ArrowRight size={16} aria-hidden />
        </Link>
        <Link href="/browse?tab=due" className="btn">
          Settle one for a fee
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-rule pt-8">
      <h2 className="display text-[24px]">{title}</h2>
      <div className="prose mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-ink-2 [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-ink [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2">
        {children}
      </div>
    </section>
  );
}
