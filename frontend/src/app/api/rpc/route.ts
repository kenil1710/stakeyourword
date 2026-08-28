/**
 * Same-origin relay for the Studionet JSON-RPC endpoint.
 *
 * ## Why this exists
 *
 * Not because Studio lacks CORS. It reflects whatever `Origin` you send and
 * answers preflights correctly:
 *
 *     OPTIONS https://studio.genlayer.com/api   ->  200
 *       access-control-allow-origin: http://localhost:3000
 *       access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
 *       access-control-allow-headers: content-type
 *
 * The failure is rate limiting wearing a CORS costume. Studio meters per IP,
 * and once the quota is gone it answers with a bare 429 that carries **no**
 * `Access-Control-Allow-Origin`:
 *
 *     HTTP/2 429
 *     retry-after: 86400
 *     {"error":{"code":-32029,"message":"Rate limit exceeded: 5000 requests per day"}}
 *
 * A response the browser is not allowed to read is reported as a CORS
 * violation, not as the 429 it is — so an exhausted quota shows up in the
 * console as "No 'Access-Control-Allow-Origin' header is present". Same
 * message you would get from a genuinely closed endpoint, entirely different
 * cause, and no amount of CORS configuration fixes it.
 *
 * Server-to-server fetch has no same-origin policy, so relaying through here
 * makes the browser see this route's own response — status, body and all.
 * That does not raise the quota. It makes hitting it legible: the app gets
 * "rate limited, retry in 86400s" instead of a phantom CORS error.
 *
 * Bradbury does not need this. It serves CORS headers on errors too, so the
 * browser talks to it directly — see `rpcUrl()` in `lib/genlayer.ts`.
 */
import { studionet } from "genlayer-js/chains";

/** Streams upstream bodies through; never prerendered. */
export const dynamic = "force-dynamic";

/**
 * Where to relay. Defaults to the SDK's own Studionet URL so this cannot drift
 * from the chain the client talks to; override with `GENLAYER_RPC_UPSTREAM`
 * (server-side var, deliberately not `NEXT_PUBLIC_` — the browser must go
 * through this route, not around it).
 *
 * Read once at module load: `createClient({ endpoint })` in genlayer-js
 * *mutates* the exported chain singleton, so a later read could hand back
 * whatever some other caller last wrote.
 */
const UPSTREAM = process.env.GENLAYER_RPC_UPSTREAM ?? studionet.rpcUrls.default.http[0];

/**
 * Backstop against a socket that never closes — deliberately *longer* than the
 * 30s budget `lib/contract.ts` puts around each read.
 *
 * The read budget belongs to the caller, not to this relay. Matching 30s here
 * would mean the relay always timed out a hair first (it starts its clock
 * earlier), quietly taking over a policy decision that lives in the client. So
 * this only fires when the client is not already giving up on its own.
 *
 * Signing never arrives here; the SDK routes `eth_sendTransaction` and friends
 * to the wallet. What does arrive is `gen_call`, and under load Studio can sit
 * on one of those for well over a minute before answering or failing.
 */
const UPSTREAM_TIMEOUT_MS = 45_000;

/**
 * Studio meters per minute *and* per day. A per-minute trip clears on its own,
 * so a couple of short waits keep a poll loop alive; the daily quota comes back
 * with `retry_after: 86400`, which no retry budget can outlast. Retrying only
 * when the wait is short distinguishes the two without hardcoding either limit.
 */
const RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;

/** Extra browser origins allowed to call this relay, comma-separated. */
const EXTRA_ORIGINS = (process.env.RPC_PROXY_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

type JsonRpcId = string | number | null;

/**
 * CORS for the relay itself.
 *
 * Same-origin requests need none of this — the app calls `/api/rpc` from its
 * own page, so the browser sends no `Origin` and skips preflight entirely.
 * The headers exist for the cross-origin case, and they are an allowlist
 * rather than `*` on purpose: a wildcard would let any page on the internet
 * spend this deployment's Studio quota, which is the exact resource that was
 * scarce enough to cause the bug this route fixes.
 *
 * Unlike Studio, these headers go on *every* response including errors — that
 * is the whole point, and skipping it here would recreate the original bug one
 * layer down.
 */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};

  const sameOrigin = origin === new URL(request.url).origin;
  if (!sameOrigin && !EXTRA_ORIGINS.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    // Responses differ by origin; without this a shared cache could hand one
    // origin's headers to another.
    Vary: "Origin",
  };
}

/**
 * A JSON-RPC error envelope.
 *
 * The SDK reads `data.error` off the parsed body and throws it, so faults have
 * to arrive *as JSON-RPC* to surface as anything better than a JSON parse
 * failure. HTTP status stays 200 for the same reason: several fetch layers
 * discard the body of a non-2xx, and the message inside is the useful part.
 */
function rpcError(
  request: Request,
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } },
    { headers: corsHeaders(request) },
  );
}

/** Best-effort id echo — a response the caller cannot match up is a hung promise. */
function readId(body: string): JsonRpcId {
  try {
    const parsed: unknown = JSON.parse(body);
    // Batch requests: the array form has no single id to answer with.
    if (Array.isArray(parsed)) return null;
    const id = (parsed as { id?: unknown })?.id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** `Retry-After` in ms — seconds or an HTTP date, per RFC 9110. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request): Promise<Response> {
  // Buffered rather than piped upstream: JSON-RPC calls are small, streaming a
  // request body needs `duplex: "half"` and costs a retry (a consumed stream
  // cannot be replayed), and having the text lets us echo the id when the relay
  // itself fails.
  let body: string;
  try {
    body = await request.text();
  } catch {
    return rpcError(request, null, -32700, "Could not read the request body.");
  }

  const id = readId(body);

  for (let attempt = 0; ; attempt++) {
    let upstream: Response;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // Two ways to stop early: the caller navigating away (`request.signal`)
        // and a hung upstream. `any` unifies them so neither leaks a socket.
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]),
        cache: "no-store",
      });
    } catch (error) {
      // The caller gave up; nothing is waiting for this response.
      if (request.signal.aborted) return new Response(null, { status: 499 });

      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return rpcError(
        request,
        id,
        -32603,
        timedOut
          ? `The GenLayer RPC did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s.`
          : `Could not reach the GenLayer RPC at ${UPSTREAM}.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    if (upstream.status === 429) {
      const wait = retryAfterMs(upstream);
      const canRetry =
        attempt < RATE_LIMIT_RETRIES && wait !== null && wait <= MAX_RETRY_WAIT_MS;

      if (canRetry) {
        await upstream.body?.cancel();
        await sleep(wait);
        continue;
      }

      // Out of retries, or a wait too long to sit on (the daily quota asks for
      // 24h). Studio's own body explains which limit was hit and is already
      // JSON-RPC shaped, so forward it verbatim — with the CORS headers Studio
      // omitted, which is what made this look like a CORS problem to begin with.
      const detail = await upstream.text().catch(() => "");
      return new Response(
        detail ||
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32029, message: "GenLayer RPC rate limit exceeded." },
          }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            ...(wait === null ? {} : { "Retry-After": String(Math.ceil(wait / 1000)) }),
            ...corsHeaders(request),
          },
        },
      );
    }

    // Anything that is not JSON is an infrastructure page, not an RPC answer —
    // a Cloudflare 5xx, a captcha interstitial. Passing it through would only
    // reach the SDK as an opaque "Unexpected token '<'", so translate it.
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 500);
      return rpcError(
        request,
        id,
        -32603,
        `The GenLayer RPC returned a non-JSON ${upstream.status} response.`,
        { status: upstream.status, body: detail },
      );
    }

    // Happy path: hand the upstream body straight to the browser without
    // buffering it, preserving status so a real RPC error stays a real error.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        ...corsHeaders(request),
      },
    });
  }
}
