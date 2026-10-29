// Our hand-written ABI fragments must match the official Uniswap artifacts exactly.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { poolManagerEventsAbi, stateViewAbi } from "../src/evm/abi.js";

const require = createRequire(import.meta.url);
const pm = require("@uniswap/v4-core/out/IPoolManager.sol/IPoolManager.json").abi as Array<AbiEvent | AbiFunction>;
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
