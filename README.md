# StakeYourWord

Make a public promise, put GEN behind it, and let a network of GenLayer validators
read the proof at each deadline and decide whether you kept it.

A commitment is a sentence, a URL that will show whether you did the thing, a
beneficiary who collects if you don't, and a stake per period. At each deadline
anyone can call `verify_commitment`. Every validator retrieves the evidence
itself, judges it independently, and the money moves the way the agreed verdict
says — in the same transaction, with no owner in the loop.

**Live on GenLayer Studio Devnet**

| | |
|---|---|
| Contract | `0xA6CEc813955e78F7B71969FB909646530D61006A` |
| Network | Studio Devnet (chain id `61997`, `https://studio-dev.genlayer.com/api`) |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` (v0.3.0) |
| Contract source | [`contracts/stake_your_word.py`](contracts/stake_your_word.py) |
| Design notes | [`contracts/NOTES.md`](contracts/NOTES.md) |

Studio Devnet is the only one of the three networks running the **v0.3.0**
executor line this contract targets. Studionet and Bradbury still resolve v0.2
runners and answer `invalid_contract runner malformed` for this source — a
runner-version mismatch, not a broken contract.

## What the evidence is

**The question is what the proof page said at the deadline, not what it says
now.** A verification can run most of a period after the window closed, and
judging today's page against a window that shut last Tuesday is not evidence
about Tuesday.

So the contract resolves evidence in this order:

1. **A snapshot the committer pinned at creation.** Optional, and the strongest
   option: the bytes were fixed before anyone knew the verdict, the URL is on
   chain, and every validator fetches the identical thing.
2. **A public archive capture from around the deadline.** The contract asks the
   Wayback availability API for the closest capture to the deadline and accepts
   it only if it lands within seven days, fetching the raw archived bytes rather
   than the page the archive wraps them in.
3. **The live page**, recorded as such. `evidence_kind` is stored on the row and
   shown in the UI, so a verdict reached on today's page is visible as exactly
   that.

The page is also hashed and fingerprinted **at creation**, and every settlement
measures drift against that stored fingerprint — recomputed on chain after
consensus, so a leader cannot understate how far the page has moved.

Proof URLs must be **https**. An http page has no authenticated origin, so
nothing fetched over it can be attributed to the publisher the committer named.

## How the verdict is decided

The leader retrieves the evidence, judges it, and returns a verdict with its
reasoning and three extracted observations. Every validator then:

1. Rejects the leader outright, without spending a fetch, if the verdict is not
   one of `MET` / `NOT_MET` / `INCONCLUSIVE`, if the reasoning is under 40
   characters or contradicts the verdict it is attached to, if it claims a
   verdict other than INCONCLUSIVE on no evidence, or if the archive snapshot it
   claims to have read is for the wrong domain or the wrong deadline
   (`_leader_rejectable`).
2. Retrieves the evidence itself.
3. Compares, in `_agree`:
   - **the verdict**, exactly — no adjacent-value tolerance;
   - **the evidence hash**, exactly, when both read an archived snapshot. An
     immutable capture is the same bytes for everyone, so it is the one axis that
     can be compared byte-for-byte;
   - **the drift bucket** — how far the evidence has moved since creation, in
     five coarse bands that survive timestamps and ad slots;
   - **three extracted observations** — whether the page carries a date inside
     the window, whether a concrete artefact of the work is present, whether the
     content is speaking to the evaluator — of which two of three must match.

The last three are checked only for decisive verdicts. An inconclusive outcome
costs nobody their stake, so tightening agreement around it spends rounds and
buys nothing.

**A validator that cannot retrieve the evidence does not shrug and agree.** Its
own failed fetch corroborates nothing, so the only thing it will sign off on is
the outcome that costs nobody their stake: inconclusive. Accepting a reachable
leader on nothing but its own word is the hole that rule closes.

Everything that reaches storage is **recomputed after consensus** in `_settle`:
the verdict is re-normalised, hashes are re-validated as hex, a claimed snapshot
is re-checked, drift is recomputed from the creation fingerprint, confidence is
clamped, and reasoning written for a verdict that has since moved is replaced
rather than stored next to a contradiction.

A page that has not moved since the promise was made is **flagged, not judged**:
the model is told explicitly, the drift is recorded, and validators compare the
drift bucket so a leader cannot misreport it. It is not a hard rule, because only
the promise text says whether an unchanged page means nothing happened or means
it held — and the contract never reads the promise.

An unreachable page is always `INCONCLUSIVE`, never `NOT_MET` — a site going down
cannot cost anyone their stake.

Page text reaches the model inside `<<<UNTRUSTED_CONTENT_BEGIN>>>` /
`<<<UNTRUSTED_CONTENT_END>>>` fences, with zero-width characters and any forged
fence tokens stripped first. A page that tries to dictate a verdict is flagged
and recorded, never obeyed.

## Sending a transaction

Studio Devnet is **not gasless**. Every write is an EVM transaction to the
consensus contract, and the network locks the fee *plus* whatever stake rides
with it before the contract runs. A wallet that cannot cover both is rejected on
chain with `LackOfFundForMaxFee`.

So nothing opens a wallet dialog you cannot afford to confirm:

- every write is quoted with `estimateTransactionFeesForWrite` — which also
  carries the message-fee allocations any call emitting a payout needs;
- the estimate is checked against the wallet balance, and a shortfall is refused
  locally with the exact amount missing;
- `preflight_create` runs the contract's *own* rejection logic as a view, so the
  reason shown before signing is the reason the write would give;
- after signing, the hash appears immediately and the transaction is tracked
  through **pending → accepted → finalized**;
- if it parks, the user gets **Check status**, **Nudge** and **Retry** rather
  than a spinner with no exit.

See [`frontend/src/lib/fees.ts`](frontend/src/lib/fees.ts) and
[`test/fees.mjs`](test/fees.mjs), which exist for exactly this.

## Running the tests

### Contract logic — 11,000+ assertions, no network

```bash
cd test
python3 test_logic.py
```

Pure-function coverage of the fee split, the coherence gate, the content hash and
the shingle sketch, drift buckets, archive-snapshot validation, source
classification, the feature vector, defanging and fence-forgery, the civil-date
maths and the period schedule — plus every branch of the consensus decision table
(`_leader_rejectable`, `_agree`) and the post-consensus recomputation
(`_settle`). Those three are module-level and pure precisely so the code that
decides who keeps a stake is not reachable only through a live consensus round.

The bulk of the count is two property sweeps over the whole combination space,
because individual branch tests can all pass while the combination still lets
something through. They assert the laws rather than the cases:

- **no decisive verdict is ever agreed to by a validator that retrieved
  nothing** — the review's finding, as an invariant — nor across two different
  kinds of evidence, nor across a drift bucket, nor on archived evidence that
  hashed differently;
- **no settlement ever moves money without identifiable, corroborated
  evidence**, whatever junk the agreed payload contains, and the stored
  reasoning always suits the stored verdict.

### The standing audit

```bash
cd test
node audit.mjs
```

Every pattern a past review rejected this project for, re-checked from scratch —
structurally against the source (with comments stripped, so the audit cannot pass
on its own explanations) and live against the deployment.

### The reported failure, reproduced

```bash
cd test
node repro-fee-failure.mjs --network=bradbury
```

Submits the same write twice against the same network — once the way production
did, once through the preflight — and prints the RPC errors on the wire in order,
so the `LackOfFundForMaxFee` → `eth_sendRawTransaction` sequence is visible as
one failure rather than two. Needs no funded account; that is the point.

### The proof runs

```bash
cd test
node proof-commitments.mjs                 # quote → hash → receipt → id → frontend state
node proof-archive.mjs                     # a commitment judged on a pinned snapshot
```

`proof-commitments.mjs` creates three commitments and prints, for each, the fee
quote the wallet was checked against, the transaction hash, the receipt as the
chain reports it, the commitment id, and the state read back **through the
deployed app's own relay**. `proof-archive.mjs` covers what the fixtures cannot:
a commitment with an immutable snapshot pinned at creation, settled on
`ARCHIVE` evidence rather than a live read.

### End-to-end against a live network

```bash
cd test
npm install
node accounts.mjs                       # create the throwaway signing keys
node deploy.mjs                         # defaults to studiodev
node e2e.mjs --base=https://stakeyourword.vercel.app
```

`--base` is where the verification fixtures live. They have to be fetchable **by
the validators**, so localhost is never a valid answer.

Studio Devnet meters at 30 requests per minute per IP, which a single settled
write can spend. [`test/pacer.mjs`](test/pacer.mjs) wraps `fetch` and paces every
outgoing request under that, so the suite is slow and does not spend its time
recovering from its own throughput.

### Deploying

```bash
cd test
node deploy.mjs --network=studiodev --write-env
```

`--write-env` rewrites both keys in `frontend/.env.local` — address *and*
network. Writing only the address leaves the app reading a studiodev contract
over the previous network's RPC, which surfaces as "contract not found" for a
contract that exists.

`deploy.mjs` checks the runner header before it submits (line 1 the version, line
2 a pinned hash, never a `test`/`latest` alias), quotes the deploy fee, and
refuses source over the per-network size ceiling rather than letting the
consensus contract revert without explanation.

## Running the frontend

```bash
cd frontend
cp .env.example .env.local     # then set the address and network
npm install
npm run dev
```

`/fixtures` serves deliberately plain proof pages — kept, broken, stale,
ambiguous, and hostile — so a full lifecycle can be demonstrated without
depending on a third-party site staying up.

## Layout

```
contracts/stake_your_word.py   the intelligent contract
contracts/NOTES.md             design decisions and GenVM hazards
test/test_logic.py             pure-logic assertions
test/audit.mjs                 the standing rejection-pattern audit
test/e2e.mjs                   lifecycle tests against a live network
test/fees.mjs                  fee estimation and the preflight balance check
test/pacer.mjs                 the global RPC rate limiter
test/repro-fee-failure.mjs     the reported production failure, reproduced
test/proof-commitments.mjs     quote → hash → receipt → id → frontend state
test/proof-archive.mjs         a commitment settled on a pinned snapshot
test/deploy.mjs                deploy + sanity read + env write
docs/RESUBMISSION.md           the review, point by point, and what to run
frontend/                      Next.js app
```
