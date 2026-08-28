/**
 * NOT_MET. The page has real content, but everything on it clearly predates any
 * window the suite can test — which is the "judged on THIS period only" rule.
 */
export default function Stale() {
  return (
    <main>
      <h1>The Ship Log</h1>
      <p>Notes on what shipped, published every week.</p>
      <article>
        <h2>Week note: starting out</h2>
        <p>
          <strong>Published 2019-03-04</strong>
        </p>
        <p>
          First entry. The plan is to write one of these every week about whatever shipped.
        </p>
      </article>
      <hr />
      <p>
        <em>Nothing has been posted since March 2019.</em>
      </p>
    </main>
  );
}
