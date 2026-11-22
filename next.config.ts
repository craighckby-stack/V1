import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // OOM GUARD (2026-11-22): the self-enhancement loop mutates src/ files
  // every few minutes, and every mutation triggers Turbopack recompiles of
  // this dev server. Over ~2h of that, next-server's RSS grew past 1.5GB
  // and the kernel OOM-killer shot it (dmesg: "Killed process 1764
  // (next-server)"), leaving the dashboard dark while the loop kept
  // running. The limit below is Turbopack's own memory target — when
  // exceeded, the dev server tears down and restarts cleanly instead of
  // being killed at random. Value is in BYTES (per Next 16's
  // config-shared.d.ts: "A target memory limit for turbo, in bytes") —
  // 1 GiB on this 4 GiB box leaves headroom for the loop-worker,
  // gate child-processes (eslint/tsc spikes ~500MB), and the gateway.
  // The dev-watchdog mini-service (port 3005) respawns the server if a
  // restart ever exits instead of self-recovering — belt and suspenders.
  experimental: {
    turbopackMemoryLimit: 1073741824,
  },
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
