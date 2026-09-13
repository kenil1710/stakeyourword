# Proof runs

Captured 2026-09-13T16:30:37Z against `0xF2Ab9544dba7Fb6181550b4531f58967921C405c`
on GenLayer Studio Devnet (chain 61997), with the frontend live at
https://stakeyourword.vercel.app.

Every block below is verbatim output from a script in `test/`. Nothing here
is transcribed by hand.

## `node test/repro-fee-failure.mjs --network=bradbury`

The production failure the review reported, reproduced on the network it was
reported on, then refused by the preflight.

```
network  Genlayer Bradbury Testnet (id 4221)
wallet   0x28Be0f914219422fA0F46F201f47D8356B3eCeC0
balance  0 GEN
calling  create_commitment with 0.1 GEN of stake
────────────────────────────────────────────────────────────────────
BEFORE — submit without quoting the fee (what production did)
────────────────────────────────────────────────────────────────────
  RPC errors seen on the wire, in order:
    eth_estimateGas          invalid transaction: LackOfFundForMaxFee { fee: 100000000000000000, balance: 0 }
    eth_sendRawTransaction   [0xffdc8b275daf92b3e04fcad4be69c1a16a75715c7f7ac7107b9ae57cffcc4454]: sender does not have enough funds (0) to
  1. LackOfFundForMaxFee on the gas estimate      YES
  2. a follow-on eth_sendRawTransaction failure   YES
  3. surfacing as an RPC parameter/format error   YES
  That is the reported failure, end to end: the consensus contract
  locks fee + stake before the contract runs and this wallet holds
  neither, the SDK swallows the estimate error and falls back to a
  default gas limit, and the resubmission fails again — this time as a
  transport-shaped error that hides the cause.
────────────────────────────────────────────────────────────────────
AFTER — quote the fee and check the balance before signing
────────────────────────────────────────────────────────────────────
  fee estimate     0 GEN
  stake            0.1 GEN
  required total   0.1 GEN
  wallet holds     0 GEN
  shortfall        0.1 GEN
  affordable       false
  REFUSED LOCALLY. Nothing signed, nothing spent.
  "You need more than 0.1 GEN to create this commitment — the stake itself, plus a network fee this network would not quote. This wallet holds 0 GEN."
```

## `node test/e2e.mjs --base=https://stakeyourword.vercel.app`

The full lifecycle against the live network — creation, cancellation, the two
nondeterministic paths, settlement, the grace window, the books, and the
permission surface.

```
── TEST 1 · A rejected create refunds and returns ok:false
  PASS  the transaction SUCCEEDED (a revert would have kept the stake)
  PASS  returned ok:false rather than raising  reason: Describe the commitment in at least 12 characters
  PASS  the reason names the description  Describe the commitment in at least 12 characters
  PASS  refunded the full stake  refunded 100000000000000000 of 100000000000000000
  PASS  the stake is whole again once the refund finalizes, less only the fee  net -0.0001 GEN (fee only)
── TEST 2 · An unreachable proof URL is refunded, not committed
  PASS  the transaction SUCCEEDED
  PASS  returned ok:false  reason: That proof URL could not be reached, so there is nothing to check against
  PASS  the reason names reachability  That proof URL could not be reached, so there is nothing to check against
  PASS  refunded the full stake  100000000000000000
── SETUP · Creating the commitments the timed tests need
  PASS  created "kept" against kept  id=0
  PASS  created "broken" against broken  id=1
  PASS  created "hostile" against hostile  id=2
  PASS  created "self" against kept  id=3
  PASS  created "lapse" against broken  id=4
  PASS  created "cancel" against kept  id=5
  PASS  created "stalled" against stale  id=6
  PASS  created "rates" against kept  id=7
── TEST 3 · Cancel before a deadline pays the fee and returns the rest
  PASS  cancel succeeded
  PASS  status is CANCELED  CANCELED
  PASS  nothing is still staked  0
  PASS  the fee matches the published rate  0.0100 GEN vs 0.0100 GEN at 1000bps
  PASS  the two legs sum to the whole stake  0.0900 GEN + 0.0100 GEN
  PASS  the committer actually received the refund  0.0899 GEN
  PASS  the beneficiary actually received the fee  0.0100 GEN
  PASS  a second cancel is refused  Only an ACTIVE commitment can be cancelled; this one is CANCELED
── TEST 4 · A period that is not due yet cannot be settled
── SETUP · Waiting for the periods to come due
  PASS  the bounty board lists the due periods  4 row(s), actions: VERIFY,VERIFY,VERIFY,VERIFY
  PASS  each due row carries a non-zero fee  0.0050 GEN
── TEST 5 · A kept promise returns the stake and pays the caller a fee
  PASS  verification settled  -> MET
  PASS  the verdict is MET  MET (confidence 94)
  PASS  the page was reachable
  PASS  the committer got the stake back  0.0950 GEN
  PASS  the beneficiary got nothing  0.0000 GEN
  PASS  the caller was paid a fee  0.0050 GEN
  PASS  the caller on record is the hunter  0x56eD92c59c0b428187c77977f22F53C3e4228bDB
  PASS  the three legs sum to exactly one period's stake  0.1000 GEN
  PASS  the reasoning is real prose, not a stub  425 chars
  PASS  the committer's wallet actually grew by its leg  0.0950 GEN
  PASS  the hunter's wallet actually grew by the bounty, less the network fee  0.0047 GEN
  PASS  a one-time commitment closes once its only period settles  COMPLETED
── TEST 6 · A broken promise pays the beneficiary
  PASS  verification settled  -> NOT_MET
  PASS  the verdict is NOT_MET  NOT_MET — The page states "No posts yet" and explicitly notes it "has been empty since it was set up" with "Nothing has 
  PASS  the beneficiary was paid  0.0950 GEN
  PASS  the committer got nothing back  0.0000 GEN
  PASS  the caller was still paid a fee  0.0050 GEN
  PASS  the three legs sum to exactly one period's stake
  PASS  the beneficiary's wallet actually grew by its leg  0.0950 GEN
  PASS  the break is on the committer's record  broken=1
── TEST 7 · A hostile page cannot argue itself into a MET verdict
  PASS  verification settled  -> NOT_MET
  PASS  the verdict is NOT MET  NOT_MET — The nominated proof page for 'The Ship Log' says 'No posts yet' and 'Nothing has been published on this page. 
  PASS  the injection was flagged on the record  flagged=true
  PASS  the flag is also raised on the commitment
  PASS  the stored reasoning does not parrot the injected verdict
── TEST 8 · Settling your own period costs the committer no fee
  PASS  verification settled  -> MET
  PASS  no fee was charged  0.0000 GEN
  PASS  the whole stake settled to one side or the other  0.1000 GEN
  PASS  the committer got 100% of the stake back, less only the network fee  0.0997 GEN
── TEST 9 · Pausing blocks new stake but cannot freeze committed money
  PASS  the owner can pause
  PASS  a new commitment is refused while paused  StakeYourWord is paused
  PASS  and the refused stake is refunded  100000000000000000
  PASS  get_stats reports the pause
── TEST 10 · An unchecked period lapses back to the committer, while paused
  PASS  the board now marks it LAPSED rather than VERIFY  action=LAPSED
  PASS  a lapsed row offers no fee  0
  PASS  anyone can close a lapsed period — EVEN WHILE PAUSED  -> LAPSED
  PASS  the verdict is LAPSED  LAPSED
  PASS  the whole stake went back to the committer  0.1000 GEN
  PASS  nobody was paid a fee  0.0000 GEN
  PASS  no model ran, so there is no confidence  0
  PASS  the committer's wallet actually grew by the whole stake  0.1000 GEN
  PASS  a lapse is scored as lapsed, NOT as kept  kept=0 lapsed=1
  PASS  a lapse does not move the kept rate  decided=0
── TEST 11 · The books balance
  PASS  the owner can unpause
  PASS  locked_stakes equals the sum of every ACTIVE commitment's stake  0.2000 GEN vs 0.2000 GEN across 2 active
  PASS  the contract holds at least what it owes  balance 0.2000 GEN, owed 0.2000 GEN
  PASS  a sweep is refused while a payout is still settling  A transfer went out 96s ago; wait 3504s so pending payouts are not counted as surplus
  PASS  once the outbound transfers finalize, nothing is left unallocated
  PASS  every period that settled is accounted for  kept=2 broken=2 unclear=0 lapsed=1
  PASS  staked all-time equals what was paid out plus what is still locked  0.8000 GEN vs 0.8000 GEN
── TEST 12 · Owner-only methods reject everybody else
  PASS  a stranger cannot pause  Owner only
  PASS  a stranger cannot change the rates  Owner only
  PASS  a stranger cannot sweep  Owner only
  PASS  set_params accepted the out-of-range request
  PASS  but the fee was clamped to its cap, not stored as asked  bounty_bps=1000 (asked for 9999)
  PASS  the original rates are restored
  PASS  the contract is left unpaused
  PASS  the stake bounds are exactly as they were found  0.0100 GEN – 10.0000 GEN
  PASS  the fee rate is exactly as it was found  500bps
── TEST 13 · Every write is quoted and balance-checked before it is signed
  PASS  a fee estimate is produced for the exact call  0.0006 GEN of fees
  PASS  the required amount is the stake plus the fee  0.1006 GEN = 0.1000 GEN + 0.0006 GEN
  PASS  a funded wallet passes the preflight  holds 119.9989 GEN
  PASS  the probe wallet really is empty  0.0000 GEN
  PASS  an unfundable write fails the preflight  You need 0.1006 GEN to create this commitment — 0.1 GEN of stake plus 0.0006 GEN
  PASS  the refusal names the amount needed  You need 0.1006 GEN to create this commitment — 0.1 GEN of stake plus 0.0006 GEN of network fees. This wallet holds 0 GEN, so it is short by 0.1006 GEN.
  PASS  the refusal names the shortfall
  PASS  the shortfall is the whole requirement on an empty wallet  0.1006 GEN
  PASS  send() refuses locally rather than submitting
  PASS  nothing was submitted, so there is no transaction hash  null
  PASS  the failure carries the actionable message  You need 0.1006 GEN to create this commitment — 0.1 GEN of stake plus 0.0006 GEN of networ
── TEST 14 · preflight_create predicts the contract's own rejection
  PASS  a valid create preflights clean
  PASS  it reports what must ride with the call  100000000000000000
  PASS  it says it cannot check reachability
  PASS  a short description is caught before signing  Describe the commitment in at least 12 characters
  PASS  and the reason is the contract's own wording  Describe the commitment in at least 12 characters
  PASS  an http proof url is refused  Proof URL must use https:// — an http page has no authenticated origin
  PASS  the refusal explains why http is not enough  Proof URL must use https:// — an http page has no authenticated origin
  PASS  under the minimum stake is caught  Stake per period is below the minimum
  PASS  the zero beneficiary is caught  Beneficiary cannot be the zero address
  PASS  the write rejects with the reason the preflight predicted  Describe the commitment in at least 12 characters vs Describe the commitment in at least 12 characters
  PASS  and refunds the stake  100000000000000000
  PASS  a pinned snapshot preflights as ATTESTED  ATTESTED
  PASS  an ordinary page preflights as OPEN  OPEN
  PASS  an archive url preflights as ARCHIVED  ARCHIVED
── TEST 15 · The proof page is hashed at creation and drift is measured at settlement
  PASS  a content hash was stored at creation  4c2003369458be3f
  PASS  a content sketch was stored at creation  4f9b91474586c83b03b5
  PASS  the source is classified  OPEN
  PASS  the settlement records which evidence it read  LIVE
  PASS  the settlement records the deadline it was judged against  1789314994
  PASS  drift since creation is recorded  10000 bps
  PASS  drift is a ratio in range  10000
  PASS  a settled period is marked corroborated  true
  PASS  the content hash on the row is a real hash  4c2003369458be3f
  PASS  an ARCHIVE reading carries its snapshot url  (live)
── TEST 16 · An owner rate change cannot reach a commitment that already exists
  PASS  the commitment carries its own fee rate  500bps
  PASS  the owner moved the live rate  to 1000bps
  PASS  the existing commitment keeps the rate it was created under  500bps vs live 1000bps
  PASS  while the live rate really did change  1000bps
  PASS  the live rate is restored
── TEST 17 · settle_stalled closes a period no consensus ever settled
  PASS  the commitment reports itself stalled  action=LAPSED
  PASS  a stalled period offers no fee  0
  PASS  anyone can close a stalled period  -> LAPSED
  PASS  it settles as LAPSED, never as kept or broken  LAPSED
  PASS  the whole stake goes back to the committer  0.1000 GEN
  PASS  nobody is paid a fee  0.0000 GEN
  PASS  no evidence is claimed  NONE
  PASS  it is not recorded as corroborated
  PASS  the reasoning names the cause  Consensus never settled this period inside its grace window. The stake was retur
  PASS  the committer's wallet actually grew by the whole stake  0.1000 GEN
  PASS  a stalled close is scored as lapsed, not as broken  lapsed=1 broken=0
── TEST 18 · The contract exposes the lifecycle a user needs to drive a write
  PASS  the summary carries action  LAPSED
  PASS  the summary carries verify_in_flight  false
  PASS  the summary carries verify_lock_until  0
  PASS  the summary carries stalled  true
  PASS  the summary carries next_deadline  1789315219
  PASS  the summary carries grace_ends  1789315519
  PASS  the summary carries bounty  0
  PASS  the summary carries bounty_bps  500
  PASS  verify_in_flight is a boolean, not a timestamp to interpret  false
  PASS  an idle commitment reports no lock  0
  PASS  the lock window is published so the UI can count down  1200s
  PASS  the archive window cap is published  604800s
149 passed, 0 failed
```

## `node test/proof-commitments.mjs --count=3`

Three commitments made on studio-dev, each showing the fee quote the wallet was
checked against, the transaction hash, the receipt the chain reports, the
resulting id, and the state read back **through the deployed app's own relay**.

| id | transaction | source | page |
|---|---|---|---|
| 9 | `0x637adeaae9db3adaa9572986aaaade6713b6f58b1cbbde416cd1c319ba9fae59` | OPEN | https://stakeyourword.vercel.app/commitment/9 |
| 10 | `0x69a8da53b716f0d41019aed9f25ea50fd125560558a3438ce9a348c95adf8194` | OPEN | https://stakeyourword.vercel.app/commitment/10 |
| 11 | `0xb4ab587155bb3e5c54d8b890ff97e71c392b04a2e3c81eeefc6e7498685fcd84` | ATTESTED | https://stakeyourword.vercel.app/commitment/11 |

One of them in full:

```
  PREFLIGHT (before anything is signed)
    contract would accept   true
    proof source            ATTESTED
    checks reachability     false  (that lives in consensus)
    stake                   0.1 GEN
    network fee             0.0007 GEN
    required total          0.1007 GEN
    wallet holds            139.4995 GEN
    affordable              true

  SUBMITTING create_commitment with 0.1 GEN…
    tx hash                 0xb4ab587155bb3e5c54d8b890ff97e71c392b04a2e3c81eeefc6e7498685fcd84
    receipt status          ACCEPTED
    execution               FINISHED_WITH_RETURN
    contract returned       {"ok":true,"id":11,"funded_periods":1,"locked":"100000000000000000","refunded":"0","source_kind":"ATTESTED","content_hash":"49b8d64d747b6e12","first_deadline":1789316777}
    commitment id           #11
    content hash at create  49b8d64d747b6e12
    source class            ATTESTED

  WAITING FOR FINALIZATION…
    final status            FINALIZED

  FRONTEND STATE (read through https://stakeyourword.vercel.app/api/rpc)
    https://stakeyourword.vercel.app/commitment/11
    status                  ACTIVE
    staked                  0.1 GEN over 1 period(s)
    next deadline           2026-09-13T16:26:17.000Z
    source kind             ATTESTED
    created hash            49b8d64d747b6e12
    fee rate on record      500bps (snapshotted at creation)
```

The wallet-confirmation screen is the one piece this cannot show: these are
local signing keys, so nothing prompts. The preflight that gates that screen is
shown instead, with the exact numbers it checks.

## `node test/proof-archive.mjs`

A commitment judged on an **immutable snapshot** rather than on today's page.
The fixtures cannot exercise this — no public archive holds captures of them —
so this pins a real Wayback capture at creation and settles against it.

```
  PASS  it is classified ATTESTED  ATTESTED
  PASS  a content hash was stored at creation  49b8d64d747b6e12
  commitment #12, tx 0x7aa8fd8b5868f9be12efb679ef5e30d8cba76f656138e1de73c4eaf5d68db094

── Waiting for period 1
  PASS  the pinned snapshot is on the record  https://web.archive.org/web/20250101004557id_/https://example.com/

── Verifying against the pinned snapshot
  … verify_commitment simulated a revert (advisory): Period 1 is not due yet; 56713474s to go
  PASS  the verification settled  MET · 0x640e5ca5d2c840b6252b52e144799f2208247d6a9fe306ad60471f015499f2aa
  verdict MET · confidence 100
  PASS  the verdict was read from an ARCHIVED snapshot  ARCHIVE
  PASS  the snapshot it read is on the record  https://web.archive.org/web/20250101004557id_/https://example.com/
  PASS  the evidence hash is recorded  a43244de50461929
  PASS  the deadline it was judged against is recorded  1789316836
  PASS  it is marked independently corroborated  true
  PASS  drift against creation was recomputed on chain  1714 bps
  PASS  the reasoning is real prose  256 chars
  PASS  the three legs sum to exactly one period's stake  100000000000000000

  "The page content explicitly states, 'This domain is for use in illustrative
   examples in documents,' which directly matches the language required by the
   promise. The snapshot provides clear evidence that the specific text was
   present at the …"

15 passed, 0 failed
```

Two things worth reading twice. `evidence_kind` is `ARCHIVE`, so the verdict was
reached on the bytes captured in the archive rather than on the live page — and
the advisory line above it is the fee simulator insisting the period was not due,
on a clock hundreds of days behind the chain's, correctly ignored. And the drift
of 1714 bps is the contract's own arithmetic: the 2025 capture really is
substantially different from the 2026 page the commitment was created against,
and the number was recomputed on chain rather than taken from the leader.

## `node test/probe.mjs`

`create_commitment` gained an optional seventh parameter. Everything else in the
suite passes all seven; anything integrated before it existed passes six.

```
  returned: {"ok":true,"id":8,"funded_periods":1,"locked":"100000000000000000","refunded":"0","source_kind":"OPEN","content_hash":"4c2003369458be3f","first_deadline":1789316277}
  the omitted archive_url bound its default: source_kind=OPEN ✓
```

## `node test/audit.mjs`

Every pattern a past review rejected this project for, re-checked from scratch:
structurally against the source with comments stripped, and live against the
deployment.

```
── SOURCE · Runner header
  PASS  line 1 is the runner version comment  # v0.3.0
  PASS  line 2 pins a concrete py-genlayer hash  # { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2q
  PASS  no test/latest runner alias anywhere
  PASS  nothing sits between the header and the import  import genlayer as gl
  PASS  the v0.3 import pattern is used
── SOURCE · v0.3.0 API surface
  PASS  uses gl.contract.Contract
  PASS  uses gl.storage.TreeMap
  PASS  uses gl.storage.DynArray
  PASS  uses gl.storage.allow
  PASS  uses gl.message.raw
  PASS  no v0.2 spellings survive
  PASS  no u-type call wrappers (they are not callable in v0.3)
  PASS  the v0.2 cross-contract spellings are gone
  PASS  the only outbound interface is the EVM payee handle
── SOURCE · No counter-before-revert
  PASS  create_commitment writes no state before its last rejection path
  PASS  add_stake writes no state before its last rejection path
  PASS  _reject returns rather than raising
  PASS  _reject refunds before returning
── SOURCE · Fee snapshotted at creation
  PASS  the record carries its own bounty rate
  PASS  the record carries its own cancel rate
  PASS  create_commitment stamps both rates onto the record
  PASS  settlement reads the rate off the RECORD, not off the contract
  PASS  cancelling reads the rate off the RECORD too
  PASS  the quoted bounty comes from the record as well
── SOURCE · Refund-on-reject on every payable path
  PASS  both payable methods are found  create_commitment, add_stake
  PASS  create_commitment rejects through _reject
  PASS  create_commitment never raises
  PASS  add_stake rejects through _reject
  PASS  add_stake never raises
── SOURCE · The owner cannot freeze committed money
  PASS  verify_commitment is not gated on paused
  PASS  _close_unverified is not gated on paused
  PASS  settle_lapsed is not gated on paused
  PASS  settle_stalled is not gated on paused
  PASS  cancel_commitment is not gated on paused
  PASS  set_paused only sets the flag
  PASS  sweep is capped at balance minus locked stakes
  PASS  sweep waits out the last outbound transfer
  PASS  the settle paths are permissionless
── SOURCE · Content hash present, at creation and at settlement
  PASS  the record stores a creation hash
  PASS  the record stores a creation sketch
  PASS  both are written at creation
  PASS  the history row stores the evidence hash
  PASS  the history row stores drift against creation
  PASS  the hash is FNV-1a by hand, not Python's seeded hash()
── SOURCE · All stored fields recomputed post-consensus
  PASS  settlement runs everything through _settle
  PASS  no field is read off the raw result after _settle
  PASS  _settle re-normalises the verdict
  PASS  _settle re-validates the hash as hex
  PASS  _settle re-validates the sketch as hex
  PASS  _settle RECOMPUTES drift from the creation sketch
  PASS  _settle re-checks the claimed snapshot url
  PASS  _settle bounds the snapshot window by the period, not a constant
  PASS  _settle clamps confidence
  PASS  _settle replaces prose written for a verdict that moved
  PASS  _settle is pure — it takes no self
── SOURCE · Deadline-time evidence
  PASS  the archive window is a function of the period
  PASS  a capture from before the deadline is refused
  PASS  a capture further past it than one period is refused
  PASS  the per-period window is capped
  PASS  the archive query is aimed past the deadline
  PASS  the snapshot the leader claims is re-checked before it is fetched
  PASS  the raw archived bytes are requested, not the wrapper
── SOURCE · Conservative resolution
  PASS  _agree exists and is module level
  PASS  a validator with no evidence only accepts INCONCLUSIVE
  PASS  a leader calling a live page dead is refused
  PASS  archived evidence is compared byte-for-byte
  PASS  drift buckets are compared on decisive verdicts
  PASS  the extracted observations are compared
  PASS  the verdict is still compared exactly
  PASS  no usable evidence forces INCONCLUSIVE
  PASS  settle_stalled exists as its own entry point
  PASS  settle_stalled and settle_lapsed share one implementation
── SOURCE · Prompt and money invariants
  PASS  no protocol fee field exists
  PASS  money divides before it multiplies
  PASS  the principal is defined by subtraction
  PASS  _pay is the single outbound choke point
  PASS  the prompt fences untrusted content
  PASS  the unreachable rule is in the prompt
  PASS  the this-period-only rule is in the prompt
  PASS  the independence line is in the prompt
  PASS  https is required
── REPO · No assistant attribution in git or in the tree
  PASS  no assistant attribution in any commit
  PASS  no assistant attribution in any tracked file
  PASS  no assistant scratch file at the repo root
  PASS  no assistant scratch directory in the repo
  PASS  the ignore rules name no assistant either
── LIVE · 0xF2Ab9544dba7Fb6181550b4531f58967921C405c on studiodev
  PASS  the contract answered get_stats  13 commitment(s)
  PASS  it is not paused
  PASS  the books balance: staked = paid out + still locked  1300000000000000000 vs 1300000000000000000
  PASS  the contract holds at least what it owes  holds 400000000000000000, owes 400000000000000000
  PASS  the fee rates are within their caps  bounty 500bps, cancel 1000bps
  PASS  the new parameters are published  archive cap 604800s, lock 1200s
  PASS  locked_stakes equals the sum of every active commitment  400000000000000000 vs 400000000000000000 across 4 active
  PASS  at least three commitments exist as proof  13 found
  PASS  every commitment stored a content hash at creation  13/13
  PASS  every commitment carries its own snapshotted fee rate  13/13
  PASS  every commitment classified its proof source  13/13
  PASS  settled periods exist to audit  8 row(s)
  PASS  every judged period records what evidence it read  6 judged row(s)
  PASS  every decisive verdict was independently corroborated  6/6
  PASS  preflight_create answers
  PASS  preflight_create catches a bad description  Describe the commitment in at least 12 characters
  PASS  preflight_create admits it cannot check reachability
103 passed, 0 failed
```

## `python3 test/test_logic.py`

```
9103 passed, 0 failed
```
