// Starts a mainnet fork node for integration tests: anvil if it is on PATH (preferred), otherwise
// Hardhat's node. Both expose the cheat methods the tests use (setBalance, impersonate, snapshot).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ForkNode {
  url: string;
  kind: "anvil" | "hardhat";
  stop: () => void;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  setBalance: (address: string, wei: bigint) => Promise<void>;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fork node at ${url} did not start`);
}

export async function startFork(forkUrl: string, chainId: number, port: number): Promise<ForkNode> {
  const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
  let proc: ChildProcess;
  let kind: ForkNode["kind"];
  if (hasAnvil) {
    kind = "anvil";
    proc = spawn(
      "anvil",
      ["--fork-url", forkUrl, "--port", String(port), "--chain-id", String(chainId), "--silent"],
      { stdio: "ignore" },
    );
  } else {
    kind = "hardhat";
    proc = spawn(
      `${ROOT}node_modules/.bin/hardhat`,
      ["node", "--config", `${ROOT}test/fork/hardhat.config.cjs`, "--port", String(port)],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          FORK_URL: forkUrl,
          FORK_CHAIN_ID: String(chainId),
          HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
        },
      },
    );
  }
  const url = `http://127.0.0.1:${port}`;
  await waitFor(url, 120_000);
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  // Hardhat treats calls at the fork block itself as historical; mine one local block first
  if (kind === "hardhat") await rpc("evm_mine", []);
  return {
    url,
    kind,
    stop: () => proc.kill("SIGTERM"),
    rpc,
    setBalance: async (address, wei) =>
      void (await rpc(`${kind}_setBalance`, [address, `0x${wei.toString(16)}`])),
  };
}
