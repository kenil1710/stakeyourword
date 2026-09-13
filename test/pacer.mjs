/**
 * A global rate limiter for outgoing JSON-RPC, installed by wrapping `fetch`.
 *
 * WHY AT THE TRANSPORT.
 *
 * Studio Devnet meters per IP at 30 requests a minute, and the suite blows
 * through that without trying: one `send()` is a fee estimate (which is itself
 * two calls), a balance read, a submission, and then a poll every couple of
 * seconds until the transaction settles. Pacing at the call sites means finding
 * every call site — including the ones inside genlayer-js and viem, which is
 * where most of them are. Pacing `fetch` catches all of them, because every one
 * of them ends up here.
 *
 * The bucket is deliberately smaller than the published limit. The window the
 * server enforces is not aligned with ours, so a bucket sized exactly to 30
 * spends its whole allowance in the first half of the server's window and trips
 * anyway; leaving headroom is what makes the limit a pace rather than a wall.
 *
 * Retrying a 429 is still worth doing — see `retry` in harness.mjs — but a
 * retry is recovery, and recovery should be the rare path. This is the one that
 * keeps it rare.
 */

const WINDOW_MS = 60_000;
/** Under the published 30/min, because the two windows are not aligned. */
const PER_WINDOW = 22;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stamps = [];
/** Serialises the wait so N concurrent callers cannot all pass the same check. */
let queue = Promise.resolve();

function metered(url) {
  const target = String(url);
  return target.includes("genlayer.com") || target.includes("127.0.0.1");
}

async function takeToken() {
  for (;;) {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < WINDOW_MS);
    if (stamps.length < PER_WINDOW) {
      stamps.push(now);
      return;
    }
    // Wait until the oldest stamp falls out of the window, plus a little, so
    // the next check cannot land on the same millisecond it expires.
    await sleep(WINDOW_MS - (now - stamps[0]) + 250);
  }
}

/**
 * Install once. Idempotent — importing this module twice must not stack two
 * wrappers, which would double every delay.
 */
export function installPacer() {
  if (globalThis.__genlayerPacerInstalled) return;
  globalThis.__genlayerPacerInstalled = true;

  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (!metered(url)) return original(input, init);
    queue = queue.then(takeToken);
    await queue;
    return original(input, init);
  };
}

/** How much of the current window is spent. For progress lines. */
export function pacerLoad() {
  const now = Date.now();
  return `${stamps.filter((t) => now - t < WINDOW_MS).length}/${PER_WINDOW} rpc this minute`;
}
