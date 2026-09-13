/**
 * A commitment judged on an IMMUTABLE SNAPSHOT, end to end.
 *
 * The `/fixtures` pages exist to be judged, but no public archive holds
 * captures of them — so an e2e run against those exercises the LIVE evidence
 * path and never the archived one. This script covers what that leaves out:
 *
 *   1. create a commitment with `archive_url` pinned to a real Wayback capture,
 *      which classifies the source as ATTESTED;
 *   2. wait for period 1;
 *   3. verify, and show that the settled row records
 *      `evidence_kind = ARCHIVE`, the snapshot URL it was read from, and a
 *      content hash — the axis validators compare byte-for-byte, because an
 *      immutable capture is the same bytes for everyone who fetches it.
 *
 * The pinned URL uses the `id_` modifier: the raw archived bytes rather than
 * the page the archive wraps them in, which carries a live banner and would
 * differ between two fetches of the same capture.
 *
 * Usage: node proof-archive.mjs [--network=studiodev] [--role=committer3]
 */
import { readFileSync } from "node:fs";
import { connect, argOf, sleep, returnedJson, fundOnStudio } from "./harness.mjs";

const deployed = JSON.parse(readFileSync(new URL("./.deployed.json", import.meta.url), "utf8"));
const address = argOf("address", deployed.address);
const networkName = argOf("network", deployed.network ?? "studiodev");
const role = argOf("role", "committer3");

const GEN = 10n ** 18n;
const STAKE = GEN / 10n;
const PERIOD_MIN = 5;

/** A stable page, and a capture of it the Wayback Machine really holds. */
const PROOF_URL = "https://example.com/";
const SNAPSHOT = "https://web.archive.org/web/20250101004557id_/https://example.com/";
const PROMISE =
  "The page at example.com will still say it is for use in illustrative examples in documents";

const who = connect({ networkName, address, role });
const reader = connect({ networkName, address, role: "client" });

const results = [];
function check(label, passed, detail = "") {
  results.push({ label, passed });
  console.log(`${passed ? "\x1b[32m  PASS\x1b[0m" : "\x1b[31m  FAIL\x1b[0m"}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}

console.log(`\ncontract ${address} on ${networkName}`);
console.log(`proof    ${PROOF_URL}`);
console.log(`pinned   ${SNAPSHOT}\n`);

if (who.chain.isStudio) {
  await fundOnStudio(who.chain, who.account.address, 20n * GEN);
}

/* ── The snapshot has to actually be there ───────────────────────────────── */

const head = await fetch(SNAPSHOT, { redirect: "follow" })
  .then((r) => r.text())
  .catch(() => "");
check("the pinned snapshot is reachable from here", head.length > 0, `${head.length} bytes`);

/* ── 1. Create, with the snapshot pinned ─────────────────────────────────── */

console.log("\n\x1b[1m── Creating an ATTESTED commitment\x1b[0m");

const created = await who.send(
  "create_commitment",
  [PROMISE, PROOF_URL, reader.account.address, PERIOD_MIN, STAKE.toString(), false, SNAPSHOT],
  STAKE,
);
const body = returnedJson(created.returned);
check("the create settled", created.ok, created.ok ? created.hash : created.revertReason || created.failure);
check("the contract accepted it", body?.ok === true, body?.reason ?? "");
check("it is classified ATTESTED", body?.source_kind === "ATTESTED", body?.source_kind ?? "—");
check("a content hash was stored at creation", /^[0-9a-f]{16}$/.test(body?.content_hash ?? ""),
  body?.content_hash ?? "—");

const id = body?.id;
if (id === undefined || id === null) {
  console.log("\ncould not create the commitment; stopping\n");
  process.exit(1);
}
console.log(`  commitment #${id}, tx ${created.hash}`);

/* ── 2. Wait for the deadline ────────────────────────────────────────────── */

console.log("\n\x1b[1m── Waiting for period 1\x1b[0m");

const view0 = await reader.viewJson("get_commitment", [id]);
check("the pinned snapshot is on the record", view0.archive_url === SNAPSHOT, view0.archive_url);

for (;;) {
  const stats = await reader.viewJson("get_stats");
  const left = view0.next_deadline - stats.now;
  if (left <= 0) break;
  console.log(`  waiting ${left}s`);
  await sleep(Math.min(left, 30) * 1000 + 3000);
}

/* ── 3. Verify, and read the evidence trail ──────────────────────────────── */

console.log("\n\x1b[1m── Verifying against the pinned snapshot\x1b[0m");

const settled = await who.send("verify_commitment", [id]);
check("the verification settled", settled.ok,
  settled.ok ? `${settled.returned} · ${settled.hash}` : settled.revertReason || settled.failure);

const view = await reader.viewJson("get_commitment", [id]);
const row = view.history[view.history.length - 1];

if (!row) {
  check("a history row was written", false, "no row");
} else {
  console.log(`  verdict ${row.verdict} · confidence ${row.confidence}`);
  check("the verdict was read from an ARCHIVED snapshot", row.evidence_kind === "ARCHIVE",
    row.evidence_kind);
  check("the snapshot it read is on the record", row.snapshot_url === SNAPSHOT,
    row.snapshot_url || "—");
  check("the evidence hash is recorded", /^[0-9a-f]{16}$/.test(row.content_hash ?? ""),
    row.content_hash ?? "—");
  check("the deadline it was judged against is recorded",
    row.deadline === view.created_at + view.period_seconds, String(row.deadline));
  check("it is marked independently corroborated", row.corroborated === true,
    String(row.corroborated));
  check("drift against creation was recomputed on chain",
    Number.isInteger(row.drift_bps) && row.drift_bps >= 0 && row.drift_bps <= 10000,
    `${row.drift_bps} bps`);
  check("the reasoning is real prose", (row.reasoning ?? "").length >= 40,
    `${(row.reasoning ?? "").length} chars`);
  const legs = BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary);
  check("the three legs sum to exactly one period's stake", legs === STAKE, String(legs));
  console.log(`\n  "${(row.reasoning ?? "").slice(0, 240)}"`);
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${"─".repeat(60)}`);
console.log(`\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m`);
for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.label}`);
console.log("");
process.exit(failed.length ? 1 : 0);
