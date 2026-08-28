"use client";

/**
 * Wallet connection state, shared by the header and every page that writes.
 *
 * Deliberately does NOT auto-prompt. `eth_accounts` reports an already-granted
 * connection without opening the wallet, so a returning visitor is recognised
 * silently; `eth_requestAccounts` only ever runs from a click.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CHAIN_ID_HEX,
  NETWORK_LABEL,
  ensureCorrectNetwork,
  hasInjectedWallet,
  requestAccount,
} from "@/lib/genlayer";

interface WalletState {
  account: `0x${string}` | null;
  chainId: string | null;
  /** Whether an injected wallet exists at all. Null until mounted. */
  available: boolean | null;
  connecting: boolean;
  error: string | null;
  onCorrectNetwork: boolean;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * Whether an injected wallet exists — external state, so it is read through
 * `useSyncExternalStore` rather than copied into React by an effect.
 *
 * `getServerSnapshot` returns null, which is also what hydration uses, so the
 * server and the first client render agree even on a machine that has
 * MetaMask. The real answer arrives on the render after hydration.
 *
 * The subscription is not decorative: an extension that finishes injecting
 * after the page has parsed announces itself with `ethereum#initialized`, and
 * without listening for it a wallet that loaded a beat late would show as
 * absent until the next navigation.
 */
function subscribeWallet(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("ethereum#initialized", onChange);
  return () => window.removeEventListener("ethereum#initialized", onChange);
}

const walletPresent = () => hasInjectedWallet();
const walletUnknown = () => null;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Null until after hydration. See subscribeWallet above.
  const available = useSyncExternalStore<boolean | null>(
    subscribeWallet,
    walletPresent,
    walletUnknown,
  );

  useEffect(() => {
    if (!available) return;

    const provider = window.ethereum;
    if (!provider) return;
    let live = true;

    // Silent: reports an existing grant without opening the wallet.
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (live && Array.isArray(accounts) && accounts.length) {
          setAccount(accounts[0] as `0x${string}`);
        }
      })
      .catch(() => {});

    provider
      .request({ method: "eth_chainId" })
      .then((id) => {
        if (live && typeof id === "string") setChainId(id.toLowerCase());
      })
      .catch(() => {});

    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      setAccount(accounts?.length ? (accounts[0] as `0x${string}`) : null);
    };
    const onChain = (...args: unknown[]) => {
      const id = args[0];
      setChainId(typeof id === "string" ? id.toLowerCase() : null);
    };

    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      live = false;
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [available]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      await ensureCorrectNetwork();
      setAccount(await requestAccount());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    setError(null);
    try {
      await ensureCorrectNetwork();
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);

  // Local only. No injected wallet exposes a real disconnect, so this clears
  // the app's view of the session and nothing more — the grant survives in the
  // wallet, which is why reconnecting does not re-prompt.
  const disconnect = useCallback(() => setAccount(null), []);

  const value = useMemo<WalletState>(
    () => ({
      account,
      chainId,
      available,
      connecting,
      error,
      onCorrectNetwork: chainId === null ? true : chainId === CHAIN_ID_HEX.toLowerCase(),
      connect,
      switchNetwork,
      disconnect,
    }),
    [account, chainId, available, connecting, error, connect, switchNetwork, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside <WalletProvider>");
  return value;
}

export { NETWORK_LABEL };

/**
 * A wallet rejection is not an error worth a red box.
 *
 * EIP-1193 code 4001 is the user closing the dialog, and MetaMask spells the
 * same thing several ways in `message`. Surfacing it as a failure makes
 * declining a signature look like a bug in the app.
 */
export function messageOf(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return "";
  const raw = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(raw)) return "";
  return raw;
}
