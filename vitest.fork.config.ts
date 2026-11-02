// pnpm test:fork — integration tests against mainnet forks (anvil, or Hardhat when anvil is missing).
// Needs FORK_RPC_<CHAIN> (or RPC_HTTP_<CHAIN>) for each chain to test; chains without one are skipped.
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  resolve: base.resolve,
  test: { include: ["test/fork/**/*.fork.test.ts"], testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false },
});
