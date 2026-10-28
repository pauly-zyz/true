#!/usr/bin/env node
// Fails if Phase 0/1 code contains anything that could sign or send a transaction,
// or anything that looks like a committed secret.
import { execSync } from "node:child_process";

const files = execSync("git ls-files 'apps/**/*.ts' 'packages/**/*.ts'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const forbidden = [
  /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount/,
  /\b(signTransaction|sendTransaction|sendRawTransaction|writeContract|signMessage)\b/,
  /Keypair\.(fromSecretKey|fromSeed|generate)/,
  /PRIVATE_KEY|SECRET_KEY|MNEMONIC/,
  /0x[0-9a-fA-F]{64}\b(?!.*(topic|hash|poolId|salt))/i,
];

let bad = 0;
import { readFileSync } from "node:fs";
for (const f of files) {
  if (f === "scripts/safety-check.mjs") continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const re of forbidden) {
      if (re.test(line) && !line.includes("safety-check: allow")) {
        console.error(`${f}:${i + 1}: forbidden pattern ${re}`);
        bad++;
      }
    }
  });
}
if (bad) {
  console.error(`\nsafety-check: ${bad} problem(s). Phase 0/1 must not sign transactions or hold keys.`);
  process.exit(1);
}
console.log(`safety-check: OK (${files.length} files)`);
