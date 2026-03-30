# Smithery.ai Submission

## Status: MANUAL ACTION REQUIRED

Smithery requires interactive authentication via their CLI or web UI.

## Option A: Web UI (Recommended)

1. Go to https://smithery.ai/new
2. Enter the server URL: `https://swarmx.io/mcp`
3. Complete the publishing flow (Smithery auto-scans for metadata)

## Option B: CLI

```bash
# Install and authenticate first
npx @smithery/cli auth login

# Then publish
npx @smithery/cli mcp publish "https://swarmx.io/mcp" -n swarmx/swarmx
```

## Config File

We already have `smithery.yaml` in the repo root with proper config schema.

## Details to Use

- **Name**: swarmx/swarmx (or @SolTwizzy/swarmx)
- **Server URL**: https://swarmx.io/mcp
- **Description**: Multi-agent AI orchestration with native x402 micropayments. 39 MCP tools for crypto analysis, smart contract audit, DeFi yield optimization, code review, research reports, and trading data. Pay per call with USDC.
- **Categories**: AI, Crypto, Finance, Developer Tools
