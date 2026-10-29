// Venue-agnostic view of one coin's pool on one chain: buy token with quote, sell token for quote.
import type { ChainName } from "./chains.js";
import { v4Swap, type V4PoolState } from "./math/v4/pool.js";
import { dammV2Reserves, dammV2SwapExactIn, type DammV2PoolState } from "./math/dammv2/index.js";
import { dammV2PriceAInB, fromUnits, v4Price0In1, v4Price1In0 } from "./math/price.js";
import { getAmount0Delta, getAmount1Delta } from "./math/v4/sqrtPriceMath.js";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, getSqrtPriceAtTick } from "./math/v4/tickMath.js";

export interface Fill {
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  /** Fee denominated in the input token for exact-input fee-on-input pools, otherwise output token. */
  feeOnInput: boolean;
  partialFill: boolean;
}

export interface Venue {
  chain: ChainName;
  tokenDecimals: number;
  quoteDecimals: number;
  /** Mid price of 1 token in quote units (human). */
  midPriceInQuote(): number;
  /** Quote and token reserves in human units (what the pool can pay out). */
  reserves(): { token: number; quote: number };
  /** Exact input: spend `quoteIn` raw quote, receive tokens. */
  buyToken(quoteIn: bigint): Fill;
  /** Exact input: sell `tokenIn` raw tokens, receive quote. */
  sellToken(tokenIn: bigint): Fill;
}

export interface V4VenueParams {
  chain: ChainName;
  state: V4PoolState;
  /** Pangea pools pair the token with the native asset, which is currency0 (address 0 sorts first). */
  tokenIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  /**
   * Fee charged by a hook on the quote side, in pips (1e6 = 100%): taken from the quote input on
   * buys (before the swap) and from the quote output on sells (after the swap), rounded down.
   * Pangea's EVM pools have LP fee 0 and charge the trading fee this way (verified on Robinhood).
   */
  quoteHookFeePips?: bigint;
}

const PIPS = 1_000_000n;

export function v4Venue(p: V4VenueParams): Venue {
  const { state, tokenIsCurrency0 } = p;
  const hookPips = p.quoteHookFeePips ?? 0n;
  if (hookPips < 0n || hookPips >= PIPS) throw new Error("quoteHookFeePips out of range");
  if (hookPips > 0n && state.feePips > 0n) {
    throw new Error("combining a pool LP fee with a quote hook fee is not modelled");
  }
  const dec0 = tokenIsCurrency0 ? p.tokenDecimals : p.quoteDecimals;
  const dec1 = tokenIsCurrency0 ? p.quoteDecimals : p.tokenDecimals;
  const swap = (zeroForOne: boolean, amountIn: bigint): Fill => {
    if (amountIn <= 0n) return { amountIn: 0n, amountOut: 0n, feeAmount: 0n, feeOnInput: true, partialFill: false };
    const r = v4Swap(state, { zeroForOne, amountSpecified: -amountIn });
    return { amountIn: r.amountIn, amountOut: r.amountOut, feeAmount: r.feeAmount, feeOnInput: true, partialFill: r.partialFill };
  };
  return {
    chain: p.chain,
    tokenDecimals: p.tokenDecimals,
    quoteDecimals: p.quoteDecimals,
    midPriceInQuote: () =>
      tokenIsCurrency0 ? v4Price0In1(state.sqrtPriceX96, dec0, dec1) : v4Price1In0(state.sqrtPriceX96, dec0, dec1),
    reserves: () => {
      // amounts available within the initialized ranges on each side of the current price
      let amt0 = 0n;
      let amt1 = 0n;
      let L = state.liquidity;
      let price = state.sqrtPriceX96;
      const above = state.ticks.filter((t) => t.tick > state.tick);
      for (const t of above) {
        const next = getSqrtPriceAtTick(t.tick);
        if (L > 0n) amt0 += getAmount0Delta(price, next, L, false);
        L += t.liquidityNet;
        price = next;
      }
      if (L > 0n) amt0 += getAmount0Delta(price, MAX_SQRT_PRICE - 1n, L, false);
      L = state.liquidity;
      price = state.sqrtPriceX96;
      const below = state.ticks.filter((t) => t.tick <= state.tick).reverse();
      for (const t of below) {
        const next = getSqrtPriceAtTick(t.tick);
        if (L > 0n) amt1 += getAmount1Delta(next, price, L, false);
        L -= t.liquidityNet;
        price = next;
      }
      if (L > 0n) amt1 += getAmount1Delta(MIN_SQRT_PRICE + 1n, price, L, false);
      const token = tokenIsCurrency0 ? amt0 : amt1;
      const quote = tokenIsCurrency0 ? amt1 : amt0;
      return { token: fromUnits(token, p.tokenDecimals), quote: fromUnits(quote, p.quoteDecimals) };
    },
    buyToken: (quoteIn) => {
      const hookFee = (quoteIn * hookPips) / PIPS;
      const f = swap(!tokenIsCurrency0, quoteIn - hookFee);
      if (hookPips === 0n) return f;
      // the hook keeps its fee even if the pool only partially fills
      return { ...f, amountIn: f.amountIn + hookFee, feeAmount: f.feeAmount + hookFee, feeOnInput: true };
    },
    sellToken: (tokenIn) => {
      const f = swap(tokenIsCurrency0, tokenIn);
      if (hookPips === 0n) return f;
      const hookFee = (f.amountOut * hookPips) / PIPS;
      // pool LP fee (if any) is in the token here; with a quote hook fee the pool fee is 0 on Pangea
      return { ...f, amountOut: f.amountOut - hookFee, feeAmount: hookFee + f.feeAmount, feeOnInput: false };
    },
  };
}

export interface DammV2VenueParams {
  chain: ChainName;
  state: DammV2PoolState;
  /** Usually the Pangea token is token A and SOL is token B. */
  tokenIsA: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
}

export function dammV2Venue(p: DammV2VenueParams): Venue {
  const { state, tokenIsA } = p;
  const swap = (aToB: boolean, amountIn: bigint): Fill => {
    if (amountIn <= 0n) return { amountIn: 0n, amountOut: 0n, feeAmount: 0n, feeOnInput: true, partialFill: false };
    const r = dammV2SwapExactIn(state, amountIn, aToB);
    const feeOnInput = state.collectFeeMode !== 0 && !aToB;
    return { amountIn: r.amountIn, amountOut: r.amountOut, feeAmount: r.feeAmount, feeOnInput, partialFill: r.partialFill };
  };
  return {
    chain: p.chain,
    tokenDecimals: p.tokenDecimals,
    quoteDecimals: p.quoteDecimals,
    midPriceInQuote: () => {
      const decA = tokenIsA ? p.tokenDecimals : p.quoteDecimals;
      const decB = tokenIsA ? p.quoteDecimals : p.tokenDecimals;
      const aInB = dammV2PriceAInB(state.sqrtPrice, decA, decB);
      return tokenIsA ? aInB : 1 / aInB;
    },
    reserves: () => {
      const [a, b] = dammV2Reserves(state);
      return tokenIsA
        ? { token: fromUnits(a, p.tokenDecimals), quote: fromUnits(b, p.quoteDecimals) }
        : { token: fromUnits(b, p.tokenDecimals), quote: fromUnits(a, p.quoteDecimals) };
    },
    buyToken: (quoteIn) => swap(!tokenIsA, quoteIn),
    sellToken: (tokenIn) => swap(tokenIsA, tokenIn),
  };
}
