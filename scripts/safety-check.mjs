#!/usr/bin/env node
// Repository safety rules (run by `pnpm check`):
// 1. Code that can sign or send transactions may only live in packages/executor.
// 2. Only apps/live (and packages/executor itself) may import @true/executor.
// 3. No committed secrets: no .env, no 32-byte hex literals that look like private keys.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const code = files.filter((f) => /^(apps|packages)\/.*\.(ts|mts|js|mjs)$/.test(f));

const signing = [
  /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|createWalletClient/,
  /\b(signTransaction|sendTransaction|sendRawTransaction|writeContract|signMessage|signTypedData)\b/,
  /Keypair\.(fromSecretKey|fromSeed|generate)/,
  /BOT_PK_|PRIVATE_KEY|SECRET_KEY|MNEMONIC/,
];
const keyLiteral = /0x[0-9a-fA-F]{64}\b/;
const keyContext = /(topic|hash|poolId|salt|guid|orderId|PoolId|txHash|\/\/ poolId)/;

let bad = 0;
const fail = (msg) => {
  console.error(msg);
  bad++;
};

for (const f of files) {
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example"))
    fail(`${f}: .env files must never be committed`);
}

for (const f of code) {
  const inExecutor = f.startsWith("packages/executor/");
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const where = `${f}:${i + 1}`;
    if (!inExecutor) {
      for (const re of signing)
        if (re.test(line)) fail(`${where}: signing code outside packages/executor (${re})`);
    } else if (!f.includes("/test/")) {
      // inside the executor, signing calls must be explicitly marked so every one is reviewed
      for (const re of signing)
        if (re.test(line) && !line.includes("safety-check: allow"))
          fail(`${where}: unmarked signing code (${re})`);
    }
    if (/from\s+["']@true\/executor/.test(line) && !inExecutor && !f.startsWith("apps/live/")) {
      fail(`${where}: only apps/live may import @true/executor`);
    }
    if (keyLiteral.test(line) && !keyContext.test(line))
      fail(`${where}: 32-byte hex literal (possible private key)`);
  });
}

if (bad) {
  console.error(`\nsafety-check: ${bad} problem(s).`);
  process.exit(1);
}
console.log(`safety-check: OK (${code.length} code files)`);
