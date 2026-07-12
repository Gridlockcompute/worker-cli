import { getAddress, isAddress } from "viem";

export function parseWorkerWallet(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Wallet address is required.");
  }
  if (!isAddress(trimmed)) {
    throw new Error(
      "Invalid EVM wallet address. Use your EVM wallet 0x address (same as on https://grid-lock.tech/worker).",
    );
  }
  return getAddress(trimmed);
}

export function shortWallet(addr: string): string {
  return addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
