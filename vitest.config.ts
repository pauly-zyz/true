import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@true/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@true/chains": fileURLToPath(new URL("./packages/chains/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
