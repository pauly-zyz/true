// Pool models rebuilt from a real /api/pools reading (2026-10-29) must reproduce Pangea's own
// prices and reserves on all five chains.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePoolsResponse, marketCapUsd } from "../src/pangea/pools.js";
import { deriveV4UpperTick, venueFromPangea } from "../src/pangea/venues.js";

const snap = parsePoolsResponse(JSON.parse(readFileSync(new URL("./fixtures/pools-2026-10-29.json", import.meta.url), "utf8")));
const launch = (slug: string) => snap.launches.find((l) => l.slug === slug)!;

describe("venues from /api/pools", () => {
  it("parses the snapshot", () => {
    expect(snap.launches).toHaveLength(3);
    expect(marketCapUsd(launch("pangea-dadd0d"))).toBeGreaterThan(1e6);
  });

  it("derives the Robinhood position's upper tick that was read on-chain", () => {
    const rh = (slug: string) => launch(slug).pools.find((p) => p.chain === "robinhood")!;
    expect(deriveV4UpperTick(rh("pangea-dadd0d"), 60)).toBe(-1860);
    expect(deriveV4UpperTick(rh("zgap"), 60)).toBe(-2580);
    expect(deriveV4UpperTick(rh("pcat"), 60)).toBe(-1800);
  });

  for (const slug of ["pangea-dadd0d", "zgap", "pcat"]) {
    it(`${slug}: mid price and reserves match Pangea on every chain`, () => {
      for (const p of launch(slug).pools) {
        const v = venueFromPangea(p, { feePips: 10_000, tokenDecimals: 9 });
        expect(Math.abs(v.midPriceInQuote() / p.price! - 1)).toBeLessThan(1e-4);
        const r = v.reserves();
        expect(Math.abs(r.quote / p.reserves! - 1)).toBeLessThan(1e-3);
        expect(Math.abs(r.token / p.tokenReserves! - 1)).toBeLessThan(1e-3);
      }
    });
  }

  it("a small buy then sell on the same pool loses about two fees", () => {
    const p = launch("pangea-dadd0d").pools.find((x) => x.chain === "base")!;
    const v = venueFromPangea(p, { feePips: 10_000, tokenDecimals: 9 });
    const buy = v.buyToken(10n ** 15n); // 0.001 ETH
    const sell = v.sellToken(buy.amountOut);
    const roundTrip = Number(sell.amountOut) / 1e15;
    expect(roundTrip).toBeGreaterThan(0.979);
    expect(roundTrip).toBeLessThan(0.981);
  });
});
