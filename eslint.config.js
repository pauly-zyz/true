import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "data/**", "reports/**"] },
  ...tseslint.configs.recommended,
  {
    // signing is allowed only inside packages/executor (also enforced by scripts/safety-check.mjs)
    ignores: ["packages/executor/**"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Safety: Phase 0/1 must never sign or send transactions.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name=/^(privateKeyToAccount|mnemonicToAccount|signTransaction|sendTransaction|sendRawTransaction|writeContract|Keypair)$/]",
          message: "Signing/sending transactions is only allowed in packages/executor.",
        },
      ],
    },
  },
  {
    files: ["packages/executor/**/*.ts", "apps/**/*.ts", "packages/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
);
