// Exact pool models (Venues) from one /api/pools reading. See live/state.ts for the derivation:
// v4 = Pangea's single locked position [minUsableTick, tickUpper] with LP fee 0 and the hook fee on
// the quote side; DAMM v2 = one concentrated position with fees collected in SOL.
import type { Venue } from "@true/core";
import { liveStateFromPangea, venueFromLive } from "../live/state.js";
import type { PangeaPool } from "./pools.js";

export { deriveV4UpperTick } from "../live/state.js";
export { DAMM_MAX_SQRT_PRICE } from "./rawUnits.js";

export interface VenueBuildOptions {
  feePips: number; // trading fee, e.g. 10000 = 1%
  tokenDecimals: number;
  tickSpacing?: number; // 60 on every Pangea pool observed so far
}

export function venueFromPangea(p: PangeaPool, o: VenueBuildOptions): Venue {
  return venueFromLive(liveStateFromPangea(p, o.feePips, Date.now(), o.tickSpacing ?? 60, o.tokenDecimals), o.tokenDecimals);
}
