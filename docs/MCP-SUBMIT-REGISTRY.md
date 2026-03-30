# Official MCP Registry Submission

## Status: MANUAL ACTION REQUIRED (CLI with interactive GitHub auth)

The official MCP Registry (modelcontextprotocol/registry) is the canonical source. PulseMCP auto-indexes from it weekly. This is the highest-priority submission.

## Prerequisites

1. `server.json` already created in repo root
2. `mcpName` needs to be added to `package.json`
3. Package must be published to npm

## Step 1: Add mcpName to package.json

Add this field to package.json:
```json
"mcpName": "io.swarmx/swarms-x402"
```

## Step 2: Publish updated package to npm

```bash
npm publish --access public
```

## Step 3: Install mcp-publisher

```bash
# macOS/Linux
brew install modelcontextprotocol/tap/mcp-publisher

# Or download binary from:
# https://github.com/modelcontextprotocol/registry/releases
```

## Step 4: Authenticate

```bash
mcp-publisher login github
# Follow the browser auth flow
```

## Step 5: Publish to registry

```bash
mcp-publisher publish
```

## Step 6: Verify

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.swarmx/swarms-x402"
```

## server.json

Already created at repo root. Contains:
- name: io.swarmx/swarms-x402
- Remote server URL: https://swarmx.io/mcp
- npm package: swarms-x402

## Why This Matters

The official MCP Registry is the canonical source that other directories auto-index from:
- PulseMCP ingests daily, processes weekly
- Glama may auto-index
- Claude Desktop and other clients may discover servers from it
