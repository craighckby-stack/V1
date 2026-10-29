# Bun runtime base image — keeps the image tiny (~50MB) and boot fast (~50ms).
# Pin to a specific major so we don't drift silently on `fly deploy`.
FROM oven/bun:1.3 AS runtime

WORKDIR /app

# Copy just the entry file. The proxy has zero npm dependencies — Bun's
# built-in fetch + Bun.serve are all it uses — so no `bun install` step.
# This is what makes the deploy a 5-second operation.
COPY index.ts .

# Fly.io injects PORT=8080 by convention for the internal_port. We respect
# it via process.env.PORT in index.ts (default 8787, overridden here).
ENV PORT=8787

EXPOSE 8787

# Bun's --hot watches for file changes; harmless in prod (we don't mount a
# volume), and useful if you ever `fly ssh console` to live-patch.
CMD ["bun", "run", "index.ts"]
