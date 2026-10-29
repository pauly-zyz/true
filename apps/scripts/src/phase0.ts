export {};
// `pnpm phase0`: analyse locally collected data and render reports/phase0.md (no network).
// Collect data first with: collect-snapshots.ts, fees.ts, fetch-history.ts (see README).
await import("./analyze.js");
await import("./report.js");
