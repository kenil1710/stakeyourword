/**
 * StakeYourWord end-to-end suite.
 *
 * What this covers that `test_logic.py` cannot: the two nondeterministic paths
 * (creation reachability, and the judgement at a deadline), consensus, real
 * money moving between real accounts, and the handful of invariants that only
 * mean anything once a chain is enforcing them.
 *
 * Usage:
 *   node e2e.mjs [--network=studiodev] [--address=0x…] [--base=https://…]
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
const networkName = argOf("network", deployed.network ?? "studiodev");
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
  stalled: as("committer7"),
  rates: as("committer8"),
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
//
// `slack` exists because Studio Devnet is NOT gasless. A wallet that SENT the
// transaction also paid its fee, so its balance can never return to an exact
// expected delta — the fee is subtracted on top. Accounts that only RECEIVE a
// payout are still asserted exactly; only the payer gets the tolerance, and it
// is bounded well below a single period's stake so it cannot hide a missing
// leg.
const FEE_SLACK = GEN / 50n; // 0.02 GEN — an order of magnitude over an observed write fee

async function settledDelta(who, before, expected, { seconds = 300, slack = 0n } = {}) {
  const deadline = Date.now() + seconds * 1000;
  const hit = (delta) => delta <= expected && delta >= expected - slack;
  for (;;) {
    const delta = (await balanceOf(who)) - before;
    // 8s, not 3s: every read is metered, and a balance that has not landed yet
    // will not land any sooner for being asked three times as often.
    if (hit(delta) || Date.now() > deadline) return delta;
    await sleep(8000);
  }
}

/** The delta a wallet that also PAID THE FEE should land in. */
const paidBy = (who, before, expected) =>
  settledDelta(who, before, expected, { slack: FEE_SLACK });

/** True when a payer's delta is the expected amount, less at most one fee. */
const netOf = (delta, expected) => delta <= expected && delta >= expected - FEE_SLACK;

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
async function create(who, { url, recurring = false, periods = 1, stake = STAKE, beneficiary, description = PROMISE, archive = "" }) {
  const value = stake * BigInt(periods);
  const out = await who.send(
    "create_commitment",
    [description, url, beneficiary, PERIOD_MIN, stake.toString(), recurring, archive],
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
  // `empty` is deliberately left at zero: TEST 13 reproduces the production
  // LackOfFundForMaxFee against it and proves the preflight catches it first.
  console.log(`left "empty" (${as("empty").account.address}) unfunded on purpose`);
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

  {
    // The stake comes all the way back; only the network fee is gone.
    const delta = await paidBy(who.account.address, before, 0n);
    check("the stake is whole again once the refund finalizes, less only the fee",
      netOf(delta, 0n), `net ${gen(delta)} (fee only)`);
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
  ["stalled", fixture("stale"), beneficiary1],
  ["rates", fixture("kept"), beneficiary2],
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

    {
      // The committer sent the cancel, so its delta carries the network fee.
      const toCommitter = await paidBy(who.account.address, beforeCommitter, BigInt(body.refunded));
      check("the committer actually received the refund",
        netOf(toCommitter, BigInt(body.refunded)), gen(toCommitter));
      // The beneficiary only receives, so this one is exact.
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

    {
      const toCommitter = await settledDelta(
        committers.kept.account.address, beforeCommitter, BigInt(row.to_committer));
      check("the committer's wallet actually grew by its leg",
        toCommitter === BigInt(row.to_committer), gen(toCommitter));
      // The hunter both paid the network fee and collected the bounty.
      const toHunter = await paidBy(
        hunter.account.address, beforeHunter, BigInt(row.caller_bounty));
      check("the hunter's wallet actually grew by the bounty, less the network fee",
        netOf(toHunter, BigInt(row.caller_bounty)), gen(toHunter));
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

    {
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

    if (row.verdict === "MET") {
      // Self-verification: the committer paid the network fee and got the
      // whole stake back, with no bounty carved out of it.
      const delta = await paidBy(who.account.address, before, STAKE);
      check("the committer got 100% of the stake back, less only the network fee",
        netOf(delta, STAKE), gen(delta));
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

    {
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
  const settleBy = Date.now() + 300_000;
  while (unallocated !== 0n && Date.now() < settleBy) {
    await sleep(15_000);
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

/* ══ TEST 13 — the preflight that stops LackOfFundForMaxFee ══════════════ */

test("TEST 13 · Every write is quoted and balance-checked before it is signed");

{
  const who = as("outsider");
  const args = [PROMISE, fixture("kept"), beneficiary1.account.address, PERIOD_MIN,
    STAKE.toString(), false, ""];

  const quote = await who.quote("create_commitment", args, STAKE);
  check("a fee estimate is produced for the exact call", quote.feeValue > 0n,
    `${gen(quote.feeValue)} of fees`);
  check("the required amount is the stake plus the fee",
    quote.required === quote.userValue + quote.feeValue,
    `${gen(quote.required)} = ${gen(quote.userValue)} + ${gen(quote.feeValue)}`);
  check("a funded wallet passes the preflight", quote.ok,
    quote.ok ? `holds ${gen(quote.balance)}` : quote.reason);

  /*
   * The production failure, reproduced and then caught.
   *
   * A wallet holding nothing is exactly the state every Bradbury account was
   * in when Chrome reported LackOfFundForMaxFee. The preflight has to refuse
   * it HERE — before anything is signed — rather than let the consensus
   * contract revert and the retry surface as an eth_sendRawTransaction
   * request-format error.
   */
  const empty = connect({ networkName, address, role: "empty" });
  const emptyBalance = await balanceOf(empty.account.address);
  check("the probe wallet really is empty", emptyBalance === 0n, gen(emptyBalance));

  const broke = await empty.quote("create_commitment", args, STAKE);
  check("an unfundable write fails the preflight", !broke.ok, broke.reason.slice(0, 80));
  check("the refusal names the amount needed", /You need [\d.]+ GEN/.test(broke.reason),
    broke.reason);
  check("the refusal names the shortfall", /short by [\d.]+ GEN/.test(broke.reason));
  check("the shortfall is the whole requirement on an empty wallet",
    broke.shortfall === broke.required, `${gen(broke.shortfall)}`);

  const refused = await empty.send("create_commitment", args, STAKE);
  check("send() refuses locally rather than submitting", !refused.ok);
  check("nothing was submitted, so there is no transaction hash", refused.hash === null,
    String(refused.hash));
  check("the failure carries the actionable message",
    /You need [\d.]+ GEN/.test(refused.failure ?? ""), (refused.failure ?? "").slice(0, 90));
}

/* ══ TEST 14 — preflight_create answers what create_commitment would do ══ */

test("TEST 14 · preflight_create predicts the contract's own rejection");

{
  const who = as("outsider");
  const pf = (over = {}) => {
    const base = {
      description: PROMISE,
      url: fixture("kept"),
      beneficiary: beneficiary1.account.address,
      minutes: PERIOD_MIN,
      stake: STAKE.toString(),
      recurring: false,
      value: STAKE.toString(),
      archive: "",
      ...over,
    };
    return owner.viewJson("preflight_create", [
      who.account.address, base.description, base.url, base.beneficiary, base.minutes,
      base.stake, base.recurring, base.value, base.archive,
    ]);
  };

  const good = await pf();
  check("a valid create preflights clean", good.ok === true, good.reason);
  check("it reports what must ride with the call", good.required === STAKE.toString(),
    good.required);
  check("it says it cannot check reachability", good.checks_reachability === false);

  const short = await pf({ description: "too short" });
  check("a short description is caught before signing", short.ok === false, short.reason);
  check("and the reason is the contract's own wording", /12 characters/i.test(short.reason),
    short.reason);

  const http = await pf({ url: "http://example.com/blog" });
  check("an http proof url is refused", http.ok === false, http.reason);
  check("the refusal explains why http is not enough",
    /authenticated origin/i.test(http.reason), http.reason);

  const dust = await pf({ value: "1" });
  check("under the minimum stake is caught", dust.ok === false, dust.reason);

  const zero = await pf({ beneficiary: "0x" + "0".repeat(40) });
  check("the zero beneficiary is caught", zero.ok === false, zero.reason);

  // The same call, made for real, must be rejected for the same reason.
  const live = await who.send(
    "create_commitment",
    ["too short", fixture("kept"), beneficiary1.account.address, PERIOD_MIN,
      STAKE.toString(), false, ""],
    STAKE,
  );
  const body = returnedJson(live.returned);
  check("the write rejects with the reason the preflight predicted",
    body?.reason === short.reason, `${body?.reason} vs ${short.reason}`);
  check("and refunds the stake", body?.refunded === STAKE.toString(), body?.refunded ?? "—");

  // Source classification is part of the answer, so the UI can say what kind
  // of evidence this commitment will be judged on before it exists.
  const pinned = await pf({ archive: "https://arweave.net/abc123" });
  check("a pinned snapshot preflights as ATTESTED", pinned.source_kind === "ATTESTED",
    pinned.source_kind);
  check("an ordinary page preflights as OPEN", good.source_kind === "OPEN", good.source_kind);
  const archived = await pf({ url: "https://web.archive.org/web/20260101000000id_/https://e.com" });
  check("an archive url preflights as ARCHIVED", archived.source_kind === "ARCHIVED",
    archived.source_kind);
}

/* ══ TEST 15 — creation-time evidence is recorded and drift is measured ══ */

test("TEST 15 · The proof page is hashed at creation and drift is measured at settlement");

if (made.kept === undefined) {
  check("skipped — no kept commitment", false);
} else {
  const view = await owner.viewJson("get_commitment", [made.kept]);
  check("a content hash was stored at creation", /^[0-9a-f]{16}$/.test(view.created_hash ?? ""),
    view.created_hash ?? "—");
  check("a content sketch was stored at creation",
    /^[0-9a-f]{64}$/.test(view.created_sketch ?? ""), (view.created_sketch ?? "").slice(0, 20));
  check("the source is classified", ["OPEN", "ARCHIVED", "ATTESTED"].includes(view.source_kind),
    view.source_kind);

  const row = view.history[view.history.length - 1];
  if (row) {
    check("the settlement records which evidence it read",
      ["ARCHIVE", "LIVE"].includes(row.evidence_kind), row.evidence_kind);
    check("the settlement records the deadline it was judged against",
      row.deadline === view.created_at + view.period_seconds * row.period_number,
      `${row.deadline}`);
    check("drift since creation is recorded", Number.isInteger(row.drift_bps),
      `${row.drift_bps} bps`);
    check("drift is a ratio in range", row.drift_bps >= 0 && row.drift_bps <= 10000,
      String(row.drift_bps));
    check("a settled period is marked corroborated", row.corroborated === true,
      String(row.corroborated));
    check("the content hash on the row is a real hash",
      /^[0-9a-f]{16}$/.test(row.content_hash ?? ""), row.content_hash ?? "—");
    check("an ARCHIVE reading carries its snapshot url",
      row.evidence_kind !== "ARCHIVE" || /^https:\/\//.test(row.snapshot_url ?? ""),
      row.snapshot_url || "(live)");
  } else {
    check("a history row was written", false, "no row");
  }
}

/* ══ TEST 16 — rates are snapshotted at creation ═════════════════════════ */

test("TEST 16 · An owner rate change cannot reach a commitment that already exists");

if (made.rates === undefined) {
  check("skipped — no rates commitment", false);
} else {
  const before = await owner.viewJson("get_stats");
  const created = await owner.viewJson("get_commitment", [made.rates]);
  check("the commitment carries its own fee rate", created.bounty_bps === before.bounty_bps,
    `${created.bounty_bps}bps`);

  // Move the live rate to the other end of its allowed range.
  const moved = before.bounty_bps === 1000 ? 0 : 1000;
  const set = await owner.send(
    "set_params", [moved, before.cancel_fee_bps, before.min_stake, before.max_stake]);
  check("the owner moved the live rate", set.ok, set.ok ? `to ${moved}bps` : set.revertReason);

  const after = await owner.viewJson("get_commitment", [made.rates]);
  check("the existing commitment keeps the rate it was created under",
    after.bounty_bps === before.bounty_bps, `${after.bounty_bps}bps vs live ${moved}bps`);

  const stats = await owner.viewJson("get_stats");
  check("while the live rate really did change", stats.bounty_bps === moved,
    `${stats.bounty_bps}bps`);

  const restore = await owner.send(
    "set_params", [before.bounty_bps, before.cancel_fee_bps, before.min_stake, before.max_stake]);
  check("the live rate is restored", restore.ok, restore.ok ? "" : restore.revertReason);
}

/* ══ TEST 17 — settle_stalled is the exit for consensus that never forms ══ */

test("TEST 17 · settle_stalled closes a period no consensus ever settled");

if (made.stalled === undefined || SKIP_SLOW) {
  check(SKIP_SLOW ? "skipped by --skip-slow" : "skipped — no stalled commitment", false);
} else {
  const view0 = await owner.viewJson("get_commitment", [made.stalled]);
  await waitUntil(view0.grace_ends + 15, "the stalled period's grace window to close");

  const midway = await owner.viewJson("get_commitment", [made.stalled]);
  check("the commitment reports itself stalled", midway.stalled === true,
    `action=${midway.action}`);
  check("a stalled period offers no fee", midway.bounty === "0", midway.bounty);

  const before = await balanceOf(committers.stalled.account.address);
  const out = await outsider.send("settle_stalled", [made.stalled]);
  check("anyone can close a stalled period", out.ok,
    out.ok ? `-> ${out.returned}` : out.revertReason || out.failure);

  const view = await owner.viewJson("get_commitment", [made.stalled]);
  const row = view.history[view.history.length - 1];
  if (row) {
    check("it settles as LAPSED, never as kept or broken", row.verdict === "LAPSED",
      row.verdict);
    check("the whole stake goes back to the committer",
      row.to_committer === STAKE.toString(), gen(row.to_committer));
    check("nobody is paid a fee", row.caller_bounty === "0", gen(row.caller_bounty));
    check("no evidence is claimed", row.evidence_kind === "NONE", row.evidence_kind);
    check("it is not recorded as corroborated", row.corroborated === false);
    check("the reasoning names the cause", /Consensus never settled/i.test(row.reasoning ?? ""),
      (row.reasoning ?? "").slice(0, 80));

    {
      const delta = await settledDelta(committers.stalled.account.address, before, STAKE);
      check("the committer's wallet actually grew by the whole stake", delta === STAKE,
        gen(delta));
    }
  } else {
    check("a history row was written", false, "no row");
  }

  const record = await owner.viewJson("get_track_record", [committers.stalled.account.address]);
  check("a stalled close is scored as lapsed, not as broken", record.lapsed >= 1,
    `lapsed=${record.lapsed} broken=${record.broken}`);
}

/* ══ TEST 18 — the transaction lifecycle the UI drives ═══════════════════ */

test("TEST 18 · The contract exposes the lifecycle a user needs to drive a write");

{
  const rows = await owner.viewJson("get_verifiable_now");
  const shape = rows[0] ?? (await owner.viewJson("get_recent_commitments", [1]))[0];
  if (!shape) {
    check("skipped — nothing to read a shape from", false);
  } else {
    for (const key of ["action", "verify_in_flight", "verify_lock_until", "stalled",
      "next_deadline", "grace_ends", "bounty", "bounty_bps"]) {
      check(`the summary carries ${key}`, key in shape, String(shape[key]));
    }
    check("verify_in_flight is a boolean, not a timestamp to interpret",
      typeof shape.verify_in_flight === "boolean", String(shape.verify_in_flight));
    check("an idle commitment reports no lock", shape.verify_in_flight === false ||
      shape.verify_lock_until > 0, `${shape.verify_lock_until}`);
    const stats = await owner.viewJson("get_stats");
    check("the lock window is published so the UI can count down",
      stats.verify_lock_seconds > 0, `${stats.verify_lock_seconds}s`);
    check("the archive window is published", stats.archive_window_seconds > 0,
      `${stats.archive_window_seconds}s`);
  }
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
