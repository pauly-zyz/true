// Golden tests on two real Robinhood Chain PANGEA receipts (see also packages/core/test/hookfee.test.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatTransactionReceipt, type RpcTransactionReceipt } from "viem";
import { explorerUrl, parseSwapReceipt } from "../src/evm/receipts.js";

const load = (f: string) =>
  formatTransactionReceipt(
    (
      JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as {
        result: RpcTransactionReceipt;
      }
    ).result,
  );
const o = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const,
  poolId: "0xcfe04bc182706f8683f4f486104b52fb6a4115cfe9e4471c468fca65703f9b9d" as const, // poolId
  hook: "0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc" as const,
};

describe("parseSwapReceipt", () => {
  it("buy 0x5f911c4b: paid 0.004225189901291545 ETH, got 6690.958706615 PANGEA, hook kept 1%", () => {
    const r = parseSwapReceipt(load("receipt-0x5f911c4b.json"), { ...o, side: "buy" });
    expect(r.success).toBe(true);
    expect(r.amountIn).toBe(4225189901291545n);
    expect(r.amountOut).toBe(6690958706615n);
    expect(r.hookFee).toBe(42251899012915n);
    expect(r.gasUsed).toBe(0x481f7n);
    expect(r.gasCostNative).toBe(0x481f7n * 0x13a25e0n);
  });

  it("sell 0x3f260878: sold 13933.9801857 PANGEA, received 0.008622688569412733 ETH", () => {
    const r = parseSwapReceipt(load("receipt-0x3f260878.json"), { ...o, side: "sell" });
    expect(r.amountIn).toBe(13933980185700n);
    expect(r.amountOut).toBe(8622688569412733n);
    expect(r.hookFee).toBe(87097864337502n);
  });

  it("rejects a receipt read with the wrong side or pool", () => {
    expect(() => parseSwapReceipt(load("receipt-0x5f911c4b.json"), { ...o, side: "sell" })).toThrow(/sell/);
    expect(() =>
      parseSwapReceipt(load("receipt-0x5f911c4b.json"), {
        ...o,
        side: "buy",
        poolId: `0x${"00".repeat(32)}` as `0x${string}`,
      }),
    ).toThrow(/no Swap/);
  });

  it("explorer links", () => {
    expect(explorerUrl("https://basescan.org/tx/", "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(explorerUrl(null, "0xabc")).toBeNull();
  });
});
