// Bot hot wallets, one per chain, from .env only (BOT_PK_BASE, BOT_PK_BSC, ...). Separate from treasury. // safety-check: allow
// Keys never leave this module: callers get a viem Account and the public address.
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"; // safety-check: allow
import type { ChainName } from "@true/core";

export interface BotWallet {
  chain: ChainName;
  address: `0x${string}`;
  /** undefined in dry run when only BOT_ADDRESS_<CHAIN> is set (simulation without signing). */
  account?: PrivateKeyAccount;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function loadEvmWallet(chain: ChainName, env: NodeJS.ProcessEnv = process.env): BotWallet | null {
  const pk = env[`BOT_PK_${chain.toUpperCase()}`]; // safety-check: allow
  if (pk) {
    if (!KEY_RE.test(pk)) throw new Error(`BOT_PK_${chain.toUpperCase()} is malformed`); // never echo the value. safety-check: allow
    const account = privateKeyToAccount(pk as `0x${string}`); // safety-check: allow
    return { chain, address: account.address, account };
  }
  const addr = env[`BOT_ADDRESS_${chain.toUpperCase()}`];
  if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) return { chain, address: addr as `0x${string}` };
  return null;
}
