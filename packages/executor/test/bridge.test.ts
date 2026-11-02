import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { oftAbi } from "../src/evm/abis.js";
import { evmRecipient, pangeaBridgeQuote, planOftSend, truncateForBridge } from "../src/evm/oftBridge.js";
import { lowBalances, planTokenRebalance } from "../src/rebalancer.js";

const TOKEN = "0x30de7AE4c9578D110a97367EDe9F7765Cdce06ea" as const;
const ME = "0x000000000000000000000000000000000000bEEF" as const;

describe("OFT bridge", () => {
  it("truncates to 6 decimals and left-pads EVM recipients", () => {
    expect(truncateForBridge(1_000_000_000_000_123n)).toBe(1_000_000_000_000_000n);
    expect(evmRecipient(ME).toLowerCase()).toBe(`0x${"0".repeat(60)}beef`);
  });

  it("plans send() with the quoted minimum and LayerZero fee as value", async () => {
    const calls: string[] = [];
    const client = {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args: [{ amountLD: bigint; minAmountLD: bigint }];
      }) => {
        calls.push(functionName);
        if (functionName === "quoteOFT")
          return [
            {},
            [],
            { amountSentLD: args[0].amountLD, amountReceivedLD: (args[0].amountLD * 998n) / 1000n },
          ];
        expect(args[0].minAmountLD).toBe(998_000_000_000_000n);
        return { nativeFee: 108141208664032n, lzTokenFee: 0n };
      },
    };
    const p = await planOftSend(client as never, {
      token: TOKEN,
      dstEid: 30184,
      to: evmRecipient(ME),
      amount: 1_000_000_000_000_123n,
      refundTo: ME,
    });
    expect(calls).toEqual(["quoteOFT", "quoteSend"]);
    expect(p.amountSent).toBe(1_000_000_000_000_000n);
    expect(p.amountReceived).toBe(998_000_000_000_000n);
    expect(p.tx).toMatchObject({ to: TOKEN, value: 108141208664032n });
    const d = decodeFunctionData({ abi: oftAbi, data: p.tx.data });
    expect(d.functionName).toBe("send");
    const [sp, fee, refund] = d.args as unknown as [
      { dstEid: number; extraOptions: string },
      { nativeFee: bigint },
      string,
    ];
    expect(sp.dstEid).toBe(30184);
    expect(sp.extraOptions).toBe("0x");
    expect(fee.nativeFee).toBe(108141208664032n);
    expect(refund).toBe(ME);
    await expect(
      planOftSend(client as never, {
        token: TOKEN,
        dstEid: 30184,
        to: evmRecipient(ME),
        amount: 999n,
        refundTo: ME,
      }),
    ).rejects.toThrow(/too small/);
    await expect(
      planOftSend(client as never, {
        token: TOKEN,
        dstEid: 30184,
        to: evmRecipient(ME),
        amount: 10n ** 15n,
        refundTo: ME,
        maxNativeFee: 1n,
      }),
    ).rejects.toThrow(/above cap/);
  });

  it("accepts Pangea's bridge quote only if it targets the token on the right chain", async () => {
    const reply = (call: object) =>
      (async () =>
        new Response(
          JSON.stringify({ routes: [{ id: "canonical", amountOut: "998", nativeFee: "5", call }] }),
          { status: 200 },
        )) as unknown as typeof fetch;
    const o = {
      slug: "pangea-dadd0d",
      from: "robinhood",
      to: "base",
      amount: 1000n,
      user: ME,
      token: TOKEN,
      chainId: 4663,
    };
    const ok = await pangeaBridgeQuote(
      "https://x",
      o,
      reply({ to: TOKEN, data: "0x1234", value: "5", chainId: 4663 }),
    );
    expect(ok.tx).toEqual({ to: TOKEN, data: "0x1234", value: 5n });
    await expect(
      pangeaBridgeQuote("https://x", o, reply({ to: ME, data: "0x", value: "5", chainId: 4663 })),
    ).rejects.toThrow(/unexpected contract/);
    await expect(
      pangeaBridgeQuote("https://x", o, reply({ to: TOKEN, data: "0x", value: "5", chainId: 1 })),
    ).rejects.toThrow(/another chain/);
  });
});

describe("token rebalance planner", () => {
  const target = 1_000_000n * 10n ** 9n; // 1M tokens
  const base = { slug: "zgap", target, below: 0.3, tokenUsd: 0.00004, lzFeeUsd: () => 0.26 };

  it("moves from the richest chain to a depleted one, truncated to bridge precision", () => {
    const m = planTokenRebalance({
      ...base,
      balances: { base: 2_500_000n * 10n ** 9n + 7n, bsc: 100_000n * 10n ** 9n, robinhood: target },
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ from: "base", to: "bsc" });
    expect(m[0]!.amount).toBe(900_000n * 10n ** 9n);
    expect(m[0]!.amount % 1000n).toBe(0n);
  });

  it("does nothing when balances are healthy or when the fee is too large for the value", () => {
    expect(planTokenRebalance({ ...base, balances: { base: target, bsc: target / 2n } })).toHaveLength(0);
    const expensive = planTokenRebalance({
      ...base,
      lzFeeUsd: () => 1.8,
      balances: { base: 2n * target, bsc: 0n },
    });
    expect(expensive).toHaveLength(0); // $1.8 fee on a $40 move > 2%
  });

  it("flags low balances", () => {
    const low = lowBalances(
      [
        { chain: "base", asset: "ETH", usd: 1.5, kind: "gas" },
        { chain: "bsc", asset: "BNB", usd: 50, kind: "quote" },
        { chain: "robinhood", asset: "zgap", usd: 3, kind: "token" },
      ],
      { gas: 2, quote: 20, token: 10 },
    );
    expect(low.map((l) => `${l.chain}:${l.asset}`)).toEqual(["base:ETH", "robinhood:zgap"]);
  });
});
