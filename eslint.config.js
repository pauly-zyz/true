import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "data/**", "reports/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Safety: Phase 0/1 must never sign or send transactions.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name=/^(privateKeyToAccount|mnemonicToAccount|signTransaction|sendTransaction|sendRawTransaction|writeContract|Keypair)$/]",
          message: "Signing/sending transactions is forbidden in Phase 0/1 (DRY_RUN only).",
        },
      ],
    },
  },
);
