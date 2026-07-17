# ── Build stage ───────────────────────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/

RUN bun run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM oven/bun:1

WORKDIR /app

# Copy package manifests and install production deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

# Copy compiled output from builder
COPY --from=builder /app/dist/ dist/

# Copy source for server.ts (Bun resolves TS imports directly)
COPY src/ src/
COPY tsconfig.json ./

# Copy standalone server entry
COPY server.ts ./

# Benchmark results served by /x402/benchmark (read at runtime from ./scripts)
COPY scripts/benchmark-results.json scripts/

# Default port
ENV PORT=3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "server.ts"]
