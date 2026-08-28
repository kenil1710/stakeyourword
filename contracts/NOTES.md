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

## Deployment hazards

**The runner header must be alone on line 1.** GenVM parses the whole *contiguous*
leading `#` block as the runner JSON. Put a comment on line 2 and it gets
concatenated into that JSON, the parse fails, and the contract becomes
undeployable — surfacing only as `invalid_contract` with an empty stderr, while
`genvm-lint` passes clean. Nothing may sit between line 1 and `from genlayer
import *`.

**`str.replace()` is rejected by the Bradbury runner.** Anywhere a replace would
be natural, scan char-by-char or slice around `find()` instead. The only
substitute the contract needs is `_strip_token`, used by `_defang` to remove
forged fence tokens.

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

**The verdict is the ONLY compared axis.** Every additional agreement condition is
another way to land UNDETERMINED. Confidence, reasoning text and content hash are
all stored but never compared.

**The gates, in order** (`verify_commitment.validator_fn`):

1. `leader_result` is not a `gl.vm.Return` → re-run `leader_fn()` and return
   `False`. A leader error must be RE-RUN, never answered `False` on its own:
   returning `False` short-circuits agreement and turns every transient failure
   into a disagreement that burns a round. Letting the deterministic error surface
   lets two matching errors count as agreement.
2. Verdict must normalise to one of the three. `LAPSED` is deliberately absent
   from `_norm_verdict` — no model may produce it.
3. `_coherent(verdict, reasoning)`. Validators only ever compare the verdict, so
   without this the `reasoning` stored on chain is unverified leader prose: a
   leader could have the network agree on NOT_MET and then write "the promise was
   clearly kept" into the permanent record. The check is a length floor plus a
   short list of near-verbatim restatements of the opposite verdict. The list is
   narrow on purpose — a `_coherent` failure costs a consensus round, so anything
   a legitimate reasoning could contain stays out. "The previous period was
   fulfilled but this one was not" must not trip the NOT_MET list, which is why
   the entries are anchored on "commitment"/"promise" as the subject.
4. Leader says unreachable but its verdict is not INCONCLUSIVE → disagree. This
   makes "page down ⇒ benefit of the doubt" a structural rule rather than a hope
   about the prompt.
5. Leader says unreachable and *I* reached it → disagree. Anti-grief: a leader may
   not claim a live page is dead to force a cheap INCONCLUSIVE and rescue a
   committer who was about to lose the period.
6. *I* failed to fetch but the leader reached it → agree. The reverse of 5, and
   deliberately asymmetric: my own failed fetch is not evidence against a leader
   that succeeded, and treating it as such would turn every transient network blip
   on one validator into a burned round.
7. Neither reached it → agree iff INCONCLUSIVE.
8. Otherwise compare verdicts.

The same asymmetry (5 and 6) governs the creation-time reachability check, in
miniature.

**The verdict is re-forced after consensus.** `verify_commitment` recomputes
`_norm_verdict` on the agreed result and downgrades to INCONCLUSIVE if the result
says the page was unreachable. Gate 4 should already have made that impossible,
but the settlement branch is where money moves and it does not rely on a gate
elsewhere in the file staying correct.

**Content hashing.** `_content_hash` is FNV-1a written out by hand: Python's
`hash()` is seeded per process, so leader and validators would disagree for no
reason at all. It is masked to 64 bits at every step and returned as hex *text*,
so nothing ever meets `u64` mid-computation where a GenVM overflow would kill the
transaction. Whitespace is collapsed first, because reflow between two renders is
noise rather than a content change.

**`unchanged` is an advisory, never a gate.** The hash of the page at this
verification is compared against the hash at the *previous* verification and the
result is passed into the prompt as a note. For "publish something weekly", a
byte-identical page is strong evidence that nothing new happened. It is
deliberately not part of any agreement condition: the fresh hash varies between
nodes whenever a page carries a timestamp, a view counter or an ad slot, and a
varying gate is an UNDETERMINED generator.

Note the semantics invert from a fact-checking contract. There, a page that
changed under the claim is a tampering signal. Here, a page that changed is the
committer doing what they promised.

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
- "if the page could not be reached, the verdict is INCONCLUSIVE";
- "recurring promises are judged on THIS period only";
- "a promise too vague to check against any page is INCONCLUSIVE";
- the closing line telling the model other validators judge independently.

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

## The grace window and `settle_lapsed`

A period is verifiable from its deadline until one full period later. Inside that
window `verify_commitment` runs the real judgement. Past it, `settle_lapsed`
closes the period deterministically, with no model call at all.

**Why stale periods must not reach the model.** Verification fetches the URL *now*.
Judging period 1 three weeks late means judging today's page against a window that
closed three weeks ago, which is not evidence of anything. Recording that the
period went unverified is more honest than manufacturing a verdict from the wrong
page.

**LAPSED returns the stake to the committer.** Same benefit-of-the-doubt an
INCONCLUSIVE verdict earns. The trade-off is real and worth stating: a committer
who has failed does best if nobody calls. What makes that a bad strategy is that
the beneficiary is standing right there for 95% of the stake and any stranger gets
5%, so a lapse means *two* motivated parties both failed to act. It is scored
separately (`user_lapsed`, `count_lapsed`) and shown publicly as unverified —
never as kept — so it cannot launder a broken promise into a track record.

**This is also the exit for stalled consensus.** `verify_commitment` can land
UNDETERMINED indefinitely — a page the models cannot stabilise on, a network that
cannot form a round. Without `settle_lapsed` that stake would sit locked with no
path back to its owner at all. Permissionless on purpose: a refund path only the
owner can trigger is not a guarantee, it is a promise, and it hands back exactly
the withholding power that keeping `paused` off the settlement paths was meant to
remove.

**`settle_lapsed` ignores the verify lock.** The lock is a queue-jamming guard for
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
- **URL scheme restriction.** `_url_problem` accepts only `http://` and
  `https://`, which is also what rejects `javascript:`, `file:` and `data:`.
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

## Views

`get_active_commitments` and `get_verifiable_now` scan the id list backwards under
`SCAN_CAP` rather than maintaining a status index. An index that has to be
compacted on every state change is a bug farm at this scale, and the scan is
bounded and cheap.

`_derived` computes `next_deadline`, `grace_ends`, `periods_remaining` and — for
the bounty board — the `action` (`VERIFY` or `LAPSED`) and the exact bounty in
wei, so the UI never has to guess which method to call or what it pays.
