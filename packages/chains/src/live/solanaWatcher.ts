// Follows Meteora DAMM v2 pool accounts on Solana (accountSubscribe) and decodes them with the
// official cp-amm IDL coder.
import { Connection, PublicKey } from "@solana/web3.js";
import * as cpAmm from "@meteora-ag/cp-amm-sdk";

export interface DammAccountUpdate {
  poolId: string;
  sqrtPrice: bigint;
  liquidity: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  collectFeeMode: number;
}

interface DecodedPool {
  sqrtPrice: { toString(): string };
  liquidity: { toString(): string };
  sqrtMinPrice: { toString(): string };
  sqrtMaxPrice: { toString(): string };
  collectFeeMode: number;
}

export function dammUpdateFromDecoded(poolId: string, d: DecodedPool): DammAccountUpdate {
  return {
    poolId,
    sqrtPrice: BigInt(d.sqrtPrice.toString()),
    liquidity: BigInt(d.liquidity.toString()),
    sqrtMinPrice: BigInt(d.sqrtMinPrice.toString()),
    sqrtMaxPrice: BigInt(d.sqrtMaxPrice.toString()),
    collectFeeMode: d.collectFeeMode,
  };
}

export function decodeDammPool(poolId: string, data: Buffer): DammAccountUpdate {
  const coder = (cpAmm as unknown as { cpAmmCoder: { accounts: { decode(name: string, b: Buffer): DecodedPool } } }).cpAmmCoder;
  return dammUpdateFromDecoded(poolId, coder.accounts.decode("pool", data));
}

export class SolanaPoolWatcher {
  private subs: number[] = [];
  constructor(
    private readonly connection: Connection,
    private readonly onUpdate: (u: DammAccountUpdate) => void,
    private readonly onError?: (e: Error) => void,
  ) {}

  watch(poolIds: string[]): void {
    for (const id of poolIds) {
      const sub = this.connection.onAccountChange(
        new PublicKey(id),
        (info) => {
          try {
            this.onUpdate(decodeDammPool(id, info.data));
          } catch (e) {
            this.onError?.(e as Error);
          }
        },
        { commitment: "confirmed" },
      );
      this.subs.push(sub);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.subs.map((s) => this.connection.removeAccountChangeListener(s)));
    this.subs = [];
  }
}
