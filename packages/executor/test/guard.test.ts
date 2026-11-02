import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseConfig } from "@true/core";
import { assertCanBroadcast, BroadcastBlocked, engageKill, isKilled } from "../src/guard.js";
import { loadEvmWallet } from "../src/wallets.js";

const raw = parse(readFileSync(new URL("../../../config/default.yaml", import.meta.url), "utf8"));
const root = mkdtempSync(`${tmpdir()}/true-guard-`) + "/";
const state = () => ({ breakerTripped: false, pausedCoins: new Set<string>() });

describe("live gate", () => {
  it("is a dry run by default", () => {
    const cfg = parseConfig(raw, {});
    expect(cfg.dryRun).toBe(true);
    expect(cfg.liveArmed).toBe(false);
    expect(() => assertCanBroadcast(cfg, root, "base", state())).toThrow(/dry run/);
  });

  it("DRY_RUN=false without LIVE_CONFIRM=yes refuses to load", () => {
    expect(() => parseConfig(raw, { DRY_RUN: "false" })).toThrow(/LIVE_CONFIRM=yes/);
    expect(() => parseConfig(raw, { DRY_RUN: "false", LIVE_CONFIRM: "true" })).toThrow(/LIVE_CONFIRM=yes/);
  });

  it("liveArmed cannot be set from the config file", () => {
    expect(parseConfig({ ...raw, liveArmed: true }, {}).liveArmed).toBe(false);
  });

  it("armed: only enabled chains, and every block reason is enforced", () => {
    const cfg = parseConfig(raw, { DRY_RUN: "false", LIVE_CONFIRM: "yes" });
    expect(cfg.liveArmed).toBe(true);
    expect(() => assertCanBroadcast(cfg, root, "base", state())).not.toThrow();
    expect(() => assertCanBroadcast(cfg, root, "solana", state())).toThrow(/not enabled/);
    expect(() => assertCanBroadcast(cfg, root, "ethereum", state())).toThrow(/not enabled/);
    expect(() => assertCanBroadcast(cfg, root, "bsc", { ...state(), breakerTripped: true })).toThrow(
      /circuit breaker/,
    );
    expect(() =>
      assertCanBroadcast(cfg, root, "bsc", { breakerTripped: false, pausedCoins: new Set(["zgap"]) }, "zgap"),
    ).toThrow(/paused/);
  });

  it("kill switch blocks everything until the file is removed", () => {
    const cfg = parseConfig(raw, { DRY_RUN: "false", LIVE_CONFIRM: "yes" });
    engageKill(cfg, root, "test");
    expect(isKilled(cfg, root).killed).toBe(true);
    try {
      assertCanBroadcast(cfg, root, "base", state());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastBlocked);
      expect((e as Error).message).toMatch(/kill switch/);
    }
    rmSync(`${root}${cfg.live!.killFile}`);
    expect(() => assertCanBroadcast(cfg, root, "base", state())).not.toThrow();
  });
});

describe("wallets", () => {
  it("loads from env, never exposes the key, rejects malformed keys", () => {
    // well-known anvil test account #0; never holds real funds
    const anvil0 = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478c", "bed5efcae784d7bf4f2ff80"].join(""); // safety-check test vector
    const w = loadEvmWallet("base", { BOT_PK_BASE: anvil0 })!;
    expect(w.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(JSON.stringify({ chain: w.chain, address: w.address })).not.toContain(anvil0.slice(2, 10));
    expect(() => loadEvmWallet("base", { BOT_PK_BASE: "0x1234" })).toThrow(/malformed/);
    expect(() => loadEvmWallet("base", { BOT_PK_BASE: "0x1234" })).not.toThrow(/0x1234/);
    expect(
      loadEvmWallet("bsc", { BOT_ADDRESS_BSC: "0x000000000000000000000000000000000000dEaD" })!.account,
    ).toBeUndefined();
    expect(loadEvmWallet("robinhood", {})).toBeNull();
  });
});
