// Our hand-written ABI fragments must match the official Uniswap artifacts exactly.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { poolManagerEventsAbi, stateViewAbi } from "../src/evm/abi.js";
import { erc6909TransferAbi, hookFeePips, roundToBps } from "../src/evm/hookFee.js";

const require = createRequire(import.meta.url);
const pm = require("@uniswap/v4-core/out/IPoolManager.sol/IPoolManager.json").abi as Array<AbiEvent | AbiFunction>;
const pmFull = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json").abi as Array<AbiEvent | AbiFunction>;
const sv = require("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json").abi as Array<AbiEvent | AbiFunction>;

describe("ABIs match official artifacts", () => {
  it("PoolManager events", () => {
    for (const ev of poolManagerEventsAbi) {
      const ref = pm.find((x) => x.type === "event" && x.name === ev.name) as AbiEvent;
      expect(toEventSelector(ev)).toBe(toEventSelector(ref));
      expect(ev.inputs.map((i) => ("indexed" in i ? i.indexed : false) ?? false)).toEqual(
        ref.inputs.map((i) => i.indexed ?? false),
      );
    }
  });
  it("StateView functions", () => {
    for (const fn of stateViewAbi) {
      const ref = sv.find((x) => x.type === "function" && x.name === fn.name) as AbiFunction;
      expect(toFunctionSelector(fn)).toBe(toFunctionSelector(ref));
      expect(fn.outputs.map((o) => o.type)).toEqual(ref.outputs.map((o) => o.type));
    }
  });
});

describe("hook fee helpers", () => {
  it("ERC-6909 Transfer matches PoolManager artifact", () => {
    const ref = pmFull.find((x) => x.type === "event" && x.name === "Transfer") as AbiEvent;
    expect(toEventSelector(erc6909TransferAbi[0])).toBe(toEventSelector(ref));
  });
  it("computes the fee from real Robinhood PANGEA swaps (1%)", () => {
    // buy: pool took 0.004182938002278630 ETH, hook claimed 0.000042251899012915
    expect(roundToBps(hookFeePips(-4182938002278630n, 42251899012915n))).toBe(10_000);
    // sell: pool paid 0.008709786433750235 ETH, hook claimed 0.000087097864337502
    expect(roundToBps(hookFeePips(8709786433750235n, 87097864337502n))).toBe(10_000);
  });
});
