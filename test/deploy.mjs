/**
 * Deploys a StakeYourWord contract and optionally rewrites frontend/.env.local.
 *
 * Uses the SDK rather than `genlayer deploy` because the CLI has no nudge
 * logic: Bradbury deploys park in COMMITTING and the CLI just times out, even
 * though the deploy is fine and only needs `finalizeIdlenessTxs` to proceed.
 *
 * Usage:
 *   node deploy.mjs [--network=studionet|bradbury] [--contract=<path>]
 *                   [--sanity=<viewMethod>] [--gas=<floor>] [--write-env]
 *                   [--keystore=<name>] [--args=<json array>]
 *
 * Defaults to studionet, which settles in seconds where Bradbury takes minutes.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolveSigner } from "./keystore.mjs";

/**
 * States that genuinely end a transaction.
 *
 * Deliberately NOT the SDK's `DECIDED_STATES`, which also lists
 * `LEADER_TIMEOUT` and `VALIDATORS_TIMEOUT`. Those are not terminal — Bradbury
 * rotates to the next leader and carries on with `rotationsLeft` remaining. A
 * loop that stops there abandons a transaction that is still alive and reports
 * a failure that never happened, precisely when it most needs nudging.
 */
const TERMINAL_STATES = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"];
const CHAINS = { studionet, bradbury: testnetBradbury };

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const networkName = arg("network", "studionet");
const chain = CHAINS[networkName];
if (!chain) {
  throw new Error(
    `unknown --network=${networkName}; expected one of ${Object.keys(CHAINS).join(", ")}`,
  );
}

const codePath = new URL(
  arg("contract", "../contracts/stake_your_word.py"),
  import.meta.url,
);
const sanityMethod = arg("sanity", "get_stats");
const constructorArgs = JSON.parse(arg("args", "[]"));
const WRITE_ENV = process.argv.includes("--write-env");
const envPath = new URL("../frontend/.env.local", import.meta.url);

const signer = resolveSigner(process.argv, new URL("./.accounts.json", import.meta.url));
console.log(`signing with ${signer.label}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Force an explicit gas floor by intercepting `eth_estimateGas`.
 *
 * genlayer-js estimates gas inside `_sendTransaction` and, when the estimate
 * throws, falls back to a hardcoded `200_000n`. Neither number is configurable,
 * and that fallback cannot deploy a contract this size: the calldata is the
 * Python source and Ethereum charges 16 gas per non-zero byte before execution
 * begins. Bradbury's estimator reverts on a large payload, the fallback
 * engages, and the node rejects with "intrinsic gas too low" — which reads like
 * a contract fault but is really a default chosen for small payloads.
 *
 * Assigning `wallet.estimateTransactionGas` does nothing: `_sendTransaction`
 * closes over the pre-extension client built inside `createClient`, a different
 * object from the one returned. So the interception happens one layer down, at
 * the JSON-RPC endpoint — the only genuinely shared seam.
 *
 * `--gas=` is a FLOOR, not a fixed limit: too low and the shim raises it to the
 * real upstream estimate so the deploy cannot silently run out of gas.
 */
const gasArg = arg("gas");
let gasProxy = null;
let endpoint = chain.rpcUrls.default.http[0];

if (gasArg) {
  const forced = BigInt(gasArg);
  const upstream = chain.rpcUrls.default.http[0];

  gasProxy = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end('{"error":"bad json"}');
        return;
      }

      if (parsed?.method === "eth_estimateGas") {
        let sized = forced;
        try {
          const upstreamRes = await fetch(upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const j = await upstreamRes.json();
          if (j?.result) {
            const withMargin = (BigInt(j.result) * 13n) / 10n;
            if (withMargin > sized) sized = withMargin;
          }
        } catch {
          // Upstream estimate unavailable — fall back to the caller's floor.
        }
        const CAP = 95_000_000n; // just under Bradbury's ~100M block gas limit
        if (sized > CAP) sized = CAP;
        if (sized !== forced) {
          console.log(
            `  gas auto-sized to ${sized.toLocaleString()} (floor ${forced.toLocaleString()} was below the real estimate)`,
          );
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: `0x${sized.toString(16)}` }));
        return;
      }

      try {
        const upstreamRes = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { "content-type": "application/json" });
        res.end(text);
      } catch (error) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed?.id ?? null,
            error: { code: -32603, message: String(error?.message ?? error) },
          }),
        );
      }
    });
  });

  await new Promise((resolve) => gasProxy.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${gasProxy.address().port}`;
  console.log(`gas floor ${forced.toLocaleString()} via local RPC shim ${endpoint}`);
}

const read = createClient({ chain, endpoint });
const wallet = createClient({ chain, account: createAccount(signer.key), endpoint });

/**
 * Studio settles on its own; the idleness nudge is a Bradbury-only workaround
 * and there is no idle queue on Studio to nudge. Poll faster and give up sooner
 * there, so a genuine failure surfaces in seconds instead of 20 minutes.
 */
const NUDGE = !chain.isStudio;
const POLL_MS = chain.isStudio ? 1_000 : 5_000;
const DEADLINE_MS = chain.isStudio ? 180_000 : 1_200_000;

console.log(`network: ${chain.name} (id ${chain.id}) via ${chain.rpcUrls.default.http[0]}`);

const code = readFileSync(codePath, "utf8");
console.log(`deploying ${codePath.pathname.split("/").pop()} — ${code.length} bytes`);

// Bradbury rejects oversized code at the consensus contract and the revert
// gives no hint that size is the cause. Fail loudly and early instead.
if (networkName === "bradbury" && code.length > 49_152) {
  throw new Error(`refusing to deploy ${code.length} bytes to Bradbury — over the ~48KB ceiling`);
}

let hash;
for (let attempt = 1; ; attempt++) {
  try {
    hash = await wallet.deployContract({ code, args: constructorArgs });
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    console.log(`  submit attempt ${attempt} rejected, retrying: ${e.message.slice(0, 120)}`);
    await sleep(15_000 * attempt);
  }
}
console.log(`deploy tx ${hash}`);

const started = Date.now();
let lastNudge = Date.now();
let nudges = 0;
let tx;
for (;;) {
  tx = await read.getTransaction({ hash }).catch(() => null);
  const status = transactionsStatusNumberToName[tx?.status];
  if (status && TERMINAL_STATES.includes(status)) {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  ${status} / ${tx?.txExecutionResultName} after ${secs}s, ${nudges} nudge(s)`);
    if (status !== "ACCEPTED" && status !== "FINALIZED") throw new Error(`deploy settled as ${status}`);
    if (tx?.txExecutionResultName === "FINISHED_WITH_ERROR") throw new Error("deploy reverted");
    break;
  }
  if (NUDGE && Date.now() - lastNudge >= 45_000 && nudges < 10) {
    nudges++;
    lastNudge = Date.now();
    console.log(`  nudge ${nudges} (status ${status})`);
    await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
  }
  if (Date.now() - started > DEADLINE_MS) throw new Error("deploy never settled");
  await sleep(POLL_MS);
}

/**
 * `txDataDecoded.contractAddress` first, and deliberately so: `to_address` is
 * `undefined` on Bradbury, and `recipient` only *happens* to coincide on
 * Studionet. Reading either one first works until it silently does not.
 */
const address = tx?.txDataDecoded?.contractAddress ?? tx?.to_address ?? tx?.recipient;
if (!address) {
  throw new Error(`could not read deployed address from tx: ${JSON.stringify(Object.keys(tx ?? {}))}`);
}
console.log(`\ncontract address: ${address}`);

/*
 * A deploy can report ACCEPTED and still have left no contract behind; every
 * later call then fails with `invalid_contract`, which reads exactly like a
 * network fault. This read is what distinguishes the two.
 *
 * It has to tolerate indexing lag to do that, though. Acceptance and
 * queryability are not the same instant on Bradbury -- a contract that settled
 * in 15s answered `contract not found` on the very next call and was live 20s
 * later. Firing once turned a perfectly good deploy into a hard failure that
 * exited before writing .deployed.json, losing the address of a contract that
 * existed. Give it a bounded window; only a contract that never becomes
 * readable is actually missing.
 */
let sanity;
for (let attempt = 1; ; attempt++) {
  try {
    sanity = await read.readContract({ address, functionName: sanityMethod, args: [] });
    break;
  } catch (e) {
    const missing = /not found|invalid_contract/i.test(String(e?.message ?? e));
    if (!missing || attempt >= 12) throw e;
    if (attempt === 1) console.log(`  not queryable yet — waiting for the deploy to index`);
    await sleep(5000);
  }
}
console.log(`${sanityMethod}() -> ${String(sanity).slice(0, 200)}`);

writeFileSync(
  new URL("./.deployed.json", import.meta.url),
  JSON.stringify({ network: networkName, address, contract: codePath.pathname, at: new Date().toISOString() }, null, 2) + "\n",
);
console.log("wrote test/.deployed.json");

if (WRITE_ENV) {
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `NEXT_PUBLIC_CONTRACT_ADDRESS=${address}\nNEXT_PUBLIC_NETWORK=${networkName}\n`);
    console.log(`created frontend/.env.local with ${address}`);
  } else {
    const env = readFileSync(envPath, "utf8");
    // No str.replace on a plain string here would be a false economy — this is
    // JS, not the contract — but the regex form is used so a missing key is an
    // error rather than a silent no-op.
    const updated = env.replace(/^NEXT_PUBLIC_CONTRACT_ADDRESS\s*=.*$/m, `NEXT_PUBLIC_CONTRACT_ADDRESS=${address}`);
    if (updated === env) throw new Error("NEXT_PUBLIC_CONTRACT_ADDRESS not found in .env.local");
    writeFileSync(envPath, updated);
    console.log(`wrote ${address} to frontend/.env.local`);
  }
}

// The shim holds the event loop open; without this the script never exits.
gasProxy?.close();
