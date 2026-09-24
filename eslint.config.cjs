// eslint.config.cjs — flat config (ESLint 9+/10). Converted 2026-09-25 from
// .eslintrc.cjs, which ESLint 10 no longer reads (main's lint had been red
// since the eslint 10 bump). Rules carried over verbatim; ignores merged
// from .eslintignore + the old ignorePatterns.
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");

const nodeGlobals = {
  console: "readonly", process: "readonly", Buffer: "readonly",
  __dirname: "readonly", __filename: "readonly", module: "writable",
  require: "readonly", exports: "writable", global: "readonly",
  setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly",
  clearInterval: "readonly", setImmediate: "readonly", clearImmediate: "readonly",
  queueMicrotask: "readonly", fetch: "readonly", URL: "readonly",
  URLSearchParams: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
  AbortController: "readonly", AbortSignal: "readonly", Event: "readonly",
  EventTarget: "readonly", structuredClone: "readonly", atob: "readonly",
  btoa: "readonly", performance: "readonly", crypto: "readonly",
};

module.exports = [
  { ignores: [
    "node_modules/", "dist/", "build/", "target/", "examples/", "landing/",
    "docs/", "*.config.js", "*.config.cjs", "*.config.mjs", "*.config.ts",
  ] },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsparser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: nodeGlobals,
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs["flat/recommended"].rules,
      "no-unused-vars": "off",
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "quotes": ["warn", "single", { avoidEscape: true, allowTemplateLiterals: true }],
      "semi": ["warn", "always"],
      "comma-dangle": ["warn", "always-multiline"],
    },
  },
  {
    files: ["test/**/*.ts", "test/**/*.js", "**/*.test.ts", "**/*.test.js"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
];
