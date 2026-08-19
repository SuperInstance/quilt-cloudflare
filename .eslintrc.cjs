/**
 * ESLint configuration for this Quilt sub-package.
 *
 * Goals:
 *   - Catch real bugs (no-unused-vars, no-implicit-any, etc.)
 *   - Enforce consistent style (quotes, semicolons, indentation)
 *   - Allow heavy header comments (no restriction on file length)
 *   - Run fast (no slow plugins, default parser)
 *
 * Run: npm run lint
 * Auto-fix: npm run lint -- --fix
 */

module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    "no-unused-vars": "off",
    "no-undef": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": "off",
    "quotes": ["warn", "single", { avoidEscape: true, allowTemplateLiterals: true }],
    "semi": ["warn", "always"],
    "comma-dangle": ["warn", "always-multiline"],
  },
  ignorePatterns: [
    "node_modules/",
    "dist/",
    "build/",
    "examples/",
    "landing/",
    "docs/",
    "*.config.js",
    "*.config.cjs",
    "*.config.mjs",
    "*.config.ts",
  ],
  overrides: [
    {
      files: ["test/**/*.ts", "test/**/*.js", "**/*.test.ts", "**/*.test.js"],
      env: { node: true },
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "no-console": "off",
      },
    },
  ],
};

