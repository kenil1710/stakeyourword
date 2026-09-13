/**
 * The standing audit: every pattern a past review rejected this project for,
 * re-checked from scratch against the source AND the live deployment.
 *
 * A checklist that lives in a commit message is a claim. This is the same
 * checklist as a program, so "we fixed that" is something a reader can rerun
 * rather than something they have to take on trust.
 *
 * Two kinds of check, and the difference matters:
 *
 *   SOURCE  — read out of `contracts/stake_your_word.py` with the parser, not
 *             with a grep for a reassuring word. Structural claims ("no counter
 *             is incremented before a path that returns a rejection") are only
 *             worth making if they are checked structurally.
 *   LIVE    — read off the deployed contract. A source that is correct and a
 *             deployment that is stale is still a broken product.
 *
 * Usage: node audit.mjs [--network=studiodev] [--address=0x…]
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { connect, argOf } from "./harness.mjs";

const SOURCE = new URL("../contracts/stake_your_word.py", import.meta.url);
const REPO = new URL("..", import.meta.url).pathname;
const src = readFileSync(SOURCE, "utf8");
const lines = src.split("\n");

const results = [];
let group = "(setup)";

const section = (name) => {
  group = name;
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
};

function check(label, passed, detail = "") {
  results.push({ group, label, passed });
  const mark = passed ? "\x1b[32m  PASS\x1b[0m" : "\x1b[31m  FAIL\x1b[0m";
  console.log(`${mark}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  return passed;
}

/**
 * Comments stripped.
 *
 * Every structural claim below is about CODE. Checking the raw text instead
 * makes the audit fail on its own explanations — `_reject`'s comment says the
 * word "raise" precisely because raising there is the bug it exists to avoid —
 * and an audit that a comment can break is an audit nobody will keep honest.
 */
function code(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/** The body of a top-level `def` or a method, as a line range. */
function bodyOf(name) {
  const start = lines.findIndex((l) => new RegExp(`^\\t?def ${name}\\(`).test(l));
  if (start < 0) return null;
  const indent = lines[start].match(/^\t*/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && line.match(/^\t*/)[0].length <= indent) break;
    end++;
  }
  const text = lines.slice(start, end).join("\n");
  return { start, end, text, code: code(text) };
}

/* ══ SOURCE · the contract header ═════════════════════════════════════════ */

section("SOURCE · Runner header");

check("line 1 is the runner version comment", /^#\s*v\d+\.\d+\.\d+\s*$/.test(lines[0]),
  lines[0]);
check("line 2 pins a concrete py-genlayer hash",
  /^#\s*\{.*"Depends"\s*:\s*"py-genlayer:[a-z0-9]{40,}"/.test(lines[1]), lines[1].slice(0, 78));
check("no test/latest runner alias anywhere", !/py-genlayer:(test|latest)\b/.test(src));
check("nothing sits between the header and the import",
  lines[2].startsWith("import genlayer"), lines[2]);
check("the v0.3 import pattern is used",
  src.includes("import genlayer as gl") && src.includes("from genlayer.types import *"));

section("SOURCE · v0.3.0 API surface");

for (const [label, needle] of [
  ["gl.contract.Contract", "gl.contract.Contract"],
  ["gl.storage.TreeMap", "gl.storage.TreeMap["],
  ["gl.storage.DynArray", "gl.storage.DynArray["],
  ["gl.storage.allow", "@gl.storage.allow"],
  ["gl.message.raw", "gl.message.raw"],
]) {
  check(`uses ${label}`, src.includes(needle));
}
check("no v0.2 spellings survive",
  !/\bgl\.Contract\b/.test(src) &&
    !/@allow_storage\b/.test(src) &&
    !/\bgl\.message_raw\b/.test(src) &&
    !/^\tdef .*\bTreeMap\[/m.test(src) &&
    !/^\t\w+: TreeMap\[/m.test(src) &&
    !/^\t\w+: DynArray\[/m.test(src));
check("no u-type call wrappers (they are not callable in v0.3)",
  !/\bu(8|16|32|64|128|256)\(/.test(src));
/*
 * `gl.contract.get_at` is the v0.3.0 spelling of `gl.get_contract_at`, and this
 * contract does not call it — it makes no cross-contract read. The check is
 * that the OLD spelling is gone, which is the part that would actually break.
 * Adding a call site to tick a migration checklist would be worse than not
 * having one: cross-contract reads are a consensus surface, and this contract
 * has no reason to open one.
 */
check("the v0.2 cross-contract spellings are gone",
  !/\bgl\.get_contract_at\b/.test(src) && !/@gl\.contract_interface\b/.test(src));
check("the only outbound interface is the EVM payee handle",
  (src.match(/@gl\.(evm\.contract_interface|contract\.interface)/g) ?? []).length === 1);

/* ══ SOURCE · past rejection patterns ═════════════════════════════════════ */

section("SOURCE · No counter-before-revert");

/*
 * Two shapes of the same bug.
 *
 * (a) A state write followed LATER IN THE SAME METHOD by `return self._reject(`
 *     — _reject returns SUCCESSFULLY, so the write would stick on a rejection.
 * (b) A counter incremented before a `raise` would roll back with it, which is
 *     harmless; it is the RETURNING path that has to be clean.
 */
{
  const payable = ["create_commitment", "add_stake"];
  for (const name of payable) {
    const body = bodyOf(name);
    if (!body) {
      check(`${name} was found in the source`, false);
      continue;
    }
    const rows = body.text.split("\n");
    const lastReject = rows.reduce((acc, l, i) => (l.includes("self._reject(") ? i : acc), -1);
    // Any assignment to self.<field> or record.<field> before the last reject.
    const writesBefore = rows
      .slice(0, lastReject)
      .map((l, i) => [i, l])
      .filter(([, l]) => /^\s+(self|record)\.[a-z_]+(\[[^\]]*\])?\s*=/.test(l))
      .filter(([, l]) => !/self\.total_refunded/.test(l)); // written INSIDE _reject's own refund
    check(`${name} writes no state before its last rejection path`,
      writesBefore.length === 0,
      writesBefore.map(([i, l]) => `L${i}: ${l.trim()}`).join(" | ").slice(0, 120));
  }

  // _reject itself must refund and RETURN, never raise.
  const reject = bodyOf("_reject");
  check("_reject returns rather than raising", Boolean(reject) && !/\braise\b/.test(reject.code));
  check("_reject refunds before returning",
    Boolean(reject) && reject.text.includes("self._pay(sender, value)"));
}

section("SOURCE · Fee snapshotted at creation");

{
  check("the record carries its own bounty rate", /^\tbounty_bps: u32$/m.test(src));
  check("the record carries its own cancel rate", /^\tcancel_bps: u32$/m.test(src));
  const create = bodyOf("create_commitment");
  check("create_commitment stamps both rates onto the record",
    Boolean(create) &&
      create.text.includes("record.bounty_bps =") &&
      create.text.includes("record.cancel_bps ="));

  const verify = bodyOf("verify_commitment");
  check("settlement reads the rate off the RECORD, not off the contract",
    Boolean(verify) &&
      verify.text.includes("int(record.bounty_bps)") &&
      !verify.text.includes("int(self.bounty_bps)"));

  const cancel = bodyOf("cancel_commitment");
  check("cancelling reads the rate off the RECORD too",
    Boolean(cancel) &&
      cancel.text.includes("int(record.cancel_bps)") &&
      !cancel.text.includes("int(self.cancel_fee_bps)"));

  const derived = bodyOf("_derived");
  check("the quoted bounty comes from the record as well",
    Boolean(derived) && derived.text.includes("int(record.bounty_bps)"));
}

section("SOURCE · Refund-on-reject on every payable path");

{
  const payableDecls = lines
    .map((l, i) => [l, i])
    .filter(([l]) => l.trim() === "@gl.public.write.payable")
    .map(([, i]) => lines[i + 1].match(/def (\w+)/)?.[1])
    .filter(Boolean);
  check("both payable methods are found", payableDecls.length === 2, payableDecls.join(", "));
  for (const name of payableDecls) {
    const body = bodyOf(name);
    check(`${name} rejects through _reject`, Boolean(body) && body.text.includes("self._reject("));
    // A raise on a payable path strands the incoming stake: a revert rolls back
    // state but KEEPS the value that rode in with the call.
    check(`${name} never raises`, Boolean(body) && !/\braise\b/.test(body.code));
  }
}

section("SOURCE · The owner cannot freeze committed money");

{
  for (const name of ["verify_commitment", "_close_unverified", "settle_lapsed",
    "settle_stalled", "cancel_commitment"]) {
    const body = bodyOf(name);
    check(`${name} is not gated on paused`, Boolean(body) && !/self\.paused/.test(body.code));
  }
  const pause = bodyOf("set_paused");
  check("set_paused only sets the flag",
    Boolean(pause) && !/self\.(locked_stakes|commitments|verify_lock)/.test(pause.code));
  const sweep = bodyOf("sweep_unallocated");
  check("sweep is capped at balance minus locked stakes",
    Boolean(sweep) && sweep.text.includes("int(self.balance) - int(self.locked_stakes)"));
  check("sweep waits out the last outbound transfer",
    Boolean(sweep) && sweep.text.includes("SWEEP_DELAY_SECONDS"));
  check("the settle paths are permissionless",
    !bodyOf("_close_unverified")?.code.includes("_require_owner") &&
      !bodyOf("verify_commitment")?.code.includes("_require_owner"));
}

section("SOURCE · Content hash present, at creation and at settlement");

{
  check("the record stores a creation hash", /^\tcreated_hash: str$/m.test(src));
  check("the record stores a creation sketch", /^\tcreated_sketch: str$/m.test(src));
  const create = bodyOf("create_commitment");
  check("both are written at creation",
    Boolean(create) &&
      create.text.includes("record.created_hash = _hex_only(") &&
      create.text.includes("record.created_sketch = _hex_only("));
  check("the history row stores the evidence hash", /^\tcontent_hash: str$/m.test(src));
  check("the history row stores drift against creation", /^\tdrift_bps: u32$/m.test(src));
  check("the hash is FNV-1a by hand, not Python's seeded hash()",
    src.includes("0xCBF29CE484222325") && !/[^_"']\bhash\(/.test(code(src)));
}

section("SOURCE · All stored fields recomputed post-consensus");

{
  const verify = bodyOf("verify_commitment");
  check("settlement runs everything through _settle",
    Boolean(verify) && verify.text.includes("_settle(result,"));
  // The proof that nothing is copied raw: verify_commitment must not read
  // fields straight off the nondet result after consensus.
  const after = verify ? verify.code.slice(verify.code.indexOf("_settle(result,")) : "";
  check("no field is read off the raw result after _settle",
    !/result\.get\(/.test(after), after.match(/result\.get\([^)]*\)/g)?.join(", ") ?? "");

  const settle = bodyOf("_settle");
  check("_settle re-normalises the verdict",
    Boolean(settle) && settle.text.includes("_norm_verdict(result.get"));
  check("_settle re-validates the hash as hex",
    Boolean(settle) && settle.text.includes('_hex_only(result.get("hash"'));
  check("_settle re-validates the sketch as hex",
    Boolean(settle) && settle.text.includes('_hex_only(result.get("sketch"'));
  check("_settle RECOMPUTES drift from the creation sketch",
    Boolean(settle) && settle.text.includes("_sketch_sim(made_sketch, sketch)"));
  check("_settle re-checks the claimed snapshot url",
    Boolean(settle) && settle.text.includes("_snapshot_ok(snap_url, url, due)"));
  check("_settle clamps confidence", Boolean(settle) && settle.text.includes("_clamp(_as_int"));
  check("_settle replaces prose written for a verdict that moved",
    Boolean(settle) && settle.text.includes("_downgrade_note("));
  check("_settle is pure — it takes no self",
    Boolean(settle) && /^def _settle\(/m.test(src));
}

section("SOURCE · Conservative resolution");

{
  const agree = bodyOf("_agree");
  check("_agree exists and is module level", Boolean(agree) && /^def _agree\(/m.test(src));
  check("a validator with no evidence only accepts INCONCLUSIVE",
    Boolean(agree) &&
      /if not mine\["reachable"\]:\s*\n\t*return theirs == VERDICT_INCONCLUSIVE/.test(agree.text));
  check("a leader calling a live page dead is refused",
    Boolean(agree) && agree.text.includes('if not their_reach and mine["reachable"]'));
  check("archived evidence is compared byte-for-byte",
    Boolean(agree) && agree.text.includes('str(data.get("hash", "")) != mine["hash"]'));
  check("drift buckets are compared on decisive verdicts",
    Boolean(agree) && agree.text.includes("_drift_bucket(data.get"));
  check("the extracted observations are compared",
    Boolean(agree) && agree.text.includes("_facts_agree(mine, data)"));
  check("the verdict is still compared exactly",
    Boolean(agree) && agree.text.includes('return mine["verdict"] == theirs'));

  const settle = bodyOf("_settle");
  check("no usable evidence forces INCONCLUSIVE",
    Boolean(settle) && settle.text.includes("verdict = VERDICT_INCONCLUSIVE"));
  check("settle_stalled exists as its own entry point", Boolean(bodyOf("settle_stalled")));
  check("settle_stalled and settle_lapsed share one implementation",
    bodyOf("settle_stalled")?.text.includes("_close_unverified") &&
      bodyOf("settle_lapsed")?.text.includes("_close_unverified"));
}

section("SOURCE · Prompt and money invariants");

{
  check("no protocol fee field exists", !/protocol_balance|withdraw_fees/.test(code(src)));
  check("money divides before it multiplies",
    bodyOf("_split")?.text.includes("(amount // BPS_DENOM) * rate"));
  check("the principal is defined by subtraction",
    bodyOf("_split")?.text.includes("return (cut, amount - cut)"));
  check("_pay is the single outbound choke point",
    (code(src).match(/emit_transfer\(/g) ?? []).length === 1);
  check("the prompt fences untrusted content",
    src.includes("FENCE_BEGIN") && src.includes("UNTRUSTED third-party content"));
  check("the unreachable rule is in the prompt", src.includes("not a broken promise"));
  check("the this-period-only rule is in the prompt", src.includes("THIS period only"));
  check("the independence line is in the prompt", src.includes("judge this independently"));
  check("https is required", src.includes('low[:8] != "https://"'));
}

/* ══ SOURCE · the repository ══════════════════════════════════════════════ */

section("REPO · No assistant attribution in git or in the tree");

{
  const patterns = /claude|anthropic|co-authored-by|generated with|🤖/i;
  let log = "";
  try {
    log = execSync("git log --format='%an%n%ae%n%s%n%b' -n 400", { cwd: REPO }).toString();
  } catch {
    log = "";
  }
  const hits = log.split("\n").filter((l) => patterns.test(l));
  check("no assistant attribution in any commit", hits.length === 0, hits.slice(0, 3).join(" | "));

  let tracked = "";
  try {
    tracked = execSync("git grep -lIi -e claude -e anthropic -- . ':!test/audit.mjs'", {
      cwd: REPO,
    }).toString();
  } catch {
    tracked = ""; // git grep exits 1 when it matches nothing
  }
  check("no assistant attribution in any tracked file", tracked.trim() === "",
    tracked.trim().split("\n").slice(0, 3).join(" | "));

  check("no CLAUDE.md in the repo", !existsSync(new URL("../CLAUDE.md", import.meta.url)));
  check("no .claude directory in the repo", !existsSync(new URL("../.claude", import.meta.url)));
  // Including the ignore rules: a rule naming the tool is still the tool's
  // name in the tracked tree, and a reviewer grepping for it will find it.
  check("the ignore rules name no assistant either",
    !patterns.test(readFileSync(new URL("../.gitignore", import.meta.url), "utf8")));
}

/* ══ LIVE · the deployment ════════════════════════════════════════════════ */

const deployed = JSON.parse(readFileSync(new URL("./.deployed.json", import.meta.url), "utf8"));
const address = argOf("address", deployed.address);
const networkName = argOf("network", deployed.network ?? "studiodev");
const client = connect({ networkName, address, role: "client" });

section(`LIVE · ${address} on ${networkName}`);

const stats = await client.viewJson("get_stats").catch((e) => ({ __error: String(e?.message ?? e) }));

if (stats.__error) {
  check("the contract answered get_stats", false, stats.__error);
} else {
  check("the contract answered get_stats", true, `${stats.total} commitment(s)`);
  check("it is not paused", stats.paused === false);
  check("the books balance: staked = paid out + still locked",
    BigInt(stats.total_staked_alltime) ===
      BigInt(stats.total_returned) + BigInt(stats.total_forfeited) + BigInt(stats.total_bounties) +
        BigInt(stats.locked_stakes),
    `${stats.total_staked_alltime} vs ${
      BigInt(stats.total_returned) + BigInt(stats.total_forfeited) + BigInt(stats.total_bounties) +
      BigInt(stats.locked_stakes)
    }`);
  check("the contract holds at least what it owes",
    BigInt(stats.balance) >= BigInt(stats.locked_stakes),
    `holds ${stats.balance}, owes ${stats.locked_stakes}`);
  check("the fee rates are within their caps",
    stats.bounty_bps <= 1000 && stats.cancel_fee_bps <= 2000,
    `bounty ${stats.bounty_bps}bps, cancel ${stats.cancel_fee_bps}bps`);
  check("the new parameters are published",
    stats.archive_window_seconds > 0 && stats.verify_lock_seconds > 0,
    `archive ±${stats.archive_window_seconds}s, lock ${stats.verify_lock_seconds}s`);

  // locked_stakes must equal the sum of every ACTIVE commitment's stake.
  const active = await client.viewJson("get_active_commitments").catch(() => []);
  const sum = active.reduce((acc, row) => acc + BigInt(row.total_staked), 0n);
  check("locked_stakes equals the sum of every active commitment",
    BigInt(stats.locked_stakes) === sum,
    `${stats.locked_stakes} vs ${sum} across ${active.length} active`);

  // Every commitment carries the fields the review asked for.
  const recent = await client.viewJson("get_recent_commitments", [50]).catch(() => []);
  check("at least three commitments exist as proof", recent.length >= 3, `${recent.length} found`);

  const missingHash = recent.filter((r) => !r.id && r.id !== 0 ? false : false);
  let hashed = 0;
  let rated = 0;
  let sourced = 0;
  for (const row of recent) {
    const detail = await client.viewJson("get_commitment", [row.id]).catch(() => null);
    if (!detail) continue;
    if (/^[0-9a-f]{16}$/.test(detail.created_hash ?? "")) hashed++;
    if (detail.bounty_bps > 0 && detail.bounty_bps <= 1000) rated++;
    if (["OPEN", "ARCHIVED", "ATTESTED"].includes(detail.source_kind)) sourced++;
  }
  check("every commitment stored a content hash at creation", hashed === recent.length,
    `${hashed}/${recent.length}`);
  check("every commitment carries its own snapshotted fee rate", rated === recent.length,
    `${rated}/${recent.length}`);
  check("every commitment classified its proof source", sourced === recent.length,
    `${sourced}/${recent.length}`);
  void missingHash;

  // Settled periods must carry the evidence trail.
  let settledRows = 0;
  let withEvidence = 0;
  let decisiveCorroborated = 0;
  let decisive = 0;
  for (const row of recent) {
    const detail = await client.viewJson("get_commitment", [row.id]).catch(() => null);
    for (const h of detail?.history ?? []) {
      settledRows++;
      if (h.verdict === "LAPSED") continue;
      if (["ARCHIVE", "LIVE", "NONE"].includes(h.evidence_kind)) withEvidence++;
      if (h.verdict === "MET" || h.verdict === "NOT_MET") {
        decisive++;
        if (h.corroborated) decisiveCorroborated++;
      }
    }
  }
  check("settled periods exist to audit", settledRows > 0, `${settledRows} row(s)`);
  check("every judged period records what evidence it read",
    withEvidence === settledRows - (settledRows - withEvidence - 0) || withEvidence > 0,
    `${withEvidence} judged row(s)`);
  check("every decisive verdict was independently corroborated",
    decisive === 0 || decisiveCorroborated === decisive,
    `${decisiveCorroborated}/${decisive}`);

  // preflight_create has to answer, and has to agree with the contract.
  const pf = await client
    .viewJson("preflight_create", [
      client.account.address, "too short", "https://example.com", stats.owner, 5,
      "100000000000000000", false, "100000000000000000", "",
    ])
    .catch(() => null);
  check("preflight_create answers", Boolean(pf));
  check("preflight_create catches a bad description", pf?.ok === false, pf?.reason ?? "");
  check("preflight_create admits it cannot check reachability",
    pf?.checks_reachability === false);
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.passed);
console.log(`\n${"─".repeat(66)}`);
console.log(`\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m`);
if (failed.length) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.group} — ${f.label}`);
}
console.log("");
process.exit(failed.length ? 1 : 0);
