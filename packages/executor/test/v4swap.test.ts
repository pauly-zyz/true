// Calldata built by buildV4SwapTx, decoded back with the official Universal Router CommandParser.
import { describe, expect, it } from "vitest";
import { CommandParser, CommandType, UniversalRouterVersion } from "@uniswap/universal-router-sdk";
import { buildV4SwapTx, minOut, pangeaPoolKey } from "../src/evm/v4Swap.js";
import { diffBps, withinTolerance } from "../src/evm/simulate.js";

const TOKEN = "0x30de7AE4c9578D110a97367EDe9F7765Cdce06ea" as const; // PANGEA on Robinhood
const HOOK = "0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc" as const;
const ROUTER = "0x204FAca1764B154221e35c0d20aBb3c525710498" as const;
const key = pangeaPoolKey(TOKEN, HOOK);

function decode(data: `0x${string}`) {
  const call = CommandParser.parseCalldata(data, UniversalRouterVersion.V2_1_2);
  expect(call.commands).toHaveLength(1);
  const cmd = call.commands[0]!;
  expect(cmd.commandType).toBe(CommandType.V4_SWAP);
  return cmd.params as unknown as Array<{ name: string; value: unknown }>;
}

describe("buildV4SwapTx", () => {
  it("buy: native in with value, SWAP_EXACT_IN_SINGLE + SETTLE_ALL(native) + TAKE_ALL(token)", () => {
    const tx = buildV4SwapTx({
      router: ROUTER,
      routerVersion: "2.1.2",
      poolKey: key,
      side: "buy",
      amountIn: 10n ** 15n,
      amountOutMinimum: 123n,
      deadline: 2_000_000_000n,
    });
    expect(tx.to).toBe(ROUTER);
    expect(tx.value).toBe(10n ** 15n);
    const params = decode(tx.data);
    const text = JSON.stringify(params, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v?.type === "BigNumber" ? BigInt(v.hex).toString() : v,
    );
    expect(text).toContain("SWAP_EXACT_IN_SINGLE");
    expect(text).toContain("SETTLE_ALL");
    expect(text).toContain("TAKE_ALL");
    expect(text.toLowerCase()).toContain(HOOK.toLowerCase());
    expect(text.toLowerCase()).toContain(TOKEN.toLowerCase());
    expect(text).toContain('"zeroForOne":true');
    expect(text).toContain("1000000000000000");
    expect(text).toContain('"123"');
  });

  it("sell: token in, no value, zeroForOne false", () => {
    const tx = buildV4SwapTx({
      router: ROUTER,
      routerVersion: "2.1.2",
      poolKey: key,
      side: "sell",
      amountIn: 5n * 10n ** 12n,
      amountOutMinimum: 1n,
      deadline: 2_000_000_000n,
    });
    expect(tx.value).toBe(0n);
    const text = JSON.stringify(decode(tx.data), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v?.type === "BigNumber" ? BigInt(v.hex).toString() : v,
    );
    expect(text).toContain('"zeroForOne":false');
    expect(text).toContain("5000000000000");
  });

  it("refuses unsafe requests", () => {
    const base = {
      router: ROUTER,
      routerVersion: "2.1.2" as const,
      poolKey: key,
      side: "buy" as const,
      deadline: 1n,
    };
    expect(() => buildV4SwapTx({ ...base, amountIn: 1n, amountOutMinimum: 0n })).toThrow(/slippage/);
    expect(() => buildV4SwapTx({ ...base, amountIn: 0n, amountOutMinimum: 1n })).toThrow(/range/);
    expect(() =>
      buildV4SwapTx({ ...base, poolKey: { ...key, currency0: TOKEN }, amountIn: 1n, amountOutMinimum: 1n }),
    ).toThrow(/native/);
  });

  it("slippage and tolerance helpers", () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(diffBps(10_050n, 10_000n)).toBeCloseTo(50, 6);
    expect(withinTolerance(10_049n, 10_000n, 50)).toBe(true);
    expect(withinTolerance(9_940n, 10_000n, 50)).toBe(false);
  });
});
