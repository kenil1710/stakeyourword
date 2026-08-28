/**
 * MET. A blog index carrying an entry dated today, so it always falls inside
 * whatever window the suite is testing.
 *
 * Dynamic on purpose. A hardcoded date cannot sit inside a five-minute period
 * computed at run time, and the alternative — a promise with no time element —
 * would not exercise the "judged on THIS period only" rule at all. Day
 * precision, so a leader and a validator fetching seconds apart read the same
 * text; even if they straddle midnight the verdict is MET either way, and the
 * verdict is the only compared axis.
 */
export const dynamic = "force-dynamic";

export default function Kept() {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <main>
      <h1>The Ship Log</h1>
      <p>Notes on what shipped, published every week.</p>
      <article>
        <h2>Week note: the settlement path is done</h2>
        <p>
          <strong>Published {today}</strong>
        </p>
        <p>
          This week I finished the settlement path end to end: a period now closes with the stake
          split three ways, the caller takes their finder&apos;s fee, and the remainder goes to
          whichever side the verdict points at. The accounting invariant holds across every branch
          I could think to test.
        </p>
        <p>
          Next week: the catch-up path, for periods that nobody got round to checking inside their
          grace window.
        </p>
      </article>
      <hr />
      <h2>Earlier</h2>
      <ul>
        <li>Week note: wiring the proof URL into the record</li>
        <li>Week note: why the bounty comes out of the stake</li>
      </ul>
    </main>
  );
}
