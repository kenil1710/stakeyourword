/**
 * Creates test/.accounts.json with a stable, reusable pool of signing keys.
 *
 * A POOL rather than one key because create_commitment enforces a 180s
 * per-wallet cooldown AND a cap of 5 active commitments per wallet. Driving the
 * scenarios from one address would mean the suite spending most of its wall
 * clock waiting out its own anti-abuse rules, so each commitment is made by a
 * different committer — which is also how the contract is actually used.
 *
 * Keys are written by hand rather than read off `createAccount()`, because that
 * helper does NOT expose a `privateKey` field — it returns a viem account whose
 * key stays private to the closure. Persisting `account.privateKey` therefore
 * writes `undefined`, JSON.stringify drops the field entirely, and every later
 * `createAccount(undefined)` silently mints a brand-new random account. On
 * gasless Studionet that failure is invisible: every run works, just from a
 * different address each time. It surfaces only later, as cooldown and quota
 * tests that can never trigger and an owner nobody holds the key to.
 *
 * Existing roles are PRESERVED across runs unless --force is passed, so a
 * funded address is never silently replaced.
 *
 * Usage: node accounts.mjs [--force]
 */
import { createAccount } from "genlayer-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = new URL("./.accounts.json", import.meta.url);
const force = process.argv.includes("--force");

// `client` deploys and owns the contract. Committers make commitments,
// beneficiaries receive forfeited stakes, `hunter` is the third party who calls
// verify for the bounty, and `outsider` holds no role at all — it is what the
// permission tests use. The counts are what the e2e suite needs at peak.
const ROLES = [
  "client",
  "committer1",
  "committer2",
  "committer3",
  "committer4",
  "committer5",
  "committer6",
  "beneficiary1",
  "beneficiary2",
  "beneficiary3",
  "hunter",
  "outsider",
];

const existing = existsSync(target) && !force ? JSON.parse(readFileSync(target, "utf8")) : {};
const out = {};
let created = 0;

for (const role of ROLES) {
  if (existing[role]?.key) {
    out[role] = existing[role];
    continue;
  }
  const key = `0x${randomBytes(32).toString("hex")}`;
  const account = createAccount(key);
  // Round-trip assertion: the stored address must be the one this key actually
  // derives. Without it a mismatch just sits in the file looking plausible.
  if (createAccount(key).address !== account.address) {
    throw new Error(`key for ${role} does not derive a stable address`);
  }
  out[role] = { key, address: account.address };
  created++;
}

writeFileSync(target, JSON.stringify(out, null, 2) + "\n");

console.log(`wrote .accounts.json — ${created} new, ${ROLES.length - created} preserved`);
for (const role of ROLES) console.log(`  ${role.padEnd(12)} ${out[role].address}`);
console.log(`\n(gasless on Studionet; fund these before using Bradbury)`);
