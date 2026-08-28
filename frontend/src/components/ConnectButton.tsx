"use client";

import { LoaderCircle, TriangleAlert, Wallet } from "lucide-react";
import { NETWORK_LABEL, useWallet } from "./WalletProvider";
import { shortAddress } from "@/lib/format";

export function ConnectButton() {
  const { account, available, connecting, onCorrectNetwork, connect, switchNetwork } = useWallet();

  // `available` is null until the effect runs. Rendering nothing keeps the
  // server and the first client render identical.
  if (available === null) return <div className="h-[38px] w-[112px]" aria-hidden />;

  if (!available) {
    return (
      <a
        className="btn text-[13px]"
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer noopener"
      >
        <Wallet size={15} aria-hidden />
        Get a wallet
      </a>
    );
  }

  if (account && !onCorrectNetwork) {
    return (
      <button type="button" className="btn btn-bounty text-[13px]" onClick={switchNetwork}>
        <TriangleAlert size={15} aria-hidden />
        Switch to {NETWORK_LABEL}
      </button>
    );
  }

  if (account) {
    return (
      // `normal-case` overrides the pill's uppercase: an address's case is EIP-55
      // checksum data, and "0X…" is not a spelling of anything.
      <span className="pill pill-neutral h-[38px] px-3 normal-case" title={account}>
        <span className="size-1.5 rounded-full bg-kept" aria-hidden />
        {shortAddress(account)}
      </span>
    );
  }

  return (
    <button type="button" className="btn btn-primary text-[13px]" onClick={connect} disabled={connecting}>
      {connecting ? (
        <LoaderCircle size={15} className="animate-spin" aria-hidden />
      ) : (
        <Wallet size={15} aria-hidden />
      )}
      {connecting ? "Connecting" : "Connect"}
    </button>
  );
}
