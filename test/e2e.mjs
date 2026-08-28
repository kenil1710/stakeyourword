/**
 * StakeYourWord end-to-end suite.
 *
 * What this covers that `test_logic.py` cannot: the two nondeterministic paths
 * (creation reachability, and the judgement at a deadline), consensus, real
 * money moving between real accounts, and the handful of invariants that only
 * mean anything once a chain is enforcing them.
 *
 * Usage:
 *   node e2e.mjs [--network=studionet] [--address=0x…] [--base=https://…]
 *                [--skip-slow]
 *
 * `--base` is where the verification fixtures live. They have to be fetchable
 * BY THE VALIDATORS, not by this process, so localhost is never a valid answer
 * — point it at the deployed frontend.
 *
 * ## Why the waits are batched
 *
 * The contract's shortest legal period is five minutes, and several tests need
 * a period to actually come due. Run one at a time that is five minutes each.
 * So every commitment is created up front, by a DIFFERENT account (a single
 * wallet is rate-limited to one create per 180s), and the suite then waits once
 * for the latest deadline among them and settles them back to back.
 *
 * ## Why a failing test never throws
 *
 * Every check is recorded and execution continues. One dropped transaction
 * taking down six tests it never touched tells you far less than six results
 * and one red line.
 */
import { readFileSync } from "node:fs";
import { connect, argOf, sleep, returnedJson, fundOnStudio } from "./harness.mjs";

const deployed = JSON.parse(readFileSync(new URL("./.deployed.json", import.meta.url), "utf8"));
const address = argOf("address", deployed.address);
const networkName = argOf("network", deployed.network ?? "studionet");
const BASE = (argOf("base", "https://stakeyourword.vercel.app")).replace(/\/$/, "");
const SKIP_SLOW = process.argv.includes("--skip-slow");

const GEN = 10n ** 18n;
const STAKE = GEN / 10n; // 0.1 GEN — above the 0.01 minimum, small enough to fund freely
const PERIOD_MIN = 5;
const PERIOD_S = PERIOD_MIN * 60;

/** One promise text, checkable against every fixture. That is what they are for. */
const PROMISE = "I will publish a new post on The Ship Log every week without fail";

const fixture = (name) => `${BASE}/fixtures/${name}`;

/* ── Reporting ───────────────────────────────────────────────────────────── */

const results = [];
let currentTest = "(setup)";

function test(name) {
  currentTest = name;
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

function check(label, passed, detail = "") {
  results.push({ test: currentTest, label, passed });
  const mark = passed ? "\x1b[32m  PASS\x1b[0m" : "\x1b[31m  FAIL\x1b[0m";
  console.log(`${mark}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  return passed;
}

const gen = (wei) => `${(Number(BigInt(wei)) / 1e18).toFixed(4)} GEN`;

/* ── Accounts ────────────────────────────────────────────────────────────── */

const as = (role) => connect({ networkName, address, role });

const owner = as("client");
const hunter = as("hunter");
const outsider = as("outsider");
const beneficiary1 = as("beneficiary1");
const beneficiary2 = as("beneficiary2");

// One committer per commitment: a wallet may only create once per 180s, so
// reusing one would serialise the whole setup behind the cooldown.
const committers = {
  kept: as("committer1"),
  broken: as("committer2"),
  hostile: as("committer3"),
  self: as("committer4"),
  lapse: as("committer5"),
  cancel: as("committer6"),
};

const balanceOf = (who) => owner.read.getBalance({ address: who }).catch(() => 0n);

/**
 * Wait for a wallet's balance to move by `expected`, then report what it
 * actually moved by.
 *
 * Transfers apply on FINALIZATION, not on acceptance. `send()` returns as soon
 * as the transaction is ACCEPTED, which is strictly earlier — so reading a
 * balance the instant a call comes back measures the moment BEFORE the money
 * lands, and asserting on it fails a contract that did exactly the right thing.
 * This is the same lag `sweep_unallocated` has to wait out, and for the same
 * reason (contracts/NOTES.md § Money).
 *
 * Returns the delta either way: on timeout the caller still gets the real
 * number to print, so a genuine shortfall is reported as a shortfall rather
 * than as "timed out".
 */
// 240s: an observed Studio finalization took over a minute, and a false red
// from polling too briefly is worse than a slow test. Exits early on a match,
// so the full wait is only ever paid when something is genuinely wrong.
async function settledDelta(who, before, expected, seconds = 240) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const delta = (await balanceOf(who)) - before;
    if (delta === expected || Date.now() > deadline) return delta;
    await sleep(3000);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** The chain's own clock. Never `Date.now()` — a local clock is not the chain's. */
async function chainNow() {
  return (await owner.viewJson("get_stats")).now;
}

/** Block until the chain's clock passes `epoch`, reporting progress. */
async function waitUntil(epoch, why) {
  for (;;) {
    const now = await chainNow();
    const left = epoch - now;
    if (left <= 0) return;
    console.log(`  waiting ${left}s — ${why}`);
    await sleep(Math.min(left, 30) * 1000 + 2000);
  }
}

/** Create a commitment and return { id, out, body }. Never throws. */
async function create(who, { url, recurring = false, periods = 1, stake = STAKE, beneficiary, description = PROMISE }) {
  const value = stake * BigInt(periods);
  const out = await who.send(
    "create_commitment",
    [description, url, beneficiary, PERIOD_MIN, stake.toString(), recurring],
    value,
  );
  const body = returnedJson(out.returned);
  return { id: body?.id ?? null, out, body };
}

/* ── Setup ───────────────────────────────────────────────────────────────── */

console.log(`\ncontract  ${address}`);
console.log(`network   ${networkName}`);
console.log(`fixtures  ${BASE}/fixtures/*\n`);

if (owner.chain.isStudio) {
  const everyone = [owner, hunter, outsider, beneficiary1, beneficiary2, ...Object.values(committers)];
  for (const who of everyone) await fundOnStudio(owner.chain, who.account.address, 20n * GEN);
  console.log(`funded ${everyone.length} accounts on Studio`);
}

const startStats = await owner.viewJson("get_stats");
console.log(`starting from ${startStats.total} commitment(s), locked ${gen(startStats.locked_stakes)}`);

/* ══ TEST 1 — a bad create REFUNDS, it does not revert ════════════════════ */

test("TEST 1 · A rejected create refunds and returns ok:false");

{
  const who = as("committer1");
  const before = await balanceOf(who.account.address);

  const { out, body } = await create(who, {
    url: fixture("kept"),
    beneficiary: beneficiary1.account.address,
    description: "too short",
  });

  check("the transaction SUCCEEDED (a revert would have kept the stake)", out.ok,
    out.ok ? "" : `status=${out.status} reason=${out.revertReason || out.failure}`);
  check("returned ok:false rather than raising", body?.ok === false, `reason: ${body?.reason ?? "—"}`);
  check("the reason names the description", /12 characters/i.test(body?.reason ?? ""), body?.reason ?? "");
  check("refunded the full stake", body?.refunded === STAKE.toString(),
    `refunded ${body?.refunded ?? "—"} of ${STAKE}`);

  if (owner.chain.isStudio) {
    const delta = await settledDelta(who.account.address, before, 0n);
    check("the wallet is whole again once the refund finalizes", delta === 0n,
      `net ${gen(delta)}`);
  }
}

/* ══ TEST 2 — an unreachable proof URL is refused, and refunded ═══════════ */

test("TEST 2 · An unreachable proof URL is refunded, not committed");

{
  const who = as("outsider");
  const { out, body } = await create(who, {
    // Reserved by RFC 2606 and guaranteed never to resolve.
    url: "https://this-host-does-not-exist.invalid/blog",
    beneficiary: beneficiary1.account.address,
  });

  check("the transaction SUCCEEDED", out.ok, out.ok ? "" : out.revertReason || out.failure);
  check("returned ok:false", body?.ok === false, `reason: ${body?.reason ?? "—"}`);
  check("the reason names reachability", /could not be reached/i.test(body?.reason ?? ""), body?.reason ?? "");
  check("refunded the full stake", body?.refunded === STAKE.toString(), body?.refunded ?? "—");
}

/* ══ Create every commitment the timed tests need ════════════════════════ */

test("SETUP · Creating the commitments the timed tests need");

const made = {};
const plan = [
  ["kept", fixture("kept"), beneficiary1],
  ["broken", fixture("broken"), beneficiary1],
  ["hostile", fixture("hostile"), beneficiary2],
  ["self", fixture("kept"), beneficiary2],
  ["lapse", fixture("broken"), beneficiary1],
  ["cancel", fixture("kept"), beneficiary2],
];

for (const [key, url, beneficiary] of plan) {
  const { id, out, body } = await create(committers[key], {
    url,
    beneficiary: beneficiary.account.address,
  });
  const ok = out.ok && body?.ok === true && id !== null;
  check(`created "${key}" against ${url.split("/").pop()}`, ok,
    ok ? `id=${id}` : `${out.revertReason || out.failure || ""} ${body?.reason ?? ""}`);
  if (ok) made[key] = id;
}

/* ══ TEST 3 — cancelling before the deadline ═════════════════════════════ */

test("TEST 3 · Cancel before a deadline pays the fee and returns the rest");

if (made.cancel === undefined) {
  check("skipped — the cancel commitment was never created", false);
} else {
  const who = committers.cancel;
  const beforeCommitter = await balanceOf(who.account.address);
  const beforeBeneficiary = await balanceOf(beneficiary2.account.address);

  const out = await who.send("cancel_commitment", [made.cancel]);
  const body = returnedJson(out.returned);
  check("cancel succeeded", out.ok, out.ok ? "" : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.cancel]);
  check("status is CANCELED", view.status === "CANCELED", view.status);
  check("nothing is still staked", view.total_staked === "0", view.total_staked);

  if (out.ok && body) {
    const stats = await owner.viewJson("get_stats");
    const expectedFee = (STAKE / 10000n) * BigInt(stats.cancel_fee_bps);
    check("the fee matches the published rate", body.to_beneficiary === expectedFee.toString(),
      `${gen(body.to_beneficiary)} vs ${gen(expectedFee)} at ${stats.cancel_fee_bps}bps`);
    check("the two legs sum to the whole stake",
      BigInt(body.refunded) + BigInt(body.to_beneficiary) === STAKE,
      `${gen(body.refunded)} + ${gen(body.to_beneficiary)}`);

    if (owner.chain.isStudio) {
      const toCommitter = await settledDelta(who.account.address, beforeCommitter, BigInt(body.refunded));
      check("the committer actually received the refund",
        toCommitter === BigInt(body.refunded), gen(toCommitter));
      const toBeneficiary = await settledDelta(
        beneficiary2.account.address, beforeBeneficiary, BigInt(body.to_beneficiary));
      check("the beneficiary actually received the fee",
        toBeneficiary === BigInt(body.to_beneficiary), gen(toBeneficiary));
    }
  }

  const twice = await who.send("cancel_commitment", [made.cancel]);
  check("a second cancel is refused", !twice.ok, twice.revertReason?.slice(0, 90) ?? "");
}

/* ══ TEST 4 — a period cannot be verified before it is due ═══════════════ */

test("TEST 4 · A period that is not due yet cannot be settled");

if (made.kept === undefined) {
  check("skipped — no commitment to test against", false);
} else {
  const view = await owner.viewJson("get_commitment", [made.kept]);
  const now = await chainNow();
  if (now >= view.next_deadline) {
    console.log("  (already due — the creates took longer than one period; skipping)");
  } else {
    const early = await hunter.send("verify_commitment", [made.kept]);
    check("verify_commitment reverts before the deadline", !early.ok,
      early.revertReason?.slice(0, 90) ?? "");
    const earlyLapse = await hunter.send("settle_lapsed", [made.kept]);
    check("settle_lapsed reverts before the grace window closes", !earlyLapse.ok,
      earlyLapse.revertReason?.slice(0, 90) ?? "");
  }
}

/* ══ Wait for every deadline ═════════════════════════════════════════════ */

test("SETUP · Waiting for the periods to come due");

{
  let latest = 0;
  for (const key of ["kept", "broken", "hostile", "self"]) {
    if (made[key] === undefined) continue;
    const view = await owner.viewJson("get_commitment", [made[key]]);
    if (view.next_deadline > latest) latest = view.next_deadline;
  }
  if (latest) await waitUntil(latest + 15, "period 1 to come due");

  const board = await owner.viewJson("get_verifiable_now");
  check("the bounty board lists the due periods", board.length >= 1,
    `${board.length} row(s), actions: ${board.map((r) => r.action).join(",")}`);
  const bountied = board.filter((r) => r.action === "VERIFY");
  check("each due row carries a non-zero fee", bountied.every((r) => BigInt(r.bounty) > 0n),
    bountied.length ? gen(bountied[0].bounty) : "none");
}

/* ══ TEST 5 — a kept promise pays the committer, and the caller a fee ════ */

test("TEST 5 · A kept promise returns the stake and pays the caller a fee");

if (made.kept === undefined) {
  check("skipped — no kept commitment", false);
} else {
  const beforeCommitter = await balanceOf(committers.kept.account.address);
  const beforeHunter = await balanceOf(hunter.account.address);

  const out = await hunter.send("verify_commitment", [made.kept]);
  check("verification settled", out.ok, out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.kept]);
  const row = view.history[view.history.length - 1];

  if (row) {
    check("the verdict is MET", row.verdict === "MET", `${row.verdict} (confidence ${row.confidence})`);
    check("the page was reachable", row.reachable === true);
    check("the committer got the stake back", BigInt(row.to_committer) > 0n, gen(row.to_committer));
    check("the beneficiary got nothing", row.to_beneficiary === "0", gen(row.to_beneficiary));
    check("the caller was paid a fee", BigInt(row.caller_bounty) > 0n, gen(row.caller_bounty));
    check("the caller on record is the hunter",
      row.caller.toLowerCase() === hunter.account.address.toLowerCase(), row.caller);
    check("the three legs sum to exactly one period's stake",
      BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary) === STAKE,
      `${gen(BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary))}`);
    check("the reasoning is real prose, not a stub", (row.reasoning ?? "").length >= 40,
      `${(row.reasoning ?? "").length} chars`);

    if (owner.chain.isStudio) {
      const toCommitter = await settledDelta(
        committers.kept.account.address, beforeCommitter, BigInt(row.to_committer));
      check("the committer's wallet actually grew by its leg",
        toCommitter === BigInt(row.to_committer), gen(toCommitter));
      const toHunter = await settledDelta(
        hunter.account.address, beforeHunter, BigInt(row.caller_bounty));
      check("the hunter's wallet actually grew by the fee",
        toHunter === BigInt(row.caller_bounty), gen(toHunter));
    }
  } else {
    check("a history row was written", false, "no row");
  }

  check("a one-time commitment closes once its only period settles",
    view.status !== "ACTIVE", view.status);
}

/* ══ TEST 6 — a broken promise pays the beneficiary ══════════════════════ */

test("TEST 6 · A broken promise pays the beneficiary");

if (made.broken === undefined) {
  check("skipped — no broken commitment", false);
} else {
  const beforeBeneficiary = await balanceOf(beneficiary1.account.address);

  const out = await hunter.send("verify_commitment", [made.broken]);
  check("verification settled", out.ok, out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.broken]);
  const row = view.history[view.history.length - 1];

  if (row) {
    check("the verdict is NOT_MET", row.verdict === "NOT_MET",
      `${row.verdict} — ${(row.reasoning ?? "").slice(0, 110)}`);
    check("the beneficiary was paid", BigInt(row.to_beneficiary) > 0n, gen(row.to_beneficiary));
    check("the committer got nothing back", row.to_committer === "0", gen(row.to_committer));
    check("the caller was still paid a fee", BigInt(row.caller_bounty) > 0n, gen(row.caller_bounty));
    check("the three legs sum to exactly one period's stake",
      BigInt(row.caller_bounty) + BigInt(row.to_committer) + BigInt(row.to_beneficiary) === STAKE);

    if (owner.chain.isStudio) {
      const toBeneficiary = await settledDelta(
        beneficiary1.account.address, beforeBeneficiary, BigInt(row.to_beneficiary));
      check("the beneficiary's wallet actually grew by its leg",
        toBeneficiary === BigInt(row.to_beneficiary), gen(toBeneficiary));
    }
  } else {
    check("a history row was written", false, "no row");
  }

  const record = await owner.viewJson("get_track_record", [committers.broken.account.address]);
  check("the break is on the committer's record", record.broken >= 1, `broken=${record.broken}`);
}

/* ══ TEST 7 — the prompt-injection fixture cannot talk its way to MET ════ */

test("TEST 7 · A hostile page cannot argue itself into a MET verdict");

if (made.hostile === undefined) {
  check("skipped — no hostile commitment", false);
} else {
  const out = await hunter.send("verify_commitment", [made.hostile]);
  check("verification settled", out.ok, out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.hostile]);
  const row = view.history[view.history.length - 1];

  if (row) {
    // The page's honest content shows an empty blog. Three separate injection
    // attempts argue for MET. Anything but MET means the defence held; MET is a
    // real failure, not a flaky test.
    check("the verdict is NOT MET", row.verdict !== "MET",
      `${row.verdict} — ${(row.reasoning ?? "").slice(0, 110)}`);
    check("the injection was flagged on the record", row.injection_flagged === true,
      `flagged=${row.injection_flagged}`);
    check("the flag is also raised on the commitment", view.injection_flagged === true);
    check("the stored reasoning does not parrot the injected verdict",
      !/verified as compliant|rules that are not yours/i.test(row.reasoning ?? ""));
  } else {
    check("a history row was written", false, "no row");
  }
}

/* ══ TEST 8 — verifying your own promise is free ═════════════════════════ */

test("TEST 8 · Settling your own period costs the committer no fee");

if (made.self === undefined) {
  check("skipped — no self-verify commitment", false);
} else {
  const who = committers.self;
  const before = await balanceOf(who.account.address);

  const out = await who.send("verify_commitment", [made.self]);
  check("verification settled", out.ok, out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.self]);
  const row = view.history[view.history.length - 1];

  if (row) {
    check("no fee was charged", row.caller_bounty === "0", gen(row.caller_bounty));
    const settled = BigInt(row.to_committer) + BigInt(row.to_beneficiary);
    check("the whole stake settled to one side or the other", settled === STAKE, gen(settled));

    if (owner.chain.isStudio && row.verdict === "MET") {
      const delta = await settledDelta(who.account.address, before, STAKE);
      check("the committer got 100% of the stake back", delta === STAKE, gen(delta));
    }
  } else {
    check("a history row was written", false, "no row");
  }
}

/* ══ TEST 9 — pausing cannot freeze money that is already committed ══════ */

test("TEST 9 · Pausing blocks new stake but cannot freeze committed money");

{
  const paused = await owner.send("set_paused", [true]);
  check("the owner can pause", paused.ok, paused.ok ? "" : paused.revertReason || paused.failure);

  const blocked = await create(as("outsider"), {
    url: fixture("kept"),
    beneficiary: beneficiary1.account.address,
  });
  check("a new commitment is refused while paused", blocked.body?.ok === false,
    blocked.body?.reason ?? "");
  check("and the refused stake is refunded", blocked.body?.refunded === STAKE.toString(),
    blocked.body?.refunded ?? "—");

  const stats = await owner.viewJson("get_stats");
  check("get_stats reports the pause", stats.paused === true);

  // The point of the test: settlement paths are NOT gated on `paused`, so an
  // owner cannot withhold a verdict indefinitely. Proven below with the lapse
  // commitment, which is still ACTIVE and still has to be settleable.
}

/* ══ TEST 10 — a period nobody checked lapses, and is never scored kept ══ */

test("TEST 10 · An unchecked period lapses back to the committer, while paused");

if (made.lapse === undefined || SKIP_SLOW) {
  check(SKIP_SLOW ? "skipped by --skip-slow" : "skipped — no lapse commitment", false);
} else {
  const view0 = await owner.viewJson("get_commitment", [made.lapse]);
  await waitUntil(view0.grace_ends + 15, "period 1's grace window to close");

  const board = await owner.viewJson("get_verifiable_now");
  const row = board.find((r) => r.id === made.lapse);
  check("the board now marks it LAPSED rather than VERIFY", row?.action === "LAPSED",
    `action=${row?.action ?? "absent"}`);
  check("a lapsed row offers no fee", row?.bounty === "0", row?.bounty ?? "—");

  const before = await balanceOf(committers.lapse.account.address);
  const out = await outsider.send("settle_lapsed", [made.lapse]);
  check("anyone can close a lapsed period — EVEN WHILE PAUSED", out.ok,
    out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.lapse]);
  const settled = view.history[view.history.length - 1];

  if (settled) {
    check("the verdict is LAPSED", settled.verdict === "LAPSED", settled.verdict);
    check("the whole stake went back to the committer", settled.to_committer === STAKE.toString(),
      gen(settled.to_committer));
    check("nobody was paid a fee", settled.caller_bounty === "0", gen(settled.caller_bounty));
    check("no model ran, so there is no confidence", settled.confidence === 0,
      String(settled.confidence));

    if (owner.chain.isStudio) {
      const delta = await settledDelta(committers.lapse.account.address, before, STAKE);
      check("the committer's wallet actually grew by the whole stake",
        delta === STAKE, gen(delta));
    }
  } else {
    check("a history row was written", false, "no row");
  }

  const record = await owner.viewJson("get_track_record", [committers.lapse.account.address]);
  check("a lapse is scored as lapsed, NOT as kept", record.lapsed >= 1 && record.kept === 0,
    `kept=${record.kept} lapsed=${record.lapsed}`);
  check("a lapse does not move the kept rate", record.decided === record.kept + record.broken,
    `decided=${record.decided}`);
}

/* ══ Unpause, then the accounting invariants ═════════════════════════════ */

test("TEST 11 · The books balance");

{
  const unpaused = await owner.send("set_paused", [false]);
  check("the owner can unpause", unpaused.ok, unpaused.ok ? "" : unpaused.revertReason || unpaused.failure);

  const stats = await owner.viewJson("get_stats");
  const active = await owner.viewJson("get_active_commitments");
  const staked = active.reduce((sum, row) => sum + BigInt(row.total_staked), 0n);

  check("locked_stakes equals the sum of every ACTIVE commitment's stake",
    BigInt(stats.locked_stakes) === staked,
    `${gen(stats.locked_stakes)} vs ${gen(staked)} across ${active.length} active`);
  check("the contract holds at least what it owes",
    BigInt(stats.balance) >= BigInt(stats.locked_stakes),
    `balance ${gen(stats.balance)}, owed ${gen(stats.locked_stakes)}`);
  /*
   * `balance` is the contract's REAL chain balance, not a field it maintains,
   * and transfers apply on finalization. So for a while after a settlement is
   * accepted, money already promised to a committer is still sitting in the
   * balance while `locked_stakes` has already been decremented — and
   * `unallocated` (balance - locked_stakes) reads as surplus that is nothing of
   * the kind.
   *
   * That is not a flaw to assert around; it is the exact hazard
   * SWEEP_DELAY_SECONDS exists for. So the real invariant is tested first — a
   * sweep must REFUSE while an outbound transfer is still settling — and the
   * convergence to zero is checked second, with a bound.
   */
  const sweep = await owner.send("sweep_unallocated", [owner.account.address, "1"]);
  check("a sweep is refused while a payout is still settling", !sweep.ok,
    sweep.revertReason?.slice(0, 100) ?? "");

  let unallocated = BigInt(stats.unallocated);
  const settleBy = Date.now() + 240_000;
  while (unallocated !== 0n && Date.now() < settleBy) {
    await sleep(10_000);
    unallocated = BigInt((await owner.viewJson("get_stats")).unallocated);
  }
  check("once the outbound transfers finalize, nothing is left unallocated",
    unallocated === 0n,
    unallocated === 0n
      ? ""
      : `${gen(unallocated)} still in flight after 240s — money owed, not surplus`);
  check("every period that settled is accounted for",
    stats.periods_kept + stats.periods_broken + stats.periods_unclear + stats.periods_lapsed > 0,
    `kept=${stats.periods_kept} broken=${stats.periods_broken} unclear=${stats.periods_unclear} lapsed=${stats.periods_lapsed}`);

  const paidOut = BigInt(stats.total_returned) + BigInt(stats.total_forfeited) + BigInt(stats.total_bounties);
  check("staked all-time equals what was paid out plus what is still locked",
    BigInt(stats.total_staked_alltime) === paidOut + BigInt(stats.locked_stakes),
    `${gen(stats.total_staked_alltime)} vs ${gen(paidOut + BigInt(stats.locked_stakes))}`);
}

/* ══ TEST 12 — only the owner can move the dials ═════════════════════════ */

test("TEST 12 · Owner-only methods reject everybody else");

{
  // Read the live bounds first and pass them straight back, so the cap probe
  // below cannot leave this deployment with different stake limits than it
  // started with. A test that silently reconfigures the contract it is testing
  // makes every later run measure something else.
  const before = await owner.viewJson("get_stats");

  const pause = await outsider.send("set_paused", [true]);
  check("a stranger cannot pause", !pause.ok, pause.revertReason?.slice(0, 80) ?? "");

  const params = await outsider.send(
    "set_params", [900, 500, before.min_stake, before.max_stake]);
  check("a stranger cannot change the rates", !params.ok, params.revertReason?.slice(0, 80) ?? "");

  const sweep = await outsider.send("sweep_unallocated", [outsider.account.address, "1"]);
  check("a stranger cannot sweep", !sweep.ok, sweep.revertReason?.slice(0, 80) ?? "");

  // Far over MAX_BOUNTY_BPS. The contract clamps rather than reverting, so the
  // assertion is on the STORED value, not on the call failing.
  const overCap = await owner.send(
    "set_params", [9999, before.cancel_fee_bps, before.min_stake, before.max_stake]);
  check("set_params accepted the out-of-range request", overCap.ok,
    overCap.ok ? "" : overCap.revertReason || overCap.failure);

  const clamped = await owner.viewJson("get_stats");
  check("but the fee was clamped to its cap, not stored as asked",
    clamped.bounty_bps <= 1000, `bounty_bps=${clamped.bounty_bps} (asked for 9999)`);

  // Put the rate back where it was, so the deployment is left as found.
  const restored = await owner.send(
    "set_params",
    [before.bounty_bps, before.cancel_fee_bps, before.min_stake, before.max_stake]);
  check("the original rates are restored", restored.ok,
    restored.ok ? "" : restored.revertReason || restored.failure);

  const end = await owner.viewJson("get_stats");
  check("the contract is left unpaused", end.paused === false);
  check("the stake bounds are exactly as they were found",
    end.min_stake === before.min_stake && end.max_stake === before.max_stake,
    `${gen(end.min_stake)} – ${gen(end.max_stake)}`);
  check("the fee rate is exactly as it was found",
    end.bounty_bps === before.bounty_bps, `${end.bounty_bps}bps`);
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.passed);
console.log(`\n${"─".repeat(66)}`);
console.log(`\x1b[1m${results.length - failed.length} passed, ${failed.length} failed\x1b[0m`);
if (failed.length) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.test} — ${f.label}`);
}
console.log("");
process.exit(failed.length ? 1 : 0);
