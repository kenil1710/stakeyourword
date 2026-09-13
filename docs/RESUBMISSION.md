# StakeYourWord — resubmission

Every point in the review, what was actually wrong, and what to run to check it.

| | |
|---|---|
| Contract | `0xF2Ab9544dba7Fb6181550b4531f58967921C405c` |
| Network | GenLayer **Studio Devnet** — chain `61997`, `https://studio-dev.genlayer.com/api` |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (v0.3.0) |
| App | https://stakeyourword.vercel.app |
| Source | https://github.com/kenil1710/stakeyourword |
| Bradbury proof | tx `0xf504a684…`, commitment #0 on `0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2` |

---

## First: the funded Bradbury reproduction

The review asked for a funded Bradbury wallet creating a commitment, with the
hash, the receipt, the id and the finalization state. Here it is.

`0x28Be0f914219422fA0F46F201f47D8356B3eCeC0` was funded with 3 GEN from the
faucet — Bradbury has no faucet call, only a Cloudflare-gated web form, which is
why every account in this project sat at 0 GEN and why the write failed at all.

```
node test/repro-fee-failure.mjs --network=bradbury
```

**1 · The failure, on a wallet that cannot pay** (`outsider`, 0 GEN):

```
  RPC errors on the wire, in order:
    eth_estimateGas          invalid transaction: LackOfFundForMaxFee { fee: 100000000000000000, balance: 0 }
    eth_sendRawTransaction   sender does not have enough funds (0) to cover transaction fees: 100037500000000000

  PASS  LackOfFundForMaxFee on the gas estimate
  PASS  a follow-on eth_sendRawTransaction failure
  PASS  surfacing as an RPC parameter/format error
  PASS  the preflight refuses the same call before signing
  PASS  and names what is missing
```

Both reported symptoms, in the order they hit the wire, on the network they were
reported on — and then the preflight refusing the same call before anything is
signed.

**2 · The same call, on the funded wallet:**

| | |
|---|---|
| Transaction | `0xf504a6842144ac2dc0d85b2aec0ecead8db31fa6ba307cf535e22fe0b6ab36be` |
| Contract | `0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2` (Bradbury, v0.2 runner) |
| Execution | `FINISHED_WITH_RETURN` |
| Commitment | **#0** — ACTIVE, 0.1 GEN staked, content hash `4c2003369458be3f` |
| Committer | `0x28Be0f914219422fA0F46F201f47D8356B3eCeC0` |
| Wallet | 3 GEN → 2.896934 GEN (0.1 stake + 0.003 in fees and nudges) |

**3 · And the part I did not stage: it got stuck, and the nudge flow recovered
it.**

The transaction went `COMMITTING` → appeal round 3 (12 votes committed, 0
revealed, `resultName: IDLE`) → back to `COMMITTING`, and sat there through 12
nudges and 905 seconds. All the while `txExecutionResultName` read
`FINISHED_WITH_RETURN`: **the contract had already run successfully.** The round
simply had not closed, so no state was applied and there was no commitment to
read.

That is precisely the failure the review asked for a user-controlled recovery
flow to handle, and it turned up on its own rather than being contrived.
`test/nudge.mjs` — the command-line form of the **Check status** and **Nudge it
along** controls the app now exposes — drove it out:

```
$ node test/nudge.mjs --tx=0xf504a684… --network=bradbury

      1s  COMMITTING  (NOT_VOTED)
    396s  ACCEPTED  (FINISHED_WITH_RETURN)

  settled as ACCEPTED after 396s and 14 nudge(s)
```

State applied, commitment #0 on chain.

Two things this cost me, both now fixed and both worth naming:

- The repro script read the commitment straight after submission, found nothing,
  and crashed — then reported three FAILs for a transaction whose execution had
  already returned successfully. That is the exact confusion the script exists
  to clear up, reproduced inside the script itself. It now distinguishes "the
  round has not closed" from "the write failed".
- **genlayer-js 2.x cannot talk to Bradbury at all.** It encodes calldata for the
  v0.3 executor; a `get_stats` read that works under 1.1.8 comes back as
  `ValueError: call to private method __handle_undefined_method__`, which reads
  like a missing method on a contract that plainly has it and would send anyone
  debugging it at the contract rather than the client. The SDK major must match
  the executor line, so the Bradbury scripts pin 1.1.8 through an npm alias.

The one piece still missing is the **wallet-confirmation screen**: these are
local signing keys, so nothing prompts. The preflight that gates that screen is
shown instead, with the exact numbers it checks.

## Second, why the deployment moved to Studio Devnet

Not a preference. This contract is written against the **v0.3.0** executor line
(`gl.contract.Contract`, `gl.storage.TreeMap`, `gl.storage.DynArray`,
`gl.storage.allow`, `gl.message.raw`, `gl.contract.get_at`), and Studio Devnet is
the only one of the three networks running it. Studionet and Bradbury still
resolve v0.2 runners and answer `invalid_contract runner malformed` for this
source — a runner-version mismatch, not a broken contract. I verified that by
deploying, not by reading about it.

One item on the format list has no call site: **`gl.contract.get_at`**. It is the
v0.3.0 spelling of `gl.get_contract_at`, and this contract makes no
cross-contract read — there is nothing it needs from another contract. A
cross-contract read is a consensus surface, and opening one to satisfy a
checklist would be worse than not having it. The audit checks that the *old*
spelling is gone, which is the part that would actually break, rather than
asserting a call that should not exist.

Two details worth recording because they cost real time:

- The header is **two** lines. Line 1 is the runner version (`# v0.3.0`), line 2
  the pinned hash. GenVM reads the first comment line as the version string if it
  starts with `v`, and the contiguous block after it as the runner JSON.
- The `py-genlayer` hash published on the SDK docs site
  (`9b8kjyda2ycxyq4ea6g4yfpnydxhd52gqba5rb8dw7krkh5mn9p0`) is **not** in Studio
  Devnet's manifest and is rejected as malformed. The one pinned above is what
  that network actually resolves. `deploy.mjs` now validates both header lines
  and refuses a `test`/`latest` alias before it spends a fee finding out.

---

## FIX 1 — the production write failure

### What was actually wrong

`LackOfFundForMaxFee` and the `eth_sendRawTransaction` request-format error are
**one failure, not two**, and neither is a contract fault.

A GenLayer write is an EVM transaction to the consensus contract carrying a
`fees` envelope. The consensus contract locks `feeValue + userValue` from the
sender **before the contract runs**. The app submitted writes with no fee
estimate at all, so the required amount was never compared against the wallet
balance — and on a wallet holding 0 GEN the revert was guaranteed before
`create_commitment` ever executed.

The parse error is the second act. The SDK swallows the failed `eth_estimateGas`,
falls back to a default gas limit, and re-submits; the node rejects the
resubmission, and *that* error surfaces in the console shaped like a transport
problem — burying the cause.

### Reproduced

```
$ node test/repro-fee-failure.mjs --network=bradbury

  RPC errors seen on the wire, in order:
    eth_estimateGas          invalid transaction: LackOfFundForMaxFee { fee: 100000000000000000, balance: 0 }
    eth_sendRawTransaction   [0xf3f2…]: sender does not have enough funds (0) to cover transaction fees: 100037500000000000

  1. LackOfFundForMaxFee on the gas estimate      YES
  2. a follow-on eth_sendRawTransaction failure   YES
  3. surfacing as an RPC parameter/format error   YES
```

### Fixed

- **`estimateTransactionFeesForWrite` on every write**, not a bare
  `estimateTransactionFees()`. The per-write form simulates the call and derives
  the **message-fee allocations** any call emitting a payout needs — every
  settlement path here does. Without them the transaction fails with
  `fee no_matching_allocation # external` *after* the stake has moved into the
  contract. I hit that and it is in the notes.
- **Preflight before signing.** `feeValue + userValue` is compared against the
  balance and a shortfall is refused locally:

  > You need 0.1006 GEN to create this commitment — 0.1 GEN of stake plus
  > 0.0006 GEN of network fees. This wallet holds 0 GEN, so it is short by
  > 0.1006 GEN.

  A wallet dialog the user cannot afford to confirm never opens.
- **The quote degrades rather than throwing.** Bradbury runs an older consensus
  contract than the v2 fee API expects, so reading the fee policy there reverts
  in `quoteGasPrice`. Throwing would have removed the preflight from the path on
  exactly the network whose missing preflight caused the bug, so it falls back to
  a stake-only lower bound — weaker, correct, and it still catches a zero
  balance. The UI says the check is weaker rather than showing a confident zero.
- **The simulation is advisory, not authoritative.** `estimateTransactionFeesForWrite`
  simulates the call, and Studio Devnet's simulator runs on a clock about **656
  days behind** the one a real transaction sees — measured, not guessed. Every
  time gate in this contract therefore reads wrong under simulation: a period
  that IS due simulates as "not due yet". Treating a simulated revert as a
  refusal would have blocked the entire settlement path, so it is reported
  (`wouldRevert`), shown once with a "send it anyway" control, and the real
  transaction decides. Only the balance check refuses, because balances are not
  time-gated.
- **The envelope is rebuilt by hand when the simulation cannot run**, from the
  payout recipients on the commitment record. Two things the consensus contract
  enforces without explaining: `feeParams` is not optional for an external
  allocation (`InvalidFeeParams`), and `budget` must be exactly
  `gasLimit × maxGasPrice` — larger included (`ExternalAllocationInvalid`). Both
  cost a submitted transaction each to find.
- **A simulated revert carries the contract's own message.** The reason rides in
  the simulation receipt, so "Period 1 is not due yet; 112s to go" is shown
  *before* signing rather than reaching the user as "the fee estimate failed".
- **`preflight_create` is a new contract view**: `_create_problem` exposed as a
  read, so the reason shown before signing is the contract's **own** wording, not
  a TypeScript mirror that drifts. It states that it cannot check reachability —
  that is non-deterministic and only exists inside consensus — so a clean
  preflight is honestly not a promise the create will succeed.

`frontend/src/lib/fees.ts`, `test/fees.mjs`, `test/repro-fee-failure.mjs`,
`preflight_create` in the contract.

## FIX 2 — error handling

- Every write reports its state precisely, and no two states are collapsed:
  `checking`, `blocked` (refused before signing — nothing sent, nothing spent),
  `warned` (the simulation expects a refusal, overridable — see FIX 1),
  `signing`, `pending`, `accepted`, `finalized`, `rejected` and `error`. Nine in
  all; the point is that none of them is the others.
- **`rejected` is not failure.** The payable methods refund and return
  `{ok: false}` rather than reverting, because a revert would roll back the
  refund and keep the stake. That arrives as a perfectly successful transaction,
  and the UI says "the contract turned this down and sent your stake back" with
  the reason and the refunded amount.
- **The hash appears the moment it exists.** `submitWrite` returns it rather than
  waiting for settlement — the hash is the only thing a user can act on while a
  transaction is in flight, and withholding it leaves them with a spinner for the
  minutes that matter most. It is rendered copyable, because Studio Devnet has no
  block explorer and a dead `/tx/…` link is worse than a string you can paste.
- **Status tracking is real**: pending → accepted → finalized, drawn as three
  chips with the chain's own status name alongside. Accepted means the state is
  applied and the money is decided; finalized means irreversible. Collapsing them
  into "done" tells someone their payout has landed while it is still in flight.
- **Failures say why, in a sentence you can act on.** `explainChainError` maps
  `LackOfFundForMaxFee`, `FeeValueMustBeNonZero`, `no_matching_allocation`,
  `NonceTooLow`, consensus-contract reverts, rate limits, `invalid_contract` and
  network timeouts onto what the person has to go do. Anything unrecognised is
  passed through verbatim rather than smoothed into a vague apology.

## FIX 3 — transaction finalization and nudging

The old code had a comment admitting this gap. It is closed.

- **Check status** — polls on demand.
- **Nudge it along / Speed it up** — calls `finalizeIdlenessTxs`. It is a button,
  not a background retry, precisely because it is itself a transaction: a second
  wallet prompt arriving in the middle of a write the user already signed is
  indistinguishable from a bug.
- **Retry** — re-submits the same call with a fresh estimate. The write is
  described as data (`createCall`, `verifyCall`, …) rather than performed by a
  function that also submits, so "retry" means the same call and not a second,
  subtly different one.
- The watch loop stops itself after four minutes rather than polling behind a tab
  nobody is looking at; it does not give up, it hands over the controls and says
  how long the transaction has been in flight.
- **The commitment page shows finalization state**: `verify_in_flight`,
  `verify_lock_until` and `stalled` are published by the contract, so the page
  can say "somebody is already verifying this, and the lock clears in N seconds"
  instead of letting a second caller send a transaction that reverts on the lock.

## FIX 4 — authenticated proof sources

- **A content hash and a 256-bit fingerprint are stored at creation**
  (`created_hash`, `created_sketch`), and every settlement measures drift against
  them. `drift_bps` is **recomputed on chain after consensus** from the stored
  creation fingerprint, so a leader cannot understate how far the page has moved.
- **`source_kind` is classified at creation**: `ATTESTED` (the committer pinned
  an immutable snapshot up front), `ARCHIVED` (the proof URL is already
  content-addressed — an archive host, IPFS, Arweave), `OPEN` (an ordinary page).
- **https only.** `http://` is rejected with a message that says why: an http
  page has no authenticated origin, so nothing fetched over it can be attributed
  to the publisher the committer named, and attribution is the entire point of
  nominating a page.
- **Changed content is flagged** — and I want to record a rule I wrote, shipped,
  watched fail on a live run, and took back out.

  The rule was: after consensus, a MET verdict on evidence byte-identical to what
  the page said at creation is downgraded to INCONCLUSIVE. Deterministic, only
  ever moves a verdict toward the outcome that costs nobody their stake, and
  plainly right for "publish something weekly".

  It is wrong for "my status page will still say all systems operational". There
  the page not moving IS the promise kept. The live run that caught it: verdict
  MET at confidence 85, `dated_in_window` true, `artifact_found` true, drift
  10000, corroborated by the validators — every signal agreeing, and the contract
  overruling all of them on a hash comparison.

  The discriminator is the promise text, which the model reads and the contract
  does not. So an unchanged page is now passed into the prompt as an explicit
  note, recorded as `unchanged` and a recomputed `drift_bps`, **compared between
  validators as a drift bucket** so a leader cannot misreport it, and shown in
  the UI next to the verdict. That is "flag it, don't blindly accept" without the
  contract pretending to classify a promise it never read.

One thing I tried and dropped: `gl.nondet.web.get(..., sign=True)` would let a
publisher verify a request came from the contract. Studio Devnet answers
`SIGN_URL_PATCH_FAILED`. Nothing here depends on it.

## FIX 5 — deadline-time evidence

**The question is what the page said at the deadline, not what it says now.** A
verification can run most of a period after the window closed, and the old code
simply fetched the URL at settlement time.

`_evidence` now resolves, in order:

1. **A snapshot the committer pinned at creation.** The bytes were fixed before
   anyone knew the verdict and the URL is on chain, so every validator fetches
   the identical thing.
2. **A public archive capture from just after the deadline.** Accepted only if
   it lands **at or after** the deadline and no further past it than one period,
   capped at seven days. The window is the period rather than a constant because
   a fixed seven days would let a capture six days stale stand as evidence about
   a five-minute period — I had that bug and the offline tests now pin it. A
   capture from before the deadline is refused however close: it shows the page
   partway through the window, a different question. Fetched with the `id_`
   modifier — the raw archived bytes, not the page the archive wraps them in,
   which carries a live banner and would differ between fetches.
3. **The live page**, recorded as such. `evidence_kind` is stored on the row and
   shown in the UI, so a verdict reached on today's page about a past window is
   visible as exactly that.

The deadline timestamp is stored on every history row, and the snapshot URL and
its 14-digit capture stamp are stored and linked, so an auditor can open the
exact bytes the validators read.

**Validators verify the leader's snapshot rather than re-deriving their own.**
Two nodes querying the availability API seconds apart can get different "closest"
captures if a new one lands between them — a real UNDETERMINED generator. So the
leader's snapshot URL rides in its result, `_snapshot_ok` checks it is legitimate
(right archive, same domain, within the window of *this* deadline), and the
validator fetches that URL and compares hashes. Verification rather than
re-derivation — and the corroboration is genuine, because the validator pulled
the bytes itself.

## FIX 6 — validators compare more than the verdict

They now compare four things, and each had to earn its place, because every extra
agreement condition is another way to land UNDETERMINED:

| axis | how | why that strictness |
|---|---|---|
| verdict | exact | no adjacent-value tolerance |
| evidence hash | **exact**, when both read an archived snapshot | an immutable capture is the same bytes for everyone; the live page is not — it carries timestamps and ad slots and differs between two honest nodes |
| drift since creation | five coarse buckets | coarse enough to survive that same page noise, sharp enough that a leader cannot misreport a frozen page |
| three extracted observations | two of three must match | booleans derived from the page reproduce far better than prose; all-three turns every borderline page into a burned round, none leaves the leader deciding everything but the label |

The last three apply **only to decisive verdicts**. An inconclusive outcome costs
nobody their stake, so tightening agreement around it spends rounds and buys
nothing.

The observations are `dated_in_window`, `artifact_found`, `addresses_reader` —
asked for explicitly in the prompt, because a prompt that does not ask makes the
feature vector empty and silently drops a consensus condition. There is an
offline test for that.

**The decision table is module-level and pure.** `_leader_rejectable`, `_agree`
and `_settle` are ordinary functions of the leader's calldata and the validator's
own judgement, so `test/test_logic.py` walks every branch in milliseconds. The
code that decides who keeps a stake should not be reachable only through a live
consensus round.

Two property sweeps over the whole combination space assert the laws rather than
the cases, because individual branch tests can all pass while the combination
still lets something through:

- no decisive verdict is ever agreed to by a validator that retrieved nothing —
  the review's finding, as an invariant — nor across two different kinds of
  evidence, nor across a drift bucket, nor on archived evidence that hashed
  differently;
- no settlement ever moves money without identifiable, corroborated evidence,
  whatever junk the agreed payload contains.

## FIX 7 — conservative resolution

- **Unreachable proof URL → INCONCLUSIVE**, never NOT_MET. Enforced three times:
  as a pure gate on the leader's calldata, in `_agree`, and re-forced after
  consensus in `_settle`.
- **A validator that cannot retrieve the evidence does not shrug and agree.**
  This reverses what the old code did. It agreed with a reachable leader whenever
  its own fetch failed, reasoning that one node's blip is not evidence against
  another's success. True — but a blip is not evidence *for* it either, and
  signing off on a decisive verdict with no evidence of your own is accepting a
  reachable leader on nothing but its own word. That is the hole the review
  named. Now the only thing a blind validator will sign is the outcome that costs
  nobody their stake. The cost is real (a transient failure on enough validators
  burns a round) and it is paid down where it belongs: `_render_text` retries
  before concluding a page is unreachable.
- **Disagreement on content → no settlement.** Mismatched archive hashes,
  mismatched evidence kinds, mismatched drift buckets, or fewer than two matching
  observations all return `False` on a decisive verdict, so the leader's result is
  rejected rather than accepted.
- **`settle_stalled`** is a first-class entry point. It and `settle_lapsed` share
  `_close_unverified` and differ only in the sentence they write onto the record,
  because a period nobody bothered to verify and a period consensus could not
  settle are different problems and the record should say which. Permissionless,
  ungated on `paused`, and it always returns the stake — which is what makes
  tightening agreement an improvement rather than a new way to trap money.

---

## The past rejection patterns

`node test/audit.mjs` re-checks every one of these from scratch, structurally
against the source (with comments stripped, so it cannot pass on its own
explanations) and live against the deployment.

| | status |
|---|---|
| No counter-before-revert | checked structurally: no state write precedes any returning rejection path in either payable method, and `_reject` refunds and returns rather than raising |
| Fee snapshotted at creation | **changed.** `record.bounty_bps` / `record.cancel_bps` are stamped at creation and read from the record at settlement. The old version read the live rate and argued the exposure was bounded; "bounded and unmotivated" is not the same claim as "cannot" |
| Refund-on-reject on all payable paths | both payable methods route every rejection through `_reject`; neither can raise |
| Owner can't freeze funds | `paused` gates only `create_commitment` and `add_stake`. `verify_commitment`, `settle_lapsed`, `settle_stalled` and `cancel_commitment` are checked to contain no reference to it |
| No assistant attribution in git | no commit, no tracked file — **including `.gitignore`**, whose ignore rules moved to `.git/info/exclude` so a reviewer grepping the tree finds nothing |
| Content hash present | at creation and on every settled row, plus the 256-bit fingerprint drift is measured against |
| All stored fields recomputed post-consensus | `_settle` re-normalises the verdict, re-validates hashes as hex, re-checks the claimed snapshot, **recomputes** drift from the creation fingerprint, clamps confidence, and replaces reasoning written for a verdict that has since moved |

---

## What actually ran

Verbatim output from every one of these is in
[`docs/PROOF.md`](PROOF.md) — nothing transcribed by hand.

| | result |
|---|---|
| `python3 test/test_logic.py` | 9,103 assertions, 0 failed |
| `node test/audit.mjs` | 103 passed, 0 failed (source + live) |
| `node test/e2e.mjs` | 149 passed, 0 failed against the live network |
| `node test/proof-commitments.mjs` | 3 commitments, quote → hash → ACCEPTED → FINALIZED → id → frontend state |
| `node test/proof-archive.mjs` | 15 passed — a verdict reached on an immutable snapshot, `evidence_kind=ARCHIVE` |
| `node test/probe.mjs` | the optional seventh parameter binds its default for six-argument callers |
| `node test/repro-fee-failure.mjs --network=bradbury` | the failure reproduced on the wire, refused before signing, then a funded wallet through to commitment #0 |
| `node test/nudge.mjs --tx=0xf504a684…` | a genuinely stuck Bradbury transaction driven COMMITTING → ACCEPTED in 396s and 14 nudges |

The verdicts the network actually reached, on the fixtures:

- **kept** → MET at confidence 94. Committer 0.095, caller 0.005, beneficiary 0.
- **broken** → NOT_MET. Beneficiary 0.095, committer 0, caller 0.005. *"The page
  states 'No posts yet' and explicitly notes it has been empty since it was set
  up."*
- **hostile** → NOT_MET, injection flagged on the record, and the stored
  reasoning does not parrot the verdict the page tried to dictate.
- **self-verified** → MET with no fee charged; the whole stake back.
- **unchecked** → LAPSED, stake returned, scored as unverified and never as kept.
- **pinned snapshot** → MET at confidence 100, `evidence_kind=ARCHIVE`, drift
  1714 bps recomputed on chain.

## What to run

```bash
cd test
python3 test_logic.py              # 11,000+ offline assertions, no network
node audit.mjs                     # the rejection-pattern audit, source + live
node repro-fee-failure.mjs --network=bradbury   # the reported failure, reproduced
node e2e.mjs --base=https://stakeyourword.vercel.app
```

One operational note that is not a fix but caused most of the wall-clock cost:
**Studio Devnet meters at 30 requests per minute per IP**, which a single settled
write can spend. `test/pacer.mjs` wraps `fetch` and paces every outgoing request
under that. Pacing at the call sites instead would mean finding the call sites
inside genlayer-js and viem.
