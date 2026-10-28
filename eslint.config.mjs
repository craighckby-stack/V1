import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Normalizes imported ESLint configuration modules to array format.
 *
 * @param {unknown} config - Imported ESLint configuration element or array.
 * @returns {import('eslint').Linter.Config[]} Normalized config array.
 */
const normalizeConfig = (config) => {
  if (Array.isArray(config)) {
    return /** @type {import('eslint').Linter.Config[]} */ (config);
  }
  if (config && typeof config === "object") {
    return [/** @type {import('eslint').Linter.Config} */ (config)];
  }
  return [];
};

/**
 * ESLint Flat Configuration Array for Next.js and TypeScript projects.
 *
 * @type {import('eslint').Linter.Config[]}
 */
const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "examples/**",
      "skills"
    ]
  },
  ...normalizeConfig(nextCoreWebVitals),
  ...normalizeConfig(nextTypescript),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-unused-disable-directive": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "react-compiler/react-compiler": "off",
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",
      "prefer-const": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-debugger": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off"
    }
  }
];

export default eslintConfig;
