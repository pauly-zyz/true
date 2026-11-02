// Hand-written ABI fragments and configured addresses must match the official Uniswap packages.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { toFunctionSelector, getAddress, type AbiFunction } from "viem";
import { parseConfig } from "@true/core";
import { permit2Abi, universalRouterAbi, v4QuoterAbi } from "../src/evm/abis.js";

const require = createRequire(import.meta.url);
const art = (p: string) => {
  const j = require(p);
  return (j.abi ?? j) as AbiFunction[];
};
const fn = (abi: AbiFunction[], name: string, n?: number) =>
  abi.filter(
    (x) => x.type === "function" && x.name === name && (n === undefined || x.inputs.length === n),
  )[0]!;
const cfg = parseConfig(
  parse(readFileSync(new URL("../../../config/default.yaml", import.meta.url), "utf8")),
  {},
);

describe("ABIs vs official artifacts", () => {
  it("Universal Router execute(bytes,bytes[],uint256)", () => {
    const ref = fn(
      art(
        "../../../node_modules/.pnpm/@uniswap+universal-router@2.1.0/node_modules/@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json",
      ),
      "execute",
      3,
    );
    expect(toFunctionSelector(universalRouterAbi[0])).toBe(toFunctionSelector(ref));
  });
  it("Permit2 approve / allowance", () => {
    const ref = art(
      "../../../node_modules/.pnpm/@uniswap+permit2-sdk@1.4.1_bufferutil@4.1.0/node_modules/@uniswap/permit2-sdk/dist/cjs/abis/Permit2.json",
    );
    for (const f of permit2Abi)
      expect(toFunctionSelector(f as AbiFunction)).toBe(toFunctionSelector(fn(ref, (f as AbiFunction).name)));
  });
  it("V4Quoter quoteExactInputSingle", () => {
    const ref = fn(
      art(
        "../../../node_modules/.pnpm/@uniswap+v4-periphery@1.0.3/node_modules/@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json",
      ),
      "quoteExactInputSingle",
    );
    const mine = v4QuoterAbi.find(
      (x) => x.type === "function" && x.name === "quoteExactInputSingle",
    ) as AbiFunction;
    expect(toFunctionSelector(mine)).toBe(toFunctionSelector(ref));
  });
});

describe("configured addresses vs official SDKs", () => {
  const sdkCore = require("@uniswap/sdk-core");
  const ur = require("@uniswap/universal-router-sdk");
  const permit2 = require("@uniswap/permit2-sdk");
  for (const chain of ["base", "bsc", "robinhood"] as const) {
    it(chain, () => {
      const c = cfg.chains[chain];
      const id = c.chainId!;
      const a = sdkCore.CHAIN_TO_ADDRESSES_MAP[id];
      const eq = (x: string | null, y: string) => expect(getAddress(x!)).toBe(getAddress(y));
      eq(c.uniswapV4.poolManager, a.v4PoolManagerAddress);
      eq(c.uniswapV4.stateView, a.v4StateView);
      eq(c.uniswapV4.quoter, a.v4QuoterAddress);
      eq(c.uniswapV4.universalRouter, ur.UNIVERSAL_ROUTER_ADDRESS(c.uniswapV4.universalRouterVersion, id));
      eq(c.uniswapV4.permit2, permit2.permit2Address(id));
    });
  }
});
