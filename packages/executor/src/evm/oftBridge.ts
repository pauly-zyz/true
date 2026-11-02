// Token bridging through the token's own LayerZero OFT (Pangea docs, "Bridging from code"):
// quoteOFT -> what arrives (0.2% fee, 6-decimal truncation), quoteSend -> LayerZero fee (paid as value),
// send(). extraOptions stays empty: the token enforces its own gas floor.
import { decodeEventLog, encodeFunctionData, pad, type Log, type PublicClient } from "viem";
import { oftAbi } from "./abis.js";
import type { TxPlan } from "./v4Swap.js";

export interface OftSendPlan {
  tx: TxPlan;
  amountSent: bigint;
  amountReceived: bigint;
  nativeFee: bigint;
}

/** OFT shared decimals: amounts cross at 6 of the token's 9 decimals. */
export function truncateForBridge(amount: bigint, decimals = 9, sharedDecimals = 6): bigint {
  const unit = 10n ** BigInt(decimals - sharedDecimals);
  return (amount / unit) * unit;
}

export function evmRecipient(address: `0x${string}`): `0x${string}` {
  return pad(address, { size: 32 }); // left-padded, as the docs require (never right-padded)
}

export async function planOftSend(
  client: PublicClient,
  o: {
    token: `0x${string}`;
    dstEid: number;
    to: `0x${string}`;
    amount: bigint;
    refundTo: `0x${string}`;
    maxNativeFee?: bigint;
  },
): Promise<OftSendPlan> {
  const amountLD = truncateForBridge(o.amount);
  if (amountLD === 0n) throw new Error("amount too small to bridge");
  const sendParam = {
    dstEid: o.dstEid,
    to: o.to,
    amountLD,
    minAmountLD: 0n,
    extraOptions: "0x" as const,
    composeMsg: "0x" as const,
    oftCmd: "0x" as const,
  };
  const [, , receipt] = await client.readContract({
    address: o.token,
    abi: oftAbi,
    functionName: "quoteOFT",
    args: [sendParam],
  });
  sendParam.minAmountLD = receipt.amountReceivedLD; // the fee is fixed, so the quote is exact
  const fee = await client.readContract({
    address: o.token,
    abi: oftAbi,
    functionName: "quoteSend",
    args: [sendParam, false],
  });
  if (o.maxNativeFee !== undefined && fee.nativeFee > o.maxNativeFee)
    throw new Error(`LayerZero fee ${fee.nativeFee} above cap ${o.maxNativeFee}`);
  const data = encodeFunctionData({
    abi: oftAbi,
    functionName: "send",
    args: [sendParam, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, o.refundTo],
  });
  return {
    tx: { to: o.token, data, value: fee.nativeFee },
    amountSent: receipt.amountSentLD,
    amountReceived: receipt.amountReceivedLD,
    nativeFee: fee.nativeFee,
  };
}

export function parseOftSent(
  logs: readonly Log[],
  token: `0x${string}`,
): { guid: `0x${string}`; amountSent: bigint; amountReceived: bigint } | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: oftAbi, data: l.data, topics: l.topics });
      if (d.eventName === "OFTSent")
        return {
          guid: d.args.guid,
          amountSent: d.args.amountSentLD,
          amountReceived: d.args.amountReceivedLD,
        };
    } catch {
      /* not OFTSent */
    }
  }
  return null;
}

/**
 * Fallback: Pangea's POST /api/bridge/quote. The returned call is only accepted if it targets the token
 * itself on the expected chain (the canonical OFT send), never an arbitrary contract.
 */
export async function pangeaBridgeQuote(
  apiBase: string,
  o: {
    slug: string;
    from: string;
    to: string;
    amount: bigint;
    user: `0x${string}`;
    token: `0x${string}`;
    chainId: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ tx: TxPlan; amountReceived: bigint; nativeFee: bigint }> {
  const res = await fetchImpl(`${apiBase}/api/bridge/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: o.slug, from: o.from, to: o.to, amount: o.amount.toString(), user: o.user }),
  });
  const body = (await res.json()) as {
    error?: string;
    routes?: Array<{
      id: string;
      unavailable?: string;
      amountOut?: string;
      nativeFee?: string;
      call?: { to: string; data: string; value: string; chainId: number } | null;
    }>;
  };
  if (!res.ok) throw new Error(`bridge quote ${res.status}: ${body.error ?? "unknown"}`);
  const r = body.routes?.find((x) => x.id === "canonical");
  if (!r || r.unavailable || !r.call)
    throw new Error(`canonical route unavailable: ${r?.unavailable ?? "no call"}`);
  if (r.call.to.toLowerCase() !== o.token.toLowerCase())
    throw new Error("bridge quote targets an unexpected contract");
  if (r.call.chainId !== o.chainId) throw new Error("bridge quote is for another chain");
  return {
    tx: { to: o.token, data: r.call.data as `0x${string}`, value: BigInt(r.call.value) },
    amountReceived: BigInt(r.amountOut ?? "0"),
    nativeFee: BigInt(r.nativeFee ?? r.call.value),
  };
}
