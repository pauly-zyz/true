import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { loadConfig, loadSecrets, parseConfig, requireAddress } from "../src/config.js";
import { redactSecrets, redactUrl } from "../src/log.js";

const raw = parse(readFileSync(new URL("../../../config/default.yaml", import.meta.url), "utf8"));

describe("config", () => {
  it("loads default.yaml and defaults to DRY_RUN=true", () => {
    const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname, {});
    expect(cfg.dryRun).toBe(true);
    expect(cfg.chains.solana.venue).toBe("meteora-damm-v2");
    expect(cfg.chains.bsc.quoteAsset).toBe("BNB");
  });

  it("refuses DRY_RUN=false", () => {
    expect(() => parseConfig(raw, { DRY_RUN: "false" })).toThrow(/DRY_RUN/);
    expect(() => parseConfig({ ...raw, dryRun: false }, {})).toThrow(/DRY_RUN/);
  });

  it("uses the LayerZero endpoint ids from the brief", () => {
    const cfg = parseConfig(raw, {});
    expect(cfg.chains.ethereum.lzEid).toBe(30101);
    expect(cfg.chains.base.lzEid).toBe(30184);
    expect(cfg.chains.robinhood.lzEid).toBe(30416);
    expect(cfg.chains.bsc.lzEid).toBe(30102);
    expect(cfg.chains.solana.lzEid).toBe(30168);
  });

  it("rejects invalid values", () => {
    expect(() => parseConfig({ ...raw, risk: { ...raw.risk, maxTradeFractionOfSmallerPool: 2 } }, {})).toThrow();
    expect(() => parseConfig({ ...raw, pangea: { ...raw.pangea, poolsRefreshSec: 5 } }, {})).toThrow();
  });

  it("requireAddress refuses missing addresses instead of guessing", () => {
    expect(() => requireAddress(null, "ETH/USD feed")).toThrow(/not configured/);
  });

  it("reads secrets only from env", () => {
    const s = loadSecrets({ RPC_HTTP_BASE: "https://x/abc", RPC_WS_SOLANA: "wss://y", DATABASE_URL: "postgres://a" });
    expect(s.rpcHttp.base).toBe("https://x/abc");
    expect(s.rpcWs.solana).toBe("wss://y");
    expect(s.rpcHttp.ethereum).toBeUndefined();
  });
});

describe("redaction", () => {
  it("hides api keys embedded in RPC urls", () => {
    expect(redactUrl("https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrSt1234")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/***",
    );
    expect(redactUrl("wss://rpc.example.com/?api-key=secret")).toBe("wss://rpc.example.com/?***");
    expect(redactUrl("postgres://user:pw@localhost:5432/db")).toBe("postgres://***@localhost:5432/db");
  });

  it("deep-redacts objects", () => {
    const out = redactSecrets({ rpc: "https://h.io/v2/AbCdEfGhIjKlMnOpQrSt", nested: { apiKey: "k", n: 1n } });
    expect(JSON.stringify(out)).not.toContain("AbCdEfGhIjKlMnOpQrSt");
    expect(JSON.stringify(out)).not.toContain('"k"');
  });
});
