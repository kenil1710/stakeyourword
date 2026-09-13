# StakeYourWord contract — design notes

Long-form rationale for `contracts/stake_your_word.py`. The contract has a hard
size budget (40 KB target, 48 KB runner limit) and every byte of comment competes
with feature code, so the contract keeps only one-line pointers at each hazard and
the full reasoning lives here.

## What the contract does

Someone makes a public promise, names a URL where the proof will be, names a
beneficiary, and stakes GEN against keeping it. At each deadline anyone may call
`verify_commitment`; validators each fetch the page themselves and each judge
whether the promise was kept for that period. Kept, the stake goes home. Broken,
it goes to the beneficiary. Either way the caller takes a 5% finder's fee —
unless the caller is the committer, in which case verification is free.

## Size budget and house style

- **Tab indentation.** One byte per level instead of four. Tabs are legal and
  consistent throughout; never mix in spaces for block indent, or the runner
  raises `TabError`. Continuation lines inside brackets are two tabs past their
  statement.
- **Prose lives here.** The contract keeps ~20 one-line comments, each marking a
  hazard whose violation is silent.
- **Multi-line dict literals are packed** to ~100 columns rather than one key per
  line.

Do not spend the remaining headroom on prose. If the contract needs new logic, it
fits; if it needs new explanation, it goes in this file.

## Which network this targets, and why the header looks like that

The contract is written against the **v0.3.0 executor line** of the Python SDK
and deploys to **Studio Devnet** (`studiodev`, chain 61997,
`https://studio-dev.genlayer.com/api`). That is not a preference; it is the only
one of the three networks running v0.3.0. Studionet and Bradbury still resolve
v0.2 runners and answer `invalid_contract runner malformed` for this source —
a runner-version mismatch, not a broken contract.

The header is two lines and both are load-bearing:

```
# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
```

Line 1 is the **runner version**: GenVM reads the first comment line, and if it
starts with `v` that is the version string. Line 2 onwards is the runner JSON.
Get either wrong and you get `invalid_contract runner malformed` from a
transaction that still charged you a fee, so `deploy.mjs` checks both shapes
before it submits, and refuses a `test` or `latest` alias outright.

The hash is pinned and was verified by deploying against it. The hash published
on the SDK docs site at the time of writing
(`9b8kjyda2ycxyq4ea6g4yfpnydxhd52gqba5rb8dw7krkh5mn9p0`) is **not** in Studio
Devnet's manifest and is rejected as malformed; the one above is what that
network actually resolves.

## The v0.3.0 API, in the places it bites

- `gl.Contract` → `gl.contract.Contract`; `TreeMap` / `DynArray` → `gl.storage.*`;
  `@allow_storage` → `@gl.storage.allow`; `gl.message_raw` → `gl.message.raw`.
- **`u32(...)` and friends are no longer callable.** They are `Annotated`
  aliases now, not `NewType`s. Every wrapper had to go; assigning a plain `int`
  to a `u128` field is the correct spelling.
- **`gl.vm.run_nondet` changed meaning.** It is now the old `run_nondet_unsafe`
  — validator not sandboxed — which is what a hand-written validator function
  wants. The old safe wrapper is `run_nondet_default`.
- `gl.evm.contract_interface` survives, and is still how a plain value transfer
  to an EOA is expressed.
- **`gl.contract.get_at` has no call site here, deliberately.** It is the v0.3.0
  spelling of `gl.get_contract_at`, and this contract makes no cross-contract
  read — there is nothing it needs from another contract. A cross-contract read
  is a consensus surface; opening one to satisfy a migration checklist would be
  worse than not having it. `test/audit.mjs` checks that the *old* spelling is
  gone, which is the part that would actually break, rather than asserting a call
  that should not exist.

## Deployment hazards

**Nothing may sit between the header and the import.** GenVM parses the
contiguous leading `#` block after the version line as the runner JSON. Put a
stray comment in there and it gets concatenated into that JSON, the parse fails,
and the contract becomes undeployable — surfacing only as `invalid_contract`
with an empty stderr, while `genvm-lint` passes clean.

**Studio Devnet is NOT gasless.** It runs a real fee policy: a transaction with
no fee envelope is rejected with `FeeValueMustBeNonZero`, and one whose sender
cannot cover `feeValue + userValue` is rejected with `LackOfFundForMaxFee`
before the contract runs at all. Every write is quoted with
`estimateTransactionFeesForWrite` and balance-checked first — see `test/fees.mjs`
and `frontend/src/lib/fees.ts`, which exist for exactly this.

**A write that emits a transfer needs message-fee allocations.** Every
settlement path here does. A bare `estimateTransactionFees()` does not carry
them and the transaction fails with `fee no_matching_allocation # external`
*after* the stake has already moved into the contract. Only the per-write
estimate simulates the call and derives them.

**The fee simulation runs on a stale clock.**
`estimateTransactionFeesForWrite` simulates the call, and on Studio Devnet that
simulation sees a `datetime` roughly 656 days behind the one a real transaction
gets. Every time gate in this contract therefore answers the wrong question
under simulation: a period that IS due simulates as "not due yet", one past its
grace window simulates as still inside it. So a simulated revert is REPORTED and
never obeyed — `quoteWrite` returns it as `wouldRevert`, the harness logs it, the
UI shows it once with a "send it anyway" button, and the real transaction is left
to be the authority. Only the balance check refuses, because balances are not
time-gated.

**Building a fee envelope by hand, when the simulation cannot.** Losing the
simulation also loses the message-fee allocations, and a settlement without them
fails with `fee no_matching_allocation # external` after the money moved. The
allocations are rebuilt from the commitment record — every outbound transfer here
goes to the committer, the beneficiary or the caller, and all three are known
before the call. Two details the consensus contract enforces and does not explain:

- `feeParams` is **not optional** for an external allocation. An empty one is
  rejected as `InvalidFeeParams` at submission, with nothing pointing at the
  envelope.
- `budget` must be **exactly** `gasLimit * maxGasPrice`. Anything else — larger
  included, so "be generous" is not available — is `ExternalAllocationInvalid`.

**The SDK major must match the executor line.** genlayer-js 2.x encodes calldata
for v0.3 and 1.x for v0.2, and they are not interchangeable: a `get_stats` read
that works under 1.1.8 comes back from 2.0.0-rc.1 against Bradbury as
`ValueError: call to private method __handle_undefined_method__`, which reads
like a missing method on a contract that plainly has it. So the project uses 2.x
everywhere it talks to Studio Devnet, and `test/repro-fee-failure.mjs` — the one
script that talks to Bradbury — pins 1.1.8 through an npm alias. That split is
also why the preflight in that script is the degraded, balance-only form: 1.1.8
has no fee-estimation API at all.

**Studio Devnet meters at 30 requests per minute, per IP.** That is low enough
that a single settled write can spend it. `test/pacer.mjs` wraps `fetch` and
paces every outgoing request under the limit; pacing at the call sites instead
would mean finding the call sites inside genlayer-js and viem.

**`str.replace()` works on the v0.3.0 runner** (the v0.2 Bradbury runner
rejected it). `_strip_token` still scans with `find()` rather than using it —
the slicing form is not slower here and it keeps the helper portable across both
runner lines.

**Never capture `self` in a nondet closure.** Values read from storage stay
storage-backed, and cloudpickling one while setting up the nondet block kills the
leader at `run_time 0s` with "Detected pickling storage class" — before any model
call, with only a `UserWarning` in `trace.stderr` to show for it. This is why
every deterministic helper is module level and pure, and why `create_commitment`
and `verify_commitment` copy calldata through `str()` before the closures touch
it. The purity also lets `test/test_logic.py` stub `genlayer` and exercise every
helper offline — no chain, milliseconds.

**`DynArray()` and struct literals cannot be constructed.** Storage containers are
grown with `get_or_insert_default()` and then `append_new_get()`, which returns a
fresh storage-backed row to fill in field by field. `_record_period` is the only
place history is written, for exactly this reason.

**`format(f, '.18f')` is unavailable.** Wei crosses the wire as `str(int)` and all
decimal formatting happens in TypeScript.

**`gl.message.sender_address`, never `gl.message.sender`.** The latter does not
exist and fails at runtime, not at lint.

## Money

**There is no protocol fee anywhere.** The contract takes nothing. The only two
transfers that are not a straight return of principal are the caller bounty, paid
to whoever settled a period, and the early-cancel fee, paid to the beneficiary.
Both go to users. That is why there is no `protocol_balance` field and no
`withdraw_fees` method, and why `locked_stakes` is the contract's *only*
liability: everything it holds is staked money it owes someone.

**Divide before multiply — for money.** `_split` computes
`(amount // BPS_DENOM) * rate`, so no intermediate ever exceeds `amount` and no
money value can overflow its `u128` field under any future cap. Truncation is
bounded by `(amount mod 10000) * bps / 10000 < bps` wei — under 500 at the default
rate — and always lands with the principal recipient, never the caller. The
principal is defined by SUBTRACTION rather than a second division, so the two legs
sum to exactly `amount` and not one wei is stranded.

**Ratios multiply first.** `kept_bps = (kept * BPS_DENOM) // decided` in
`get_track_record` and `get_stats` is the deliberate opposite. Those are `u32`
counts, the product cannot overflow anything, and dividing first would floor every
rate to zero. The rule is about money, not about arithmetic in general.

**Payable methods never raise.** A GenVM revert rolls back contract state but does
*not* return the value that rode in with the call: it stays in the contract,
unaccounted and unreachable. `create_commitment` and `add_stake` therefore route
every rejection through `_reject`, which refunds and *returns*
`{"ok": false, "reason": …, "refunded": …}` as a **successful** transaction.
Raising after the refund would roll the refund back along with everything else and
recreate the exact bug. Every caller — frontend and test harness alike — must read
`ok` from the returned JSON; a rejection is not a failure to submit.

**`_pay` is the single outbound choke point.** Every transfer goes through it so
`last_out_epoch` cannot be forgotten at a call site, which is what
`sweep_unallocated`'s safety depends on.

**`sweep_unallocated` cannot reach a stake.** It is capped at
`balance - locked_stakes`, and it refuses to run within `SWEEP_DELAY_SECONDS` of
the last outbound transfer. Transfers apply on FINALIZATION, so a payout still
sits in the balance for a while after the receipt says the settlement succeeded;
without the wait, money already promised to a committer would look exactly like
surplus.

## The owner cannot freeze committed money

`paused` gates `create_commitment` and `add_stake` and nothing else. Once a stake
is in, `verify_commitment`, `settle_lapsed` and `cancel_commitment` are its only
exits, and none of them checks `paused`. An owner who could withhold every
settlement indefinitely has the same power as an owner who can change a verdict,
just by a slower route. This has its own named regression test.

The owner also cannot touch `bounty_bps` or `cancel_fee_bps` beyond the constant
caps (`MAX_BOUNTY_BPS`, `MAX_CANCEL_FEE_BPS`), and the rates are read at
settlement time from storage — a commitment created under a 5% bounty settles at
whatever the current rate is, bounded by the cap. That is a deliberate
simplification: pinning the rate per commitment would add a storage field to buy
protection against a bounded move the owner has no incentive to make.

## Consensus

**Two nondeterministic moments.** A reachability check at creation, and the
judgement at each deadline. Both use `gl.vm.run_nondet` with an explicit
leader/validator pair.

**Why not `gl.eq_principle.prompt_comparative`.** The wrapper compares two answers
with a model and a natural-language principle, which is the right *shape*, but it
leaves nowhere to put the checks that must be deterministic. The gates below are
pure functions of the leader's own calldata, so every validator computes the
identical answer and they can reject a bad leader **without ever being a source of
UNDETERMINED**. Writing the pair by hand keeps the comparative principle and adds
them. The node-operator-tunable `EqComparative` template can still drop into the
validator as a final step if the verdict comparison ever proves too strict.

**Validators compare more than the verdict — but not everything.** Every extra
agreement condition is another way to land UNDETERMINED, so each one had to earn
its place, and each is either exact-on-immutable-data or deliberately coarse:

- **The verdict**, exactly. No adjacent-value tolerance.
- **The evidence hash**, exactly, but *only when both sides read an archived
  snapshot*. An immutable capture is the same bytes for everyone who fetches it,
  so it is the one axis that can be compared byte-for-byte without being an
  UNDETERMINED generator. The live page cannot: it carries timestamps, view
  counters and ad slots, and its hash differs between two honest nodes.
- **The drift bucket** — how far the evidence has moved from what the page said
  at creation, in five coarse bands. Coarse because the underlying similarity
  wobbles with that same page noise; sharp enough that a leader cannot claim a
  frozen page has changed, or the reverse.
- **Three extracted observations** — `dated_in_window`, `artifact_found`,
  `addresses_reader` — of which **two of three must match**. Booleans derived
  from the page reproduce far better across models than prose does, and the
  two-of-three floor is what stops a borderline page turning every verification
  into a burned round. Demanding all three was considered and rejected for that
  reason; demanding none leaves the leader deciding everything but the label.

The last three are checked **only for decisive verdicts**. An INCONCLUSIVE
outcome costs nobody their stake, so tightening agreement around it buys nothing
and spends rounds.

**`_leader_rejectable` and `_agree` are module level and pure.** The decision
table that settles who keeps a stake should not be reachable only through a live
consensus round. Both are ordinary functions of the leader's calldata and the
validator's own judgement, and `test/test_logic.py` walks every branch offline in
milliseconds.

**The gates, in order.** The first group is `_leader_rejectable` — pure functions
of the leader's own calldata, checked *before* the validator spends a fetch, so a
bad leader is rejected without the validator ever being a source of UNDETERMINED:

1. `leader_result` is not a `gl.vm.Return` → re-run `leader_fn()` and return
   `False`. A leader error must be RE-RUN, never answered `False` on its own:
   returning `False` short-circuits agreement and turns every transient failure
   into a disagreement that burns a round. Letting the deterministic error
   surface lets two matching errors count as agreement.
2. Verdict must normalise to one of the three. `LAPSED` is deliberately absent
   from `_norm_verdict` — no model may produce it.
3. `_coherent(verdict, reasoning)`. Validators compare the verdict and the three
   observations, not the prose, so without this the `reasoning` stored on chain
   is unverified leader text: a leader could have the network agree on NOT_MET
   and then write "the promise was clearly kept" into the permanent record. The
   check is a length floor plus a short list of near-verbatim restatements of the
   opposite verdict. The list is narrow on purpose — a `_coherent` failure costs
   a consensus round, so anything a legitimate reasoning could contain stays out.
   "The previous period was fulfilled but this one was not" must not trip the
   NOT_MET list, which is why the entries are anchored on "commitment"/"promise"
   as the subject.
4. Leader says it retrieved nothing but its verdict is not INCONCLUSIVE →
   reject. This makes "no evidence ⇒ benefit of the doubt" a structural rule
   rather than a hope about the prompt.
5. Leader claims an archived snapshot → `_snapshot_ok` must accept the URL it
   claims to have read: right archive, same domain as the commitment's proof
   URL, and a capture stamp within `ARCHIVE_WINDOW_SECONDS` of *this* deadline.
   When the committer pinned a snapshot at creation, only that exact URL passes.
   Pure, so every validator answers it identically, and cheap, so a leader
   pointing at somebody else's page costs nobody a fetch.

The second group is `_agree`, reached only once the validator holds evidence of
its own:

6. Leader says it retrieved nothing and *I* retrieved something → disagree.
   Anti-grief: a leader may not claim a live page is dead to force a cheap
   INCONCLUSIVE and rescue a committer who was about to lose the period.
7. **I retrieved nothing → agree only if the leader's verdict is INCONCLUSIVE.**
   This is the conservative rule, and it *reverses* what an earlier version did.
   That version agreed with a reachable leader whenever its own fetch failed, on
   the reasoning that one node's blip is not evidence against another's success.
   True, but beside the point: a blip is not evidence *for* it either, and
   signing off on a decisive verdict with no evidence of your own is accepting a
   reachable leader on nothing but its own word. Now the only thing a blind
   validator will sign is the outcome that costs nobody their stake. The cost is
   real — a transient failure on enough validators burns a round — and it is paid
   down where it belongs, in `_render_text`, which retries before concluding a
   page is unreachable.
8. Both read an archived snapshot → the evidence hashes must match exactly.
9. Decisive verdict, and the two sides read *different kinds* of evidence (one
   the deadline-time snapshot, the other today's page) → disagree. Those are
   different questions; money should not settle on the difference.
10. Decisive verdict → drift buckets must match, and two of the three extracted
    observations must match.
11. Otherwise compare verdicts.

The creation-time reachability check keeps the OLD asymmetry — a validator that
cannot fetch still abstains in the leader's favour. Nothing is at stake yet at
creation, and the failure mode there is a refund rather than a forfeit, so
conservatism has nothing to protect.

## Deadline-time evidence

**The question is what the page said AT THE DEADLINE, not what it says now.**
Verification runs whenever somebody calls it, which can be most of a period after
the window closed. Judging today's page against a window that shut on Tuesday is
not evidence about Tuesday, and an earlier version simply did that.

`_evidence` resolves, in order:

1. **A snapshot the committer pinned at creation** (`archive_url`). The bytes
   were fixed before anyone knew the verdict, and the URL is on chain, so every
   validator fetches the identical thing. This is the `ATTESTED` source class.
2. **A public archive capture from just after the deadline.** `_find_snapshot`
   asks the Wayback availability API for the closest capture, and `_snapshot_ok`
   accepts it only if it lands **at or after** the deadline and no further past
   it than one period (`_archive_window`, capped at `ARCHIVE_WINDOW_SECONDS`).
   It is fetched with the `id_` modifier — the raw archived bytes, not the page
   the archive wraps them in, which carries a live banner and would differ
   between fetches.

   **The window is the period, not a constant.** A fixed seven days is wrong at
   both ends of the range this contract allows: it would let a capture six days
   stale stand as evidence about a five-minute period, and it is already
   generous for a monthly one. And a capture from BEFORE the deadline is refused
   however close it is — it shows the page partway through the window, which is
   a different question from whether the promise was kept by the end of it.

   The API query is aimed half a window PAST the deadline rather than at it.
   The availability API returns the capture closest to the timestamp asked for,
   and aiming at the deadline makes it a coin toss whether that lands just
   before — which `_snapshot_ok` would then refuse, losing an archive that was
   there. Both numbers come from storage, so it stays deterministic.
3. **The live page**, recorded as such. `evidence_kind` is stored on the row and
   shown in the UI, so a verdict reached on today's page about a past window is
   visible as exactly that rather than quietly presented as deadline evidence.

**Validators verify the leader's snapshot rather than re-deriving their own.**
Two nodes querying the availability API seconds apart can get different "closest"
captures if a new one lands between them — a real UNDETERMINED generator. So the
leader's snapshot URL rides in its result, `_snapshot_ok` checks it is legitimate
(right archive, right domain, near the right deadline), and the validator then
fetches *that* URL and compares hashes. Verification rather than re-derivation,
and the corroboration is genuine: the validator pulled the bytes itself.

## Drift, and what a frozen page means

`_sketch` is a 256-bit shingle sketch — four 64-bit lanes of bits set by hashing
overlapping 4-word windows, rendered as hex text so nothing meets `u64`
mid-computation. `_sketch_sim` is Jaccard over the two bitmaps in basis points.

A content hash answers "identical?". Drift needs "how far has it moved?", and the
sketch is what makes that a number rather than a yes/no. It is computed at
creation and stored (`created_sketch`), and every settlement measures the
evidence against it.

**`drift_bps` is recomputed on chain after consensus**, from the stored creation
sketch and the agreed evidence sketch. The leader reports its own figure so
validators can compare buckets, but the number that reaches storage is the
contract's own arithmetic — a leader cannot understate how far the proof page has
moved.

**A frozen page is flagged, not judged — and this one was tried the other way
round first.**

The rule that shipped for an afternoon was: after consensus, a MET verdict on
evidence byte-identical to what the page said at creation is downgraded to
INCONCLUSIVE. It is deterministic, it only ever moves a verdict toward the
outcome that costs nobody their stake, and for "publish something weekly" it is
plainly right — nothing new on the nominated page is not evidence that anything
was done.

It is wrong for "my status page will still say all systems operational". There
the page not moving IS the promise kept, and the rule took a correct MET off a
committer who had done exactly what they said. The live run that caught it is
worth keeping: verdict MET at confidence 85, `dated_in_window` true,
`artifact_found` true, drift 10000, corroborated — every signal agreeing, and the
contract overruling all of them on a hash comparison.

The discriminator between those two cases is the PROMISE TEXT, which the contract
cannot read and the model can. So the frozen page is:

- passed into the prompt as an explicit note at both extremes (unchanged since
  creation, or substantially rewritten);
- recorded on the row as `unchanged` and as a recomputed `drift_bps`;
- **compared between validators** as a drift bucket, so a leader cannot
  misreport it;
- shown in the UI next to the verdict.

That is "flag it, don't blindly accept" without the contract pretending to
classify a promise it never read. NOT_MET on an unchanged page needs no special
handling either way — a page that did not move is exactly what a broken promise
looks like.

## Authenticated sources

`source_kind` is decided at creation and stored:

- **ATTESTED** — the committer pinned an immutable snapshot up front.
- **ARCHIVED** — the proof URL is already content-addressed (an archive host, an
  IPFS gateway, Arweave), so its bytes cannot move under the claim.
- **OPEN** — an ordinary page.

OPEN still settles; that is the product. What it does not do is settle a decisive
verdict on one node's word — the `_agree` gates make independent retrieval a
precondition of agreement on anything that moves money, and `corroborated` is
recorded on the row so a reader can see it was.

**https only.** `_url_problem` rejects `http://` with a message that says why: an
http page has no authenticated origin, so nothing fetched over it can be
attributed to the publisher the committer named, and attribution is the entire
point of nominating a page. The same rule rejects `javascript:`, `file:` and
`data:` as a side effect.

**Signing outbound requests was tried and is not available.** `gl.nondet.web.get`
takes a `sign=True` in v0.3.0, which would let a publisher verify the request
came from the contract; Studio Devnet answers `SIGN_URL_PATCH_FAILED`. Nothing
here depends on it.

## Everything stored is recomputed after consensus

`_settle` is the only thing that turns an agreed nondet result into storage, and
it copies nothing out of that result as-is. The settlement branch is where money
moves, and it does not rely on a gate elsewhere in the file staying correct.

- the verdict is re-normalised through `_norm_verdict`, and falls to
  INCONCLUSIVE if it is anything else;
- the hash and the sketch go through `_hex_only`, so a leader cannot write prose
  into a field the UI renders as a hash — and a malformed hash forces
  INCONCLUSIVE, because evidence you cannot identify is not evidence;
- a claimed archive snapshot is re-checked with `_snapshot_ok` (or against the
  committer's pinned URL) and discarded if it does not hold up;
- `drift_bps` is recomputed from the creation sketch, not read;
- confidence is clamped;
- the reasoning is replaced with `_downgrade_note` whenever the stored verdict is
  no longer the one that prose was written for, so the record can never carry a
  verdict next to text arguing the opposite;
- `corroborated` and `reachable` are derived from the surviving evidence kind
  rather than from anything the leader said about itself.

`_settle` takes no `self`, so `test/test_logic.py` exercises every one of these
offline — including the junk-input cases, which matter precisely because this
code runs where money moves.

**Content hashing.** `_content_hash` is FNV-1a written out by hand: Python's
`hash()` is seeded per process, so leader and validators would disagree for no
reason at all. It is masked to 64 bits at every step and returned as hex *text*,
so nothing ever meets `u64` mid-computation where a GenVM overflow would kill the
transaction. Whitespace is collapsed first, because reflow between two renders is
noise rather than a content change.

**`unchanged` is an advisory, never a gate.** The hash of the evidence at this
verification is compared against the hash at the *previous* verification and the
result is passed into the prompt as a note. It is deliberately not an agreement
condition: the live hash varies between nodes whenever a page carries a
timestamp, a view counter or an ad slot, and a varying gate is an UNDETERMINED
generator. The drift *bucket* is compared instead, precisely because it survives
that noise.

The one place a frozen page IS a rule is the post-consensus downgrade above, and
that rule compares two values the contract already stores rather than two live
fetches — so it is deterministic where the advisory is not.

Note the semantics invert from a fact-checking contract. There, a page that
changed under the claim is a tampering signal. Here, a page that changed is
usually the committer doing what they promised — which is why drift is recorded
and shown rather than penalised, and why only the *complete absence* of change
blocks a payout.

**Prompt safety.** Fetched text is wrapped in `<<<UNTRUSTED_CONTENT_BEGIN>>>` /
`<<<UNTRUSTED_CONTENT_END>>>`, and `_defang` strips those token *names* out of the
content first so a page cannot close the fence and impersonate the prompt's own
structure. Zero-width and bidi controls are removed **before** the token strip,
otherwise a single zero-width space inside `UNTRUSTED_CONTENT_END` would smuggle
the token straight through. The committer's own `description` is defanged too: it
is calldata rather than fetched content, but it reaches the same prompt.

`_injection_seen` is advisory only. It sets a flag on the record and nothing else
— it never decides a verdict. Detection lists are always incomplete, so the real
defence is the framing: the model is told the fenced region is untrusted data, and
that content addressing it directly is itself evidence of bad faith by the party
who published it.

**Load-bearing parts of the prompt that may not be cut for size:**
- the untrusted-data framing and the fences;
- the window bounds (`opened` / `due`) — a weekly promise is judged on *this*
  week, and without the dates the model has no way to know which;
- "if no evidence could be retrieved, the verdict is INCONCLUSIVE";
- "recurring promises are judged on THIS period only";
- "a promise too vague to check against any page is INCONCLUSIVE";
- **the provenance line** — whether this is an archived snapshot from around the
  deadline or today's live page, and when the snapshot was captured. Without it
  the model cannot tell which question it is answering;
- **the three observations and their definitions**. They are a compared axis, so
  a prompt that does not ask for them makes the feature vector empty and
  silently drops a consensus condition;
- the closing line telling the model other validators judge independently and
  must reach the same verdict *and* the same three observations.

## Recurring lifecycle

**Deadlines are anchored to creation.** `_deadline(created_at, period, n) =
created_at + n * period`. Nothing is stored per period and nothing accumulates, so
a verification that lands late cannot drift the schedule of every period after it.

**Funding is a live division.** `periods_remaining = total_staked //
stake_per_period`, and `total_staked` drops by exactly one period's stake as each
one settles. That is what makes `add_stake` a one-line change and "ran out of
money" automatic: `_close_if_dry` runs after every settlement and closes the
commitment the moment the remainder can no longer cover a period.

**Uneven funding is refunded immediately** rather than held as dust. No dangling
balance, no close-out sweep, and `locked_stakes` stays exactly the sum of the
`total_staked` of every ACTIVE commitment.

**`FAILED` vs `COMPLETED`.** A commitment that ran out of periods closes as
COMPLETED if anything was ever met, and FAILED if nothing was met and at least one
period was broken. It exists to make the one-time case read correctly — a single
promise, broken, must not display as "completed". A commitment whose every period
went INCONCLUSIVE or LAPSED closes as COMPLETED, because nothing was actually
adjudicated against the committer.

**Periods settle strictly in order, one per transaction.** `periods_settled` is
the pointer and every path advances it by exactly one.

## The grace window, `settle_lapsed` and `settle_stalled`

A period is verifiable from its deadline until one full period later. Inside that
window `verify_commitment` runs the real judgement. Past it, the period is closed
deterministically, with no model call at all.

**Two names, one implementation.** `settle_lapsed` and `settle_stalled` both call
`_close_unverified` and differ only in the sentence they write onto the record.
They exist as two entry points because a caller looking at a period nobody
bothered to verify and a caller looking at a period consensus could not settle
are looking at different problems, and the record should say which one it was.
The UI calls `settle_stalled`, because that is the failure a user is actually
staring at when the button appears.

**Why stale periods must not reach the model.** Even with deadline-time evidence,
a three-week-late verification is asking a model to judge a window that closed
three weeks ago against whatever the archive happens to hold — and if the archive
holds nothing, against today's page. Recording that the period went unverified is
more honest than manufacturing a verdict from the wrong evidence.

**LAPSED returns the stake to the committer.** Same benefit-of-the-doubt an
INCONCLUSIVE verdict earns. The trade-off is real and worth stating: a committer
who has failed does best if nobody calls. What makes that a bad strategy is that
the beneficiary is standing right there for 95% of the stake and any stranger gets
5%, so a lapse means *two* motivated parties both failed to act. It is scored
separately (`user_lapsed`, `count_lapsed`) and shown publicly as unverified —
never as kept — so it cannot launder a broken promise into a track record.

**This is the exit for stalled consensus, and the conservative rules make it
matter more.** `verify_commitment` can land UNDETERMINED indefinitely — a page
the models cannot stabilise on, a network that cannot form a round, or (now) a
majority of validators that could not retrieve the evidence and will not sign a
decisive verdict without it. That last one is a deliberate trade: tightening
agreement moves some outcomes from "settled wrongly" to "not settled", and the
only thing that makes that an improvement rather than a new way to trap money is
that the exit is permissionless and always returns the stake. A refund path only
the owner can trigger is not a guarantee, it is a promise, and it hands back
exactly the withholding power that keeping `paused` off the settlement paths was
meant to remove.

**The deterministic close ignores the verify lock.** The lock is a queue-jamming guard for
the expensive nondet path. Honouring it here would let a lock set by a *successful*
verification of period n block the catch-up close of period n+1 for twenty
minutes. Correctness does not depend on it: writes are sequenced per contract and
`periods_settled` is the real guard against settling the same period twice.

## The in-flight guard

`verify_lock[commitment_id]` is stamped when a verification starts and blocks
another for `VERIFY_LOCK_SECONDS`. It is self-healing: an UNDETERMINED transaction
applies no state, so a failed verification leaves no lock behind to brick the
commitment. `cancel_commitment` also respects it, so a cancel cannot race a
verification that is already in flight.

## Anti-abuse

- **Min stake** keeps dust commitments out; **max stake** bounds a single period.
- **Max 52 funded periods** bounds the total lock and the width of the streak rail
  in the UI.
- **Max 5 active commitments per wallet**, tracked in `active_count` and
  decremented on every terminal status.
- **180s cooldown between creates.** Measured from when the previous create
  *started*, because the clock is the transaction's own datetime, so the gap must
  exceed how long one create takes or it could never bind.
- **URL scheme restriction.** `_url_problem` accepts only `https://` — see
  "Authenticated sources" — which is also what rejects `javascript:`, `file:` and
  `data:`. The optional pinned snapshot goes through the same check.
- **The URL must be reachable at creation.** A commitment pointing at a dead page
  cannot be judged later, so it is refunded rather than created.
- **Cancelling cannot dodge a verdict.** `cancel_commitment` requires
  `now < next_deadline`, so once a period is due the only way out is settlement.
- **`_addr_problem` validates without constructing.** `Address()` raises on a bad
  value, and on a payable path a raise strands the incoming stake — so the
  beneficiary is checked character by character and only constructed afterwards.

## The bounty

Always carved from that period's stake, whichever way the verdict goes. The
alternative in the original sketch — paying the MET bounty "from protocol" — has
no funding source; the contract has no income, so that path drains until it cannot
pay, precisely on the honest commitments.

**Self-verification is free.** When `caller == committer` the bounty is zero and
100% of the stake settles normally. Two things follow. An honest committer can
close their own period at no cost, which is the right incentive and makes the 5%
the price of *someone else* doing the chore. And a committer facing a NOT_MET
cannot front-run the settlement to claw back the bounty share of a stake they were
about to lose.

**INCONCLUSIVE and LAPSED pay no bounty.** Paying for a non-answer would invite
callers to fire verifications at vague promises and thin pages. The bounty rewards
producing a settlement, not producing a transaction.

## Track record

`user_kept` / `user_broken` / `user_unclear` / `user_lapsed` are maintained in
`_score`, along with a current and best streak. A streak increments on MET and
resets on NOT_MET; INCONCLUSIVE and LAPSED leave it alone, because neither is an
adjudication against the committer. `kept_bps` is computed over *decided* periods
only (kept + broken), so an unreachable page or an uncalled period cannot dilute
someone's rate in either direction.

## Preflight

`preflight_create` is `_create_problem` exposed as a view. It answers everything
`create_commitment` would reject the call for — description length, URL scheme,
beneficiary, period bounds, stake bounds, funded-period count, the per-wallet
active cap, the cooldown — before a wallet is ever opened.

The point is that it is the SAME code path, not a reimplementation. A
TypeScript mirror of the contract's validation drifts the first time either side
changes, and the drift shows up as a transaction that reverts for a reason the UI
said was fine.

It cannot check reachability, and it says so: `checks_reachability` is always
`false`. That check is non-deterministic and only exists inside consensus, so a
clean preflight is not a promise the create will succeed — and stating the limit
is the difference between a surprising refund and an expected one.

`_derived` also publishes `verify_in_flight`, `verify_lock_until` and `stalled`,
so the UI can tell a user that somebody else is already verifying (rather than
letting them send a transaction that reverts on the lock) and which method will
actually settle the period they are looking at.

## Views

`get_active_commitments` and `get_verifiable_now` scan the id list backwards under
`SCAN_CAP` rather than maintaining a status index. An index that has to be
compacted on every state change is a bug farm at this scale, and the scan is
bounded and cheap.

`_derived` computes `next_deadline`, `grace_ends`, `periods_remaining` and — for
the bounty board — the `action` (`VERIFY` or `LAPSED`) and the exact bounty in
wei, so the UI never has to guess which method to call or what it pays.
