import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * ESLint policy (audit F-4 — "the linter is neutered"): this config
 * previously disabled ~28 rules wholesale, which hid every category of
 * defect the audit found (unused vars, `any`, non-null assertions,
 * dead code, hook misuse). All rules are now ENABLED with exactly four
 * documented exceptions below. Violations are fixed, not silenced.
 */
const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // ── Deliberate exceptions (each with its justification) ────────────

    // This system NARRATES ITSELF: the operator's primary interface is a
    // terminal stream fed by server-side console output, and the loop's
    // [SELF-ENHANCE] console lines are the durable record of cycle
    // progress (see loop-worker-client.ts). 260+ intentional log calls
    // are the product, not debug leftovers.
    "no-console": "off",

    // TypeScript owns undefined-symbol checking (tsc --noEmit is a gate
    // the loop itself enforces). eslint's no-undef doesn't understand TS
    // types/UMD globals (React, Bun, RequestInit) and only produces false
    // positives here — the standard typescript-eslint recommendation is
    // to leave it off for TS projects.
    "no-undef": "off",

    // propTypes are redundant in a fully-typed TS codebase — every
    // component's props are declared via TypeScript types (the standard
    // eslint-config-react policy for TS files).
    "react/prop-types": "off",

    // The React Compiler is not enabled for this project (next.config.ts
    // has no reactCompiler flag); running its lint rules would flag
    // patterns that are correct under the standard runtime.
    "react-compiler/react-compiler": "off",

    // ── Tuned rule options (rule is ON, options are conventional) ─────

    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        // Canonical prop-stripping pattern: destructuring `variant`/`size`
        // ONLY to exclude them from `...props` (see toggle-group.tsx) is
        // intentional and must not warn.
        ignoreRestSiblings: true,
      },
    ],
  },
}];

eslintConfig.push({
  // "build/**" is generic; the Firebase function's compiled output lives in
  // proxy/firebase/functions/lib (CommonJS require() calls are normal in
  // build artifacts) — excluded for the same reason as build/**.
  // skills/ is vendored SDK example code (not this project's source).
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "proxy/firebase/functions/lib/**", "proxy/firebase/functions/node_modules/**"],
});

export default eslintConfig;