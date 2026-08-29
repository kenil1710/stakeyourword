/**
 * The hero visual: one commitment as it appears in the book.
 *
 * This is not a decorative mockup. It is the product's own vernacular — a
 * ruled leaf, the promise in the serif, the stake in tabular figures, and the
 * PERIOD RAIL doing the thing the rail always does. A reader who understands
 * this card understands the product, which is the only job the hero has.
 *
 * The chips ink themselves in left to right, once, then rest. A loop would
 * make the page restless and break the house rule that only a chip asking to
 * be acted on ever moves; a one-shot settle reads as a book being written.
 * `.ink-in` is inert under `prefers-reduced-motion`, so the card arrives
 * already complete.
 */
const PERIODS = [
  { n: "1", kind: "chip-kept", title: "Period 1 — kept" },
  { n: "2", kind: "chip-kept", title: "Period 2 — kept" },
  { n: "3", kind: "chip-broken", title: "Period 3 — broken" },
  { n: "4", kind: "chip-kept", title: "Period 4 — kept" },
  { n: "5", kind: "chip-kept", title: "Period 5 — kept" },
  { n: "6", kind: "chip-pending", title: "Period 6 — not yet due" },
];

const ROWS: Array<[string, string, string?]> = [
  ["Stake", "0.50 GEN", "num"],
  ["Every", "7 days", "num"],
  ["If broken", "0x61Ed…8822", "num"],
];

export function HeroLedger() {
  return (
    <figure className="hero-leaf card" aria-labelledby="hero-leaf-cap">
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <span className="eyebrow">Commitment № 41</span>
        <span className="eyebrow">Week 6 of 6</span>
      </div>

      <blockquote className="quote px-5 pt-5 text-[19px] sm:text-[21px]">
        “I will publish a new post on The Ship Log every week without fail.”
      </blockquote>

      <dl className="ruled mt-5 border-t border-rule">
        {ROWS.map(([term, value, cls]) => (
          <div key={term} className="flex items-baseline justify-between px-5 py-2.5">
            <dt className="text-[12.5px] text-muted">{term}</dt>
            <dd className={`text-[13px] text-ink-2 ${cls ?? ""}`}>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-rule px-5 py-4">
        <p className="eyebrow mb-2.5">The record</p>
        <div className="rail" role="list" aria-label="Six periods: four kept, one broken, one still ahead">
          {PERIODS.map((p, i) => (
            <div
              key={p.n}
              role="listitem"
              title={p.title}
              aria-label={p.title}
              className={`chip chip-lg ${p.kind} ink-in`}
              style={{ animationDelay: `${240 + i * 90}ms` }}
            >
              {p.n}
            </div>
          ))}
        </div>
      </div>

      <figcaption
        id="hero-leaf-cap"
        className="ink-in flex items-baseline justify-between border-t border-rule px-5 py-3"
        style={{ animationDelay: "840ms" }}
      >
        <span className="text-[12.5px] text-muted">Returned so far</span>
        <span className="num text-[13px] text-kept">0.40 GEN of 0.50</span>
      </figcaption>
    </figure>
  );
}
