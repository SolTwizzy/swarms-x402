# MCP Directory Listings for SwarmX

Submission-ready entries for all major MCP server directories and registries.

**Last updated:** 2026-03-29

## Submission Status (2026-03-29)

| Directory | Method | Status | Link |
|-----------|--------|--------|------|
| awesome-web3-mcp-servers | PR | SUBMITTED | https://github.com/demcp/awesome-web3-mcp-servers/pull/53 |
| awesome-remote-mcp-servers | PR | SUBMITTED | https://github.com/jaw9c/awesome-remote-mcp-servers/pull/196 |
| Cline MCP Marketplace | Issue | SUBMITTED | https://github.com/cline/mcp-marketplace/issues/1114 |
| Official MCP Registry | CLI | NEEDS MANUAL (mcp-publisher login) | see docs/MCP-SUBMIT-REGISTRY.md |
| Smithery.ai | CLI/Web | NEEDS MANUAL (auth required) | see docs/MCP-SUBMIT-SMITHERY.md |
| Glama.ai | Web Form | NEEDS MANUAL | see docs/MCP-SUBMIT-GLAMA.md |
| mcp.so | Web Form | NEEDS MANUAL | see docs/MCP-SUBMIT-MCPSO.md |
| PulseMCP | Web Form | NEEDS MANUAL | see docs/MCP-SUBMIT-PULSEMCP.md |
| MCPServers.org | Web Form | NEEDS MANUAL | see docs/MCP-SUBMIT-MCPSERVERS-ORG.md |
| MCPMarket.com | Web Form | NEEDS MANUAL | see docs/MCP-SUBMIT-MCPMARKET.md |
| MCPize | CLI | NEEDS MANUAL (auth required) | see docs/MCP-SUBMIT-MCPIZE.md |
| MCP-Hive | Web Registration | NEEDS MANUAL | see docs/MCP-SUBMIT-MCPHIVE.md |
| appcypher/awesome-mcp-servers | PR | BLOCKED (PRs disabled) | see docs/MCP-SUBMIT-AWESOME-MCP-SERVERS.md |
| LobeHub | N/A | SKIPPED (not MCP format) | — |

---

---

## Table of Contents

1. [Official MCP Registry](#1-official-mcp-registry)
2. [Smithery.ai](#2-smitheryai)
3. [MCPize](#3-mcpize)
4. [mcp.so](#4-mcpso)
5. [PulseMCP](#5-pulsemcp)
6. [Glama.ai](#6-glamaai)
7. [MCP-Hive](#7-mcp-hive)
8. [MCPServers.org (awesome-mcp-servers)](#8-mcpserversorg)
9. [Cline MCP Marketplace](#9-cline-mcp-marketplace)
10. [MCPMarket.com](#10-mcpmarketcom)
11. [LobeHub MCP Marketplace](#11-lobehub-mcp-marketplace)

---

## 1. Official MCP Registry

**URL:** https://registry.modelcontextprotocol.io
**GitHub:** https://github.com/modelcontextprotocol/registry
**Docs:** https://modelcontextprotocol.io/registry/quickstart
**Status:** THE canonical registry. Backed by Anthropic, GitHub, PulseMCP, Microsoft.

### Submission Process

CLI-based publishing via `mcp-publisher`.

```bash
# 1. Install mcp-publisher
brew install mcp-publisher
# OR: download binary from GitHub releases

# 2. Add mcpName to package.json
# Must match the server name in server.json
# Format: io.github.<username>/<server-name>

# 3. Ensure npm package is published first
# The registry only stores metadata, not artifacts

# 4. Initialize server.json
mcp-publisher init

# 5. Authenticate (GitHub OAuth)
mcp-publisher login

# 6. Publish
mcp-publisher publish
```

### Required: `mcpName` in package.json

Add to our `package.json`:

```json
{
  "mcpName": "io.swarmx/swarms-x402"
}
```

### Required: README marker

Add to the top of `README.md` (can be HTML comment):

```html
<!-- mcp-name: io.swarmx/swarms-x402 -->
```

### Required: `server.json`

Create `server.json` in project root:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
  "name": "io.swarmx/swarms-x402",
  "description": "SwarmX — AI Agent Teams with x402 micropayments. 39 tools across 9 categories: crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.",
  "version": "1.0.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/swarmx-org/swarms-x402.git"
  },
  "packages": [
    {
      "registryType": "npm",
      "identifier": "swarms-x402",
      "version": "1.0.0",
      "transport": {
        "type": "stdio"
      }
    }
  ]
}
```

### Priority

**HIGH** — This is the official registry. All other directories increasingly pull from here. Do this first.

---

## 2. Smithery.ai

**URL:** https://smithery.ai
**Docs:** https://smithery.ai/docs/build/project-config/smithery-yaml
**CLI:** https://github.com/smithery-ai/cli
**Status:** One of the largest MCP directories (3,305+ servers). Free to list.

### Submission Process

1. Add `smithery.yaml` to project root
2. Publish via CLI: `smithery mcp publish "<url>" -n <org/server>`

### Required: `smithery.yaml`

Create `smithery.yaml` in project root:

```yaml
# smithery.yaml — SwarmX MCP Server
startCommand:
  type: http
  configSchema:
    type: object
    properties:
      SWARMS_API_KEY:
        type: string
        description: "Swarms API key for multi-agent orchestration"
      OPENAI_API_KEY:
        type: string
        description: "OpenAI API key for single-agent LLM calls"
    required: []
  commandFunction: |
    (config) => ({
      url: "https://swarmx.io/mcp",
      headers: {}
    })
```

### CLI Commands

```bash
# Install Smithery CLI
npm install -g @smithery/cli

# Publish (remote HTTP server)
smithery mcp publish "https://swarmx.io/mcp" -n swarmx-org/swarms-x402
```

### Priority

**HIGH** — Large directory, good developer mindshare. Straightforward CLI publish.

---

## 3. MCPize

**URL:** https://mcpize.com
**Marketplace:** https://mcpize.com/marketplace
**CLI:** https://github.com/mcpize/cli
**Status:** Deploy + monetize platform. 85% revenue share, Stripe payouts.

### Submission Process

CLI-based. Analyzes existing project, deploys, and auto-lists on marketplace.

```bash
# 1. Install CLI
npm install -g @mcpize/cli

# 2. Login (opens browser)
mcpize login

# 3. Analyze existing project (generates mcpize.yaml)
mcpize analyze

# 4. Deploy to MCPize cloud
mcpize deploy

# 5. Set pricing in MCPize dashboard
```

### Notes

- MCPize hosts and runs the server for you (cloud deployment)
- Since we already self-host on Railway, we may want to evaluate whether dual-hosting makes sense
- Alternative: just list on their marketplace directory without deploying
- 85% revenue share on paid tools
- Supports TypeScript natively

### Our Entry

```
Name: SwarmX
Description: AI Agent Teams with x402 micropayments. 39 tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.
GitHub: https://github.com/swarmx-org/swarms-x402
npm: swarms-x402
Categories: AI, Crypto, Finance, Developer Tools
```

### Priority

**MEDIUM** — Good monetization angle, but may conflict with our Railway self-hosting + x402 payment model.

---

## 4. mcp.so

**URL:** https://mcp.so
**Submit:** https://mcp.so/submit
**Status:** 19,000+ servers. Community-driven, one of the largest directories.

### Submission Process

Web form at https://mcp.so/submit — submit GitHub repo URL with server details.

Alternatively, create a GitHub issue in their repository via the "Submit" button in the nav bar.

### Required Fields

- **Server name:** SwarmX
- **GitHub URL:** https://github.com/swarmx-org/swarms-x402
- **Description:** AI Agent Teams with x402 micropayments. 39 tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.
- **Categories:** AI, Crypto, Finance, Developer Tools

### Priority

**HIGH** — Huge directory, high discoverability. Simple web form submission.

---

## 5. PulseMCP

**URL:** https://www.pulsemcp.com/servers
**Submit:** https://www.pulsemcp.com/use-cases/submit
**Contact:** hello@pulsemcp.com
**Status:** 13,230+ servers, updated daily. One of the backing orgs for the official MCP Registry.

### Submission Process

Web form at https://www.pulsemcp.com/use-cases/submit.

Also ingests from the Official MCP Registry automatically — so publishing to the official registry may auto-list here.

### Required Fields

- **Server name:** SwarmX
- **URL:** https://github.com/swarmx-org/swarms-x402
- **Description:** AI Agent Teams with x402 micropayments. 39 tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.
- **npm package:** swarms-x402

### Notes

- PulseMCP enriches listings with popularity data, security analyses, and compatibility info
- They pull from the official MCP Registry, so publishing there first may auto-propagate

### Priority

**MEDIUM** — Likely auto-populated from Official Registry. Submit manually only if it doesn't appear after registry publish.

---

## 6. Glama.ai

**URL:** https://glama.ai/mcp/servers
**Docs:** https://glama.ai/blog/2025-07-08-what-is-glamajson
**Status:** 17,764+ servers. Auto-indexes GitHub repos.

### Submission Process

Two options:

**Option A: Auto-index (if repo is public)**
Glama crawls GitHub automatically. If your repo has MCP server indicators (package.json with MCP SDK, etc.), it may already be indexed.

**Option B: Claim ownership via `glama.json`**
Add `glama.json` to the project root to claim and configure the listing.

### Required: `glama.json`

Create `glama.json` in project root:

```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "maintainers": ["swarmx-org"]
}
```

### What claiming gets you

- Update server name, description, and attributes
- Configure Docker image
- Access usage reports
- Receive notifications of reviews

### Check if already indexed

Visit: https://glama.ai/mcp/servers?query=swarmx or https://glama.ai/mcp/servers/swarmx-org/swarms-x402

### Priority

**MEDIUM** — May already be auto-indexed. Add `glama.json` to claim and polish the listing.

---

## 7. MCP-Hive

**URL:** https://mcp-hive.com
**Status:** Marketplace launching May 11, 2026. Currently assembling first 100 founding providers.

### Submission Process

Apply as a **Founding Provider** (first 100 spots):
- Visit https://mcp-hive.com
- Apply via their onboarding flow
- Benefits: zero platform fees, priority support, influence on platform policies

### Our Entry

```
Name: SwarmX
Description: AI Agent Teams with x402 micropayments. 39 tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.
GitHub: https://github.com/swarmx-org/swarms-x402
npm: swarms-x402
Categories: AI, Crypto, Finance, Developer Tools
Pricing: Per-call ($0.001-$5.00) via x402 micropayments
```

### Priority

**HIGH** — Pre-launch founding provider status = zero fees + early mover advantage. Apply ASAP before 100 spots fill.

---

## 8. MCPServers.org (awesome-mcp-servers)

**URL:** https://mcpservers.org
**Submit:** https://mcpservers.org/submit
**GitHub:** https://github.com/wong2/awesome-mcp-servers
**Status:** Curated list. Does NOT accept GitHub PRs — web form only.

### Submission Process

Web form at https://mcpservers.org/submit.

Do NOT submit a PR to the GitHub repo — they explicitly reject PRs.

### Required Fields

- **Server name:** SwarmX
- **GitHub URL:** https://github.com/swarmx-org/swarms-x402
- **Description:** AI Agent Teams with x402 micropayments. 39 tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. $0.001-$5.00/call.
- **Category:** AI / Finance / Developer Tools

### Priority

**MEDIUM** — Well-known curated list. Simple form submission.

---

## 9. Cline MCP Marketplace

**URL:** https://github.com/cline/mcp-marketplace
**Status:** Official marketplace for Cline (VS Code AI assistant). Reaches millions of developers.

### Submission Process

Create a GitHub Issue in `cline/mcp-marketplace` using their Server Submission template.

### Required Fields

1. **GitHub Repo URL:** https://github.com/swarmx-org/swarms-x402
2. **Logo Image:** 400x400 PNG (we need to create this)
3. **Reason for Addition:** (see below)
4. **Installation Testing:** Must confirm Cline can set up the server from README.md alone

### Submission Issue Body

```markdown
### GitHub Repository URL
https://github.com/swarmx-org/swarms-x402

### Logo Image
<!-- Attach a 400x400 PNG -->

### Reason for Addition
SwarmX provides 39 AI agent tools across 9 categories (crypto analysis, code audit, DeFi research, content generation, compliance, and more) with automatic x402 micropayments ($0.001-$5.00/call). Developers using Cline get instant access to multi-agent orchestration powered by Swarms without managing API keys or billing — x402 handles payments at the protocol level.

### Installation Testing
- [x] Tested giving Cline the README.md and confirmed successful server setup
```

### Prerequisites

- [ ] Create a 400x400 PNG logo for SwarmX
- [ ] Ensure README has clear installation instructions that Cline can follow
- [ ] Consider adding `llms-install.md` for Cline-specific setup instructions

### Priority

**HIGH** — Massive reach (millions of Cline/VS Code users). Worth the effort of creating the logo and testing.

---

## 10. MCPMarket.com

**URL:** https://mcpmarket.com
**Submit:** https://mcpmarket.com/submit
**Status:** Independent MCP directory.

### Submission Process

Web form at https://mcpmarket.com/submit — submit GitHub repository URL for review.

### Required Fields

- **GitHub Repository:** https://github.com/swarmx-org/swarms-x402

### Priority

**LOW** — Smaller directory. Quick form submission, minimal effort.

---

## 11. LobeHub MCP Marketplace

**URL:** https://lobehub.com/mcp
**GitHub:** https://github.com/lobehub/lobehub
**Status:** Open community-driven marketplace. 10,000+ tools. Integrated into LobeHub desktop app.

### Submission Process

Not fully documented for external submissions yet. Options:
1. Check https://lobehub.com/mcp for an "Add" or "Submit" button
2. Open a PR or issue on https://github.com/lobehub/lobehub
3. The marketplace may auto-index from npm / Official Registry

### Our Entry

```json
{
  "name": "SwarmX",
  "description": "AI Agent Teams with x402 micropayments. 39 tools across 9 categories.",
  "github": "https://github.com/swarmx-org/swarms-x402",
  "npm": "swarms-x402",
  "transport": "streamable-http",
  "endpoint": "https://swarmx.io/mcp"
}
```

### Priority

**LOW** — Submission process unclear. May auto-populate from Official Registry.

---

## Submission Priority Order

Execute in this order for maximum impact:

| Priority | Directory | Action | Effort |
|----------|-----------|--------|--------|
| 1 | **Official MCP Registry** | `mcp-publisher publish` | Medium (server.json + CLI) |
| 2 | **mcp.so** | Web form | Low |
| 3 | **MCP-Hive** | Apply as Founding Provider | Low (time-sensitive) |
| 4 | **Cline Marketplace** | GitHub Issue | Medium (need 400x400 logo) |
| 5 | **Smithery.ai** | `smithery.yaml` + CLI | Medium |
| 6 | **Glama.ai** | Add `glama.json` to repo | Low |
| 7 | **MCPServers.org** | Web form | Low |
| 8 | **PulseMCP** | Web form (or auto from registry) | Low |
| 9 | **MCPize** | CLI deploy | Medium (evaluate hosting conflict) |
| 10 | **MCPMarket.com** | Web form | Low |
| 11 | **LobeHub** | TBD | Low |

## Files to Create in Repo

Before submitting, add these files to the repo:

1. **`server.json`** — Official MCP Registry metadata (see section 1)
2. **`smithery.yaml`** — Smithery configuration (see section 2)
3. **`glama.json`** — Glama ownership claim (see section 6)
4. **`mcpName` in `package.json`** — `"io.swarmx/swarms-x402"`
5. **`<!-- mcp-name: ... -->` in `README.md`** — Registry name marker
6. **SwarmX logo** — 400x400 PNG for Cline Marketplace

## Standard Description (Copy-Paste Ready)

**Short (one-liner):**
> SwarmX — AI Agent Teams with x402 micropayments. 39 tools, $0.001-$5.00/call.

**Medium (2-3 sentences):**
> SwarmX provides 39 AI agent tools across 9 categories — crypto analysis, code audit, DeFi, research, content, compliance, and more. Powered by x402 micropayments ($0.001-$5.00/call) and Swarms multi-agent orchestration. No API keys needed — payments happen at the HTTP protocol level.

**Full:**
> SwarmX is a platform for AI agent tasks powered by x402 micropayments and Swarms multi-agent orchestration. It exposes 39 tools across 9 categories including crypto analysis, code auditing, DeFi research, content generation, compliance checking, investment due diligence, and more. Pricing ranges from $0.001 to $5.00 per call, with payments handled automatically at the HTTP 402 protocol level — no API keys, accounts, or billing setup required. Available as a standalone HTTP API, an ElizaOS v2 plugin, or an MCP server.

## Key Links

| Resource | URL |
|----------|-----|
| GitHub | https://github.com/swarmx-org/swarms-x402 |
| npm | https://www.npmjs.com/package/swarms-x402 |
| Live API | https://swarmx.io |
| MCP Endpoint | https://swarmx.io/mcp |
| MCP Manifest | https://swarmx.io/mcp-manifest.json |
