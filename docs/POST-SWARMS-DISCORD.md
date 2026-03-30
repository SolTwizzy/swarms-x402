# Swarms Community Discord Introduction

**Channel:** Swarms Discord (likely #showcase or #projects)

---

Hey Swarms community -- we built the TypeScript production implementation of Kye's "Monetize Your Agents with Swarms and x402" tutorial.

**Reference:** https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2

The tutorial shows the pattern in Python/FastAPI. We took that pattern and built a full production platform in TypeScript with 47 endpoints, templates, persistence, budget controls, and sell-side revenue tracking.

**What we built:**

- **47 HTTP endpoints** selling AI agent services for USDC micropayments ($0.001 - $5.00/call)
- **15+ swarm architectures** -- SequentialWorkflow, ConcurrentWorkflow, MixtureOfAgents, MajorityVoting, HierarchicalSwarm
- **4 pre-built templates** -- ResearchPipeline (3 agents), AnalysisPanel (4 agents), CodeReview (3 agents), DebateAndDecide (3 agents)
- **Premium multi-agent endpoints:**
  - Token Due Diligence: 5 agents + synthesis ($1.00)
  - DeFi Protocol Risk Score: 5 agents + synthesis ($2.00)
  - Adversarial Fact Check: 4 agents sequential ($0.25)
  - Smart Contract Audit: 4-6 agents concurrent ($0.10-$0.25)

**How we use Swarms:**

Multi-agent tasks call the Swarms API (`api.swarms.world/v1/*`) for orchestration. Single-agent tasks call OpenAI directly for cost efficiency. The routing decision is per-endpoint -- research, analyze, code-review, write, and debate go through Swarms. Summarize, translate, sentiment, extract go direct.

We use Swarms for:
- Agent specification (AgentSpec with model, system prompt, temperature)
- Workflow orchestration (sequential chains, parallel execution, mixture-of-agents)
- Multi-agent synthesis (independent analysis -> combined verdict)

**Also:**
- ElizaOS v2 plugin (PR #322 in registry, 5 actions + 4 services)
- MCP server (39 tools)
- 668 tests, 36 test files
- Deployed on Railway, processing real x402 payments on Solana mainnet

**Live:** https://swarmx.io
**GitHub:** https://github.com/SolTwizzy/swarms-x402

Would love feedback from the Swarms community, especially on:
- Multi-agent workflow patterns that work well for production (we found ConcurrentWorkflow + synthesis agent is the best pattern for analysis tasks)
- Agent system prompt design for specialized roles
- Any Swarms API features we should be using that we're not

This is the first TypeScript/production-grade implementation of the tutorial pattern. Happy to contribute learnings back to the community.
