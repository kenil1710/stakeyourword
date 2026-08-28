/** Loading, empty and error states, so no page invents its own. */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} aria-hidden />;
}

export function CardSkeleton() {
  return (
    <div className="card p-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-4 h-5 w-3/4" />
      <Skeleton className="mt-2 h-5 w-1/2" />
      <Skeleton className="mt-5 h-6 w-40" />
    </div>
  );
}

export function ListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card-flat px-6 py-12 text-center">
      <p className="font-display text-[18px] text-ink">{title}</p>
      {hint ? <p className="hint mx-auto mt-2 max-w-md">{hint}</p> : null}
    </div>
  );
}

/**
 * A read that failed.
 *
 * The message is shown verbatim rather than replaced with "something went
 * wrong": the two failures worth telling apart here — an exhausted Studio quota
 * and a contract address pointing at nothing — read identically once they are
 * paraphrased, and only one of them is worth waiting out.
 */
export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="card-flat border-broken/40 bg-broken-soft/40 p-5">
      <p className="text-[13px] font-semibold text-broken">That read did not come back.</p>
      <p className="mono mt-2 text-[12px] leading-relaxed break-words text-ink-2">{message}</p>
      {retry ? (
        <button type="button" className="btn mt-4 text-[13px]" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
