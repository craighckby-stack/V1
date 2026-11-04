import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors FAIL the build. tsc currently reports 0 errors across src/ —
  // the previous `ignoreBuildErrors: true` was a temporary scaffold-era
  // escape hatch that silently hid any future type regression.
  typescript: {
    ignoreBuildErrors: false,
  },
  // Keep `next build`'s standalone trace from swallowing the whole project
  // (262 MB → 144 MB). Turbopack falls back to whole-project tracing when
  // it sees dynamic filesystem access (hot-swap.ts, sandbox-test.ts,
  // test-attacker.ts all read files at runtime by design — that's the
  // self-rewriting part of this system), so these bulky non-runtime
  // directories must be excluded explicitly: uploaded repo snapshots
  // (upload/), tool output dumps (tool-results/), downloads (download/),
  // screenshots, and the build-record PDFs.
  outputFileTracingExcludes: {
    "*": [
      "upload/**",
      "tool-results/**",
      "download/**",
      "screenshots/**",
      "docs/screenshots/**",
      "*.pdf",
    ],
  },
  reactStrictMode: false,
};

export default nextConfig;
