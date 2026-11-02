// pnpm live:kill [reason]  -> writes the kill file; the live bot stops before its next trade or bridge.
// pnpm live:resume <slug>  -> queues a resume request for a coin paused after a failed leg.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@true/core";
import { engageKill } from "@true/executor";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const cfg = loadConfig(`${ROOT}config/default.yaml`, { ...process.env, DRY_RUN: "true" });
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "kill") {
  engageKill(cfg, ROOT, rest.join(" ") || "manual kill from CLI");
  console.log(`kill switch engaged: ${ROOT}${cfg.live!.killFile}`);
} else if (cmd === "resume" && rest[0]) {
  mkdirSync(`${ROOT}data/live`, { recursive: true });
  writeFileSync(`${ROOT}data/live/resume-${rest[0]}`, new Date().toISOString());
  console.log(`resume requested for ${rest[0]} (the bot picks it up within a few seconds)`);
  if (existsSync(`${ROOT}${cfg.live!.killFile}`))
    console.log("note: the kill switch is engaged; remove the kill file to trade again");
} else {
  console.error("usage: kill [reason] | resume <slug>");
  process.exit(1);
}
