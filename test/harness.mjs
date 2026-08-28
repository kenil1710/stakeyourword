/**
 * Shared helpers for the StakeYourWord integration scripts.
 *
 * The important one is `outcomeOf`. Studionet and Bradbury report a revert in
 * DIFFERENT PLACES, and reading the wrong one turns every failed transaction
 * into a silent pass:
 *
 *   - Bradbury sets `tx.txExecutionResultName` to "FINISHED_WITH_ERROR".
 *   - Studionet leaves `txExecutionResultName` UNDEFINED and records the real
 *     outcome at `tx.consensus_data.leader_receipt[0].execution_result`
 *     ("SUCCESS" | "ERROR").
 *
 * A check written against `txExecutionResultName` alone reads `undefined !==
 * "FINISHED_WITH_ERROR"` on Studionet and reports success for a transaction
 * that reverted and rolled back. That cost a false pass on the u128 storage
 * gate before this helper existed.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";
import { transactionsStatusNumberToName } from "genlayer-js/types";
import { readFileSync } from "node:fs";

export const CHAINS = { studionet, bradbury: testnetBradbury };

/** States that genuinely end a transaction — see deploy.mjs for why not DECIDED_STATES. */
export const TERMINAL_STATES = ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const argOf = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

/**
 * The single source of truth for "did this transaction actually work".
 * Returns { settled, ok, exec, status, stderr, pending, raw }.
 */
export function outcomeOf(tx) {
  const status = transactionsStatusNumberToName[tx?.status];
  const receipt = tx?.consensus_data?.leader_receipt?.[0];
  const exec = receipt?.execution_result ?? null;
  const named = tx?.txExecutionResultName ?? null;

  // Bradbury carries NO `consensus_data` whatsoever, so `receipt` is null there
  // and every field derived from it reads as absent rather than as failure. The
  // top-level `txExecutionResultName` is the only success signal that exists on
  // that network: FINISHED_WITH_RETURN vs FINISHED_WITH_ERROR.
  const returnedOk = named === "FINISHED_WITH_RETURN";
  const settled = Boolean(status && TERMINAL_STATES.includes(status));
  // Explicit ERROR on either surface is a failure. Absence of a receipt is NOT
  // treated as success. `result.status === "rollback"` is the third spelling —
  // it is what a gl.vm.UserError actually produces.
  const rolledBack = receipt?.result?.status === "rollback";
  const reverted = exec === "ERROR" || named === "FINISHED_WITH_ERROR" || rolledBack;
  const accepted = status === "ACCEPTED" || status === "FINALIZED";

  return {
    settled,
    status,
    exec,
    named,
    // A receipt that carries an explicit result must say SUCCESS; one that
    // carries none (Bradbury deploys) falls back to the transaction status.
    ok: settled && accepted && !reverted && (exec === "SUCCESS" || returnedOk || exec === null),
    /**
     * Whether the return VALUE could be read at all.
     *
     * False on Bradbury: the value lives inside `consensus_data`, which that
     * network does not populate. Callers must not treat an unreadable return as
     * a rejection — that is a property of the transport, not of the contract —
     * and should fall back to observing contract state instead. See how
     * suite.mjs decides acceptance.
     */
    returnReadable: receipt !== null && receipt !== undefined,
    reverted,
    stderr: String(receipt?.genvm_result?.stderr ?? receipt?.stderr ?? ""),
    stdout: String(receipt?.genvm_result?.stdout ?? receipt?.stdout ?? ""),
    // The UserError text. NOT in stderr — stderr and stdout both come back
    // empty for a revert, so a suite that asserts on them can only ever check
    // THAT a call reverted, never that it reverted for the right reason, and
    // every wrong-reason revert passes silently. The message is the `payload`
    // of the rollback result; `raw` is the same string base64-encoded, read as
    // a fallback in case the decoded field is ever absent.
    revertReason: revertReasonOf(receipt),
    returned: returnValueOf(receipt),
    pending: (receipt?.pending_transactions ?? []).length,
    raw: receipt ?? null,
  };
}

/**
 * What a successful call returned, decoded.
 *
 * The receipt spells the two outcomes differently: on a revert `result.payload`
 * is the reason as a bare string, on a success it is an object carrying the
 * value both as raw calldata bytes and as `readable` — a JSON-encoded form of
 * the return value. Reading `payload` without checking which shape it is gets
 * you "[object Object]".
 *
 * This matters more than it looks. StakeYourWord's payable methods no longer
 * revert when they reject input (a revert keeps the caller's stake), so a
 * rejection now arrives as a SUCCESSFUL transaction whose return value says
 * `ok: false`. A test that only looks at tx status cannot tell an accepted
 * dispute from a refunded one.
 */
export function returnValueOf(receipt) {
  const payload = receipt?.result?.payload;
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload.readable === "string") {
    try {
      return JSON.parse(payload.readable);
    } catch {
      return payload.readable;
    }
  }
  return null;
}

/** A returned JSON string parsed into an object, or null if it was not one. */
export function returnedJson(out) {
  const value = typeof out === "string" ? out : out?.returned;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The revert message a `gl.vm.UserError` produced, or "" if the call did not revert. */
export function revertReasonOf(receipt) {
  const result = receipt?.result;
  if (!result) return "";
  if (typeof result.payload === "string" && result.payload) return result.payload;
  if (typeof result.raw === "string" && result.raw) {
    try {
      // The leading byte is a status tag, not text; strip anything unprintable.
      return Buffer.from(result.raw, "base64").toString("utf8").replace(/^[\x00-\x1f]+/, "");
    } catch {
      return "";
    }
  }
  return "";
}

/** The last frame of a GenVM traceback — the line that actually failed. */
export function failureLine(stderr) {
  const lines = String(stderr).split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("/contract.py")) return lines[i].trim();
  }
  return lines[lines.length - 1]?.trim() ?? "";
}

/** Studionet-only faucet. No-op elsewhere. */
export async function fundOnStudio(chain, address, wei) {
  if (!chain.isStudio) return false;
  const res = await fetch(chain.rpcUrls.default.http[0], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sim_fundAccount",
      params: [address, Number(wei)],
    }),
  });
  const json = await res.json();
  return Boolean(json?.result);
}

/**
 * Retry a flaky RPC call.
 *
 * Studionet intermittently answers with an HTML error page instead of JSON,
 * which surfaces as `Unexpected token '<'`. That is infrastructure noise, not a
 * contract fault, and without a retry it aborts a run mid-assertion and reads
 * like a failure of whatever call happened to be in flight.
 */
export async function retry(fn, { attempts = 6, baseMs = 4000, label = "rpc" } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const message = String(e?.message ?? e);
      const transient =
        /Unexpected token '<'|not valid JSON|fetch failed|ECONNRESET|ETIMEDOUT|502|503|504/i.test(message) ||
        // Bradbury holds ONE transaction slot per recipient contract. A write
        // that arrives while the previous one is still settling is rejected at
        // the consensus contract, which surfaces as an EVM revert rather than
        // as congestion. Backing off and resubmitting is the correct response;
        // treating it as a contract fault is not.
        /to consensus contract .* was reverted/i.test(message);
      if (!transient || i === attempts) throw e;
      console.log(`  … ${label} attempt ${i} hit transient RPC noise, retrying`);
      await sleep(baseMs * i);
    }
  }
  throw last;
}

/** Every role in .accounts.json, keyed by name. */
export function accounts() {
  return JSON.parse(readFileSync(new URL("./.accounts.json", import.meta.url), "utf8"));
}

/** Builds the read/wallet client pair plus a settle-aware `send`. */
export function connect({ networkName = argOf("network", "studionet"), address, role = "client" } = {}) {
  const chain = CHAINS[networkName];
  if (!chain) throw new Error(`unknown network ${networkName}`);
  const acc = accounts();
  if (!acc[role]?.key) throw new Error(`no key for role ${role} — run: node accounts.mjs`);
  const account = createAccount(acc[role].key);
  const wallet = createClient({ chain, account });
  const read = createClient({ chain });
  // 20 minutes was long enough that a single unreadable transaction cost more
  // wall clock than the entire rest of the suite. Nudging covers the first 450s
  // (10 x 45s) and the slowest real Bradbury settle observed is a 223s deploy,
  // so 10 minutes is still several times the worst honest case.
  const deadline = chain.isStudio ? 240_000 : 600_000;
  const pollMs = chain.isStudio ? 1_000 : 5_000;

  /**
   * Submit a write and wait for it to reach a terminal state.
   *
   * NEVER THROWS. Every caller already branches on `out.ok`, so a give-up is
   * returned as an unsettled outcome and costs one red check. Letting it escape
   * as an exception instead took down a whole Bradbury run at TEST 5 with seven
   * tests still unreported — one dropped transaction should not be able to do
   * that to six tests it never touched.
   */
  async function send(functionName, args = [], value = 0n) {
    const started = Date.now();
    const giveUp = (reason, hash = null) => ({
      ...outcomeOf(null),
      status: "UNSETTLED",
      hash,
      tx: null,
      seconds: (Date.now() - started) / 1000,
      failure: reason,
      revertReason: reason,
    });

    let hash;
    try {
      hash = await retry(
        () => wallet.writeContract({ address, functionName, args, value }),
        { label: functionName },
      );
    } catch (e) {
      return giveUp(`submit failed — ${String(e?.message ?? e)}`);
    }

    let nudges = 0;
    let blindSince = null;
    for (;;) {
      /*
       * A failing RPC and a genuinely absent transaction both used to arrive
       * here as `null`, via `.catch(() => null)`. That made a burst of `fetch
       * failed` indistinguishable from the endpoint answering "no such
       * transaction", so the loop went blind and then sat out its entire
       * deadline in silence — 28 swallowed errors, 20 minutes, no output.
       *
       * `retry` now gives the endpoint several chances with backoff, and a poll
       * it still cannot answer is recorded as BLIND rather than read as an
       * outcome. Only a poll the RPC actually answered may settle the call:
       * absence of evidence is not evidence of absence.
       */
      let answered = true;
      let tx = null;
      try {
        tx = await retry(() => read.getTransaction({ hash }), {
          attempts: 4,
          baseMs: 2_000,
          label: `${functionName} poll`,
        });
      } catch {
        answered = false;
      }

      if (answered) {
        blindSince = null;
        const out = outcomeOf(tx);
        if (out.settled) return { ...out, hash, tx, seconds: (Date.now() - started) / 1000 };
      } else if (blindSince === null) {
        blindSince = Date.now();
      }

      if (!chain.isStudio && Date.now() - started > (nudges + 1) * 45_000 && nudges < 10) {
        nudges++;
        await wallet.finalizeIdlenessTxs({ txIds: [hash] }).catch(() => {});
      }
      if (Date.now() - started > deadline) {
        const secs = (deadline / 1000).toFixed(0);
        // Say WHICH of the two it was. "never settled" alone cannot distinguish
        // a stuck transaction from an endpoint that stopped answering, and the
        // two call for opposite responses.
        return giveUp(
          blindSince
            ? `never settled in ${secs}s — RPC unreadable for the last ${((Date.now() - blindSince) / 1000).toFixed(0)}s, tx may still be in flight`
            : `never settled in ${secs}s — tx stayed non-terminal`,
          hash,
        );
      }
      await sleep(pollMs);
    }
  }

  const view = async (functionName, args = []) =>
    retry(() => read.readContract({ address, functionName, args }), { label: functionName });
  const viewJson = async (functionName, args = []) => JSON.parse(await view(functionName, args));

  return { chain, account, wallet, read, send, view, viewJson };
}
