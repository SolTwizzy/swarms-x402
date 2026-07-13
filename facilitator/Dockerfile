# swarmx-rh-facilitator — standalone x402 facilitator for Robinhood Chain (eip155:4663)
FROM oven/bun:1

WORKDIR /app

# Install deps against the committed lockfile first (better layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source
COPY tsconfig.json ./
COPY src ./src

ENV PORT=4021
EXPOSE 4021

# Bun auto-serves the default export { port, fetch } from index.ts
CMD ["bun", "run", "src/index.ts"]
