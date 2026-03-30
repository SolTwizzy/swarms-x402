# awesome-x402 PR Submission Guide

## Target Repository

- **Repo:** [xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402)
- **File to edit:** `README.md`

---

## Listing to Add

### Primary Listing (Ecosystem Projects > Tools & Services)

Add under the `## Ecosystem Projects` > `### Tools & Services` section, alphabetically near other multi-endpoint platforms (after "SwarmX" alphabetically, near entries like "SkillMint", "SIBYL", etc.):

```markdown
- [SwarmX](https://api.swarmx.io) - Multi-agent AI orchestration platform with 28 x402 endpoints on Solana. Research pipelines, analysis panels, code review, smart contract audits (4-6 agents), token risk scoring, DAO proposal analysis, wallet analytics, and trading data. 15+ swarm architectures (Sequential, Concurrent, MixtureOfAgents, Graph). $0.001-$0.25 USDC per call. Free tier (10 calls/day). TypeScript. ElizaOS plugin. ([GitHub](https://github.com/swarmx-org/swarms-x402)) | ([Catalog](https://api.swarmx.io/x402/catalog))
```

### Secondary Listing (AI Agent Integration > Agent Frameworks)

Add under the `## AI Agent Integration` > `### Agent Frameworks` section:

```markdown
- [SwarmX](https://github.com/swarmx-org/swarms-x402) - Multi-agent orchestration with native x402 payments. 15+ swarm architectures (Sequential, Concurrent, MixtureOfAgents, Graph, HeavySwarm). TypeScript/ElizaOS plugin. 28 paid endpoints from $0.001 USDC. ([Live API](https://api.swarmx.io))
```

---

## Where Exactly to Insert

### Tools & Services listing

In the `### Tools & Services` subsection under `## Ecosystem Projects`, insert the entry alphabetically. It should go after entries starting with "S" (after "SkillMint" or "SIBYL") and before entries starting with "T" (before "Token Intelligence API").

### Agent Frameworks listing

In the `### Agent Frameworks` subsection under `## AI Agent Integration`, insert after the existing entries:

```
- [NEAR AI](https://near.ai) - Cross-chain agent settlements.
- [Phidata Agents](https://github.com/phidatahq/phidata) - Multi-modal agents with x402.
- [SwarmX](https://github.com/swarmx-org/swarms-x402) - ...  <-- INSERT HERE
- [Vault-0](https://github.com/0-Vault/Vault-0) - ...
```

---

## PR Details

### Title

```
Add SwarmX - Multi-agent AI orchestration with x402 payments
```

### Description

```markdown
## What is SwarmX?

SwarmX is a multi-agent AI orchestration platform with native x402 micropayments on Solana. It implements the pattern from [Kye Gomez's x402 monetization tutorial](https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2) as a production TypeScript platform.

## Key Details

- **28 x402-gated endpoints** live on Solana mainnet
- **15+ swarm architectures**: Sequential, Concurrent, MixtureOfAgents, Graph, HeavySwarm, Debate, and more
- **Pricing**: $0.001-$0.25 USDC per call (trading data at $0.001, deep contract audit at $0.25)
- **Free tier**: 10 calls/day per IP with truncated output
- **Endpoint categories**: Research pipelines, analysis panels, code review, smart contract audits, token risk scoring, DAO analysis, wallet analytics, Solana trading data, summarization, translation, sentiment, extraction
- **Stack**: TypeScript, Bun, ElizaOS v2 plugin, Dexter SDK (@dexterai/x402)
- **Live API**: https://api.swarmx.io
- **Catalog**: https://api.swarmx.io/x402/catalog

## Links

- GitHub: https://github.com/swarmx-org/swarms-x402
- Live API: https://api.swarmx.io
- Catalog endpoint: GET https://api.swarmx.io/x402/catalog (free, lists all endpoints with pricing)

## Listing locations

Added to:
1. **Ecosystem Projects > Tools & Services** (primary listing with full detail)
2. **AI Agent Integration > Agent Frameworks** (shorter listing focused on orchestration)
```

### Labels

- `enhancement`

### Branch Name

```
add-swarmx
```

---

## Checklist Before Submitting

- [ ] Verify https://api.swarmx.io is responding (Railway deployment active)
- [ ] Verify https://api.swarmx.io/x402/catalog returns the full endpoint list
- [ ] Confirm the GitHub repo is public
- [ ] Check that the listing format matches the existing entries (link format, description length, features mentioned)
- [ ] Ensure no duplicate entry exists in the README
