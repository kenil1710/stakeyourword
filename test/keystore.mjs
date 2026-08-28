/**
 * Unlock a GenLayer CLI wallet (Web3 Secret Storage v3 keystore) for signing.
 *
 * Extracted from deploy.mjs so scan scripts can sign from the same real wallet
 * without duplicating the crypto — the alternative was funding a second account
 * on Bradbury just to run a scan.
 *
 * The password comes from the GENLAYER_KEYSTORE_PASSWORD environment variable
 * and is NEVER accepted as an argv flag: argv is visible to every process on the
 * machine via `ps`, and it lands in shell history. Prefix the command with a
 * space, or export the variable, so it stays out of history too.
 */
import { createDecipheriv, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";

/**
 * Decrypts a Web3 Secret Storage v3 keystore.
 *
 * Standard three steps: derive with scrypt, verify the MAC, then AES-CTR the
 * ciphertext. The MAC check is not optional — without it a wrong password
 * yields plausible-looking garbage that would be used as a private key, and any
 * transaction would go out from an address nobody controls.
 *
 * Node's scrypt defaults to a 32 MB memory cap, well under the 128·N·r that
 * these parameters need (N=131072, r=8 → ~134 MB), so `maxmem` is raised or the
 * call throws before it starts.
 */
export function unlockKeystore(name, password) {
  const path = join(homedir(), ".genlayer", "keystores", `${name}.json`);
  const store = JSON.parse(readFileSync(path, "utf8"));
  const crypto = store.Crypto ?? store.crypto;
  if (!crypto) throw new Error(`${path} is not a v3 keystore`);
  if (crypto.kdf !== "scrypt") throw new Error(`unsupported kdf: ${crypto.kdf}`);

  const { salt, n, r, p, dklen } = crypto.kdfparams;
  const derived = scryptSync(Buffer.from(password), Buffer.from(salt, "hex"), dklen, {
    N: n,
    r,
    p,
    maxmem: 256 * n * r,
  });

  const ciphertext = Buffer.from(crypto.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  if (mac !== crypto.mac.toLowerCase()) {
    throw new Error("keystore MAC mismatch — wrong GENLAYER_KEYSTORE_PASSWORD");
  }

  const decipher = createDecipheriv(
    crypto.cipher,
    derived.subarray(0, 16),
    Buffer.from(crypto.cipherparams.iv, "hex"),
  );
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { key: `0x${key.toString("hex")}`, address: `0x${store.address}` };
}

/**
 * Resolve a signing key from CLI args: `--keystore=<name>` unlocks a real wallet
 * (password from GENLAYER_KEYSTORE_PASSWORD), otherwise fall back to the
 * plaintext `client` test account in .accounts.json — fine for throwaway
 * Studionet work, but it holds no gas on Bradbury.
 */
export function resolveSigner(argv, accountsUrl) {
  const keystoreArg = argv.find((a) => a.startsWith("--keystore="));
  const keystoreName = keystoreArg ? keystoreArg.split("=")[1] : null;
  if (keystoreName) {
    const password = process.env.GENLAYER_KEYSTORE_PASSWORD;
    if (!password) {
      throw new Error(`--keystore=${keystoreName} needs GENLAYER_KEYSTORE_PASSWORD in the environment`);
    }
    const unlocked = unlockKeystore(keystoreName, password);
    return { key: unlocked.key, label: `keystore ${keystoreName} (${unlocked.address})` };
  }
  const acc = JSON.parse(readFileSync(accountsUrl, "utf8"));
  return { key: acc.client.key, label: `test account client (${acc.client.address})` };
}
