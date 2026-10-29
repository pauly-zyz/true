import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PangeaPoolsClient, quoteLiquidityUsd, parsePoolsResponse } from "../src/pangea/pools.js";
import { loadCoinFees } from "../src/coins.js";

const body = readFileSync(new URL("./fixtures/pools-2026-10-29.json", import.meta.url), "utf8");

describe("PangeaPoolsClient", () => {
  it("never calls /api/pools more often than the minimum interval", async () => {
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const c = new PangeaPoolsClient("https://example.test", 60, fetchImpl as unknown as typeof fetch);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await c.get();
    await c.get();
    vi.setSystemTime(59_000);
    await c.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(61_000);
    await c.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("surfaces HTTP errors", async () => {
    const c = new PangeaPoolsClient("https://example.test", 60, (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch);
    await expect(c.get()).rejects.toThrow(/503/);
  });

  it("computes quote liquidity", () => {
    const snap = parsePoolsResponse(JSON.parse(body));
    expect(quoteLiquidityUsd(snap.launches.find((l) => l.slug === "pangea-dadd0d")!)).toBeGreaterThan(100_000);
  });

  it("refuses to run without a fee table", () => {
    expect(() => loadCoinFees("/nonexistent/fees.json")).toThrow(/phase0:fees/);
  });
});
