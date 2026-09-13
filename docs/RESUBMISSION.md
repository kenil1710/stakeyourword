# StakeYourWord — resubmission

Every point in the review, what was actually wrong, and what to run to check it.

| | |
|---|---|
| Contract | `0xF21613D665AE004204397723b393Baaee23CF623` |
| Network | GenLayer **Studio Devnet** — chain `61997`, `https://studio-dev.genlayer.com/api` |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (v0.3.0) |
| App | https://stakeyourword.vercel.app |
| Source | https://github.com/kenil1710/stakeyourword |

---

## First, the one thing I could not do

The review asks for a **funded Bradbury reproduction** of a successful
`create_commitment` — hash, wallet-confirmation screen, receipt, commitment id,
refreshed frontend.

I could not produce that, and the reason is the substance of the bug rather than
an excuse for skipping it. **Bradbury has no programmatic faucet.** The only way
to fund an address there is the Cloudflare-gated web faucet at
`testnet-faucet.genlayer.foundation`, which needs a human and a browser. Every
Bradbury account this project holds is at exactly 0 GEN, which is precisely why
the write failed in the first place.

What I did instead, and what I think is the stronger answer:

1. **Reproduced the exact failure on Bradbury, deterministically**, with the
   full RPC sequence on the wire — see below. Not a description of the bug; the
   bug.
2. **Fixed it** so the same call is now refused locally with the amount named,
   before a wallet dialog can open.
3. **Ran the complete successful lifecycle on Studio Devnet**, which is where
   this contract has to live anyway (below), with real transaction hashes,
   accepted/finalized receipts, commitment ids and a live frontend reading them.

To complete the Bradbury half: claim 100 GEN at the faucet for
`0x28Be0f914219422fA0F46F201f47D8356B3eCeC0` and run
`node test/repro-fee-failure.mjs --network=bradbury`. The "BEFORE" section will
stop reproducing and the "AFTER" section will report `affordable: true`. That is
one manual step and I have left it as the only one.

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

- Every write reports one of **six** terminal states, and they are not collapsed:
  `blocked` (refused before signing — nothing sent, nothing spent), `pending`,
  `accepted`, `finalized`, `rejected`, `error`.
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
- **Changed content is flagged, and a frozen page cannot pay out.** After
  consensus, a MET verdict on evidence byte-identical to what the page said at
  creation is **downgraded to INCONCLUSIVE** and the stake comes back. Nothing new
  on the nominated page is not evidence that anything was done. The rule compares
  two values the contract already stores, so it is deterministic, and it only
  ever moves a verdict toward the outcome that costs nobody their stake.

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
2. **A public archive capture from around the deadline.** `_find_snapshot` asks
   the Wayback availability API for the closest capture to the deadline stamp,
   accepts it only within `ARCHIVE_WINDOW_SECONDS` (7 days), and fetches it with
   the `id_` modifier — the raw archived bytes, not the page the archive wraps
   them in, which carries a live banner and would differ between fetches.
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
