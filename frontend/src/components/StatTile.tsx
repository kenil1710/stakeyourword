/** One number, its label, and nothing else. Used only in the stats strip. */
export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1.5 text-[22px] leading-none text-ink">{value}</p>
      {sub ? <p className="hint mt-1.5">{sub}</p> : null}
    </div>
  );
}
