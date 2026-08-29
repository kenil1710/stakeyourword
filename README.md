# StakeYourWord

Make a public promise, put GEN behind it, and let a network of GenLayer validators
read the proof page at each deadline and decide whether you kept it.

A commitment is a sentence, a URL that will show whether you did the thing, a
beneficiary who collects if you don't, and a stake per period. At each deadline
anyone can call `verify_commitment`. Every validator fetches the page itself,
judges it independently, and the money moves the way the agreed verdict says —
in the same transaction, with no owner in the loop.

**Live on GenLayer Bradbury Testnet**

| | |
|---|---|
| Contract | [`0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2`](https://explorer-bradbury.genlayer.com/address/0xEFC9312D79E5f9e18c2C602Ae6A23E1E0b710cD2) |
| Network | Bradbury Testnet (chain id `4221`) |
| Contract source | [`contracts/stake_your_word.py`](contracts/stake_your_word.py) |
| Design notes | [`contracts/NOTES.md`](contracts/NOTES.md) |

## How the verdict is decided

The leader fetches the proof page, judges it, and returns a verdict with its
reasoning. Every validator then:

1. Rejects the verdict outright if it isn't one of `MET` / `NOT_MET` /
   `INCONCLUSIVE`, if the reasoning is under 40 characters, or if the reasoning
   contradicts the verdict it is attached to (`_coherent`, `stake_your_word.py:231`).
2. Fetches the page itself and judges it independently.
3. Accepts only on an **exact** verdict match — there is no adjacent-value
   tolerance (`validator_fn`, `stake_your_word.py:844`; the comparison itself at `:871`).

The verdict is consensus-verified. The reasoning text is written by the leader
and coherence-checked by every validator, and the UI says so rather than
implying the prose itself was independently reproduced.

Page text reaches the model inside `<<<UNTRUSTED_CONTENT_BEGIN>>>` /
`<<<UNTRUSTED_CONTENT_END>>>` fences, with zero-width characters and any forged
fence tokens stripped first (`_defang`). A page that tries to dictate a verdict
is flagged and recorded, never obeyed.

An unreachable page is always `INCONCLUSIVE`, never `NOT_MET` — re-forced after
consensus at `stake_your_word.py:881`, so a site going down cannot cost anyone
their stake.

## Running the tests

### Contract logic — 276 assertions, no network

```bash
cd test
python3 test_logic.py
```

Pure-function coverage of the fee split, the coherence gate, the content hash,
defanging and fence-forgery, injection markers, the civil-date maths, and the
period schedule.

### End-to-end against a live network

```bash
cd test
npm install
node accounts.mjs                       # fund throwaway test accounts
node deploy.mjs                         # defaults to studionet
node e2e.mjs
```

Studionet settles in seconds; Bradbury takes minutes per verification.

### Deploying

```bash
cd test
# Studionet (gasless, fast)
node deploy.mjs --network=studionet --write-env

# Bradbury (real gas, minutes)
GENLAYER_KEYSTORE_PASSWORD='…' \
  node deploy.mjs --network=bradbury --keystore=<wallet> --gas=12000000 --write-env
```

`--write-env` rewrites `frontend/.env.local` with the new address and network.
The contract is 48,781 bytes against Bradbury's ~49,152-byte ceiling, and
`deploy.mjs` refuses to submit anything larger rather than letting the consensus
contract revert without explanation.

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
test/e2e.mjs                   lifecycle tests against a live network
test/deploy.mjs                deploy + sanity read + env write
frontend/                      Next.js app
```
