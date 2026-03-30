# 12 Exposure Channels for SwarmX

Research date: 2026-03-29

---

## 1. x402.org Ecosystem Directory (HIGH PRIORITY)

**URL**: https://www.x402.org/ecosystem

**What it is**: The official x402 ecosystem page, maintained by Coinbase Developer Platform. Lists 50+ projects across 5 categories: Client-Side Integrations, Services/Endpoints, Infrastructure & Tooling, Learning & Community Resources, and Facilitators.

**Current stats** (from x402.org homepage):
- 75.41M transactions in last 30 days
- $24.24M volume
- 94.06K buyers
- 22K sellers

**How to get listed**: Submit a PR to the coinbase/x402 GitHub repo.

**Exact submission process** (from `typescript/site/README.md`):
1. Fork `github.com/coinbase/x402`
2. Create directory: `typescript/site/app/ecosystem/partners-data/swarmx/`
3. Add logo to `public/logos/swarmx-logo.png`
4. Create `metadata.json`:
```json
{
  "name": "SwarmX",
  "description": "Multi-agent AI orchestration with x402 micropayments. 28 endpoints for crypto analysis, trading signals, research, and code review. Pay-per-call via USDC on Solana, no accounts needed.",
  "logoUrl": "/logos/swarmx-logo.png",
  "websiteUrl": "https://api.swarmx.io",
  "category": "Services/Endpoints"
}
```
5. Submit PR

**Requirements for Services/Endpoints**:
- Must have working mainnet integration (we do)
- Should include API documentation (we have playground)
- Should maintain 99% uptime

**Bonus**: The README says: "Once approved, your project will be added to the ecosystem page, and we'd love to do some co-marketing around your use case!"

**Review timeline**: ~5 business days

**ACTION**: Submit PR to coinbase/x402 immediately. This is the single highest-value action.

---

## 2. Dexter.cash (OpenDexter Marketplace)

**URL**: https://dexter.cash

**What it is**: Dexter AI runs the primary x402 marketplace. Shows $379.5K total volume across 13 featured APIs. Top endpoints include Jupiter DEX Quote ($0.10/call, 3.3M calls), Slippage Sentinel ($0.05, 572.1K calls).

**How projects get promoted**:
- **Programmatic index (SDK/MCP)**: Auto-indexed after first x402 settlement. Our 15 endpoints already appear via `searchAPIs()` and the MCP URL.
- **Web UI feed** (dexter.cash/opendexter): Curated by Dexter team. Requires manual approval.
- **Contact**: https://t.me/dexterdao

**What we know**:
- Dexter runs weekly "x402sday" Twitter Spaces (see #4 below)
- They feature ecosystem builders on their spaces
- The @dexteraisol account tags and promotes builders actively

**ACTION**:
1. DM @dexteraisol on X or reach out via t.me/dexterdao to request web UI listing approval
2. Ask to be featured on an upcoming x402sday Twitter Spaces session
3. Generate real transaction volume on our endpoints to improve ranking

---

## 3. X/Twitter: How Other Sellers Announce x402 Endpoints

**Search**: "x402 launch" / "x402 new endpoint" / "x402 just deployed"

**Patterns that get engagement**:

1. **Builder showcase format** (used by @RevealAIsol, @primer_systems):
   - Tag @dexteraisol and @x402 in the post
   - Include a screenshot or demo GIF of the endpoint in action
   - Use #x402 hashtag
   - Describe what the endpoint does + pricing
   - Example: "Just shipped [endpoint name] on #x402! [What it does]. $0.XX per call, pay with USDC, no accounts needed. Built with [@framework]. @dexteraisol @x402"

2. **Stats/data format** (used by @OKX_Ventures):
   - Post x402 ecosystem stats with charts
   - Gets 3-8 likes, 3+ RTs, 900+ views
   - Tag @x402 and related accounts

3. **Thread format** (longer form):
   - "Why we built [X] with x402" thread
   - Technical details + business rationale
   - Tag relevant accounts and use #x402

**Engagement benchmarks** for #x402 posts:
- Good: 2-8 likes, 1-3 RTs, 200-1K views
- Great: 50+ likes, 18+ RTs, 3K+ views (Dexter x402sday spaces posts)

**ACTION**: Create a launch announcement thread: "SwarmX: Multi-agent AI teams, one x402 payment. Here's what we built and why..." Tag @dexteraisol, @x402, @KyeGomez, @elizaos.

---

## 4. X/Twitter: #x402 Hashtag Community

**Key accounts active in #x402**:

| Account | Description | Followers | Relevance |
|---------|-------------|-----------|-----------|
| @dexteraisol | Dexter AI, x402 Agent Platform | Large | Core x402 facilitator, runs x402sday |
| @x402 | Official x402 protocol | Large | Protocol account, co-hosts spaces |
| @OKX_Ventures | OKX Ventures | Very Large | Posts x402 ecosystem analytics |
| @overnance | Ben, Over Protocol | Medium | x402 + Agentic Commerce builder |
| @primer_systems | Primer (x402/8004 agentics) | Medium | x402 browser ext, SDK, facilitator |
| @x402pulse.com | x402Pulse | Small | Tracks x402-powered launches |
| @RevealAIsol | RevealAI | Medium | Active x402 builder, engages with ecosystem |
| @extratard | Itachi.Dev (ElizaOS) | Medium | ElizaOS developer, x402 integration |

**x402sday Twitter Spaces**:
- Hosted by @dexteraisol every Tuesday
- Mar 1 space: 231 listeners, 8 replies, 18 RTs, 51 likes, 3.4K views
- Features builders: @BranchM, @KartikB101 (Sei), @ibamaulanaX (xona_agent)
- Co-hosted by @x402

**ACTION**:
1. Follow and engage with all key accounts listed above
2. DM @dexteraisol to request a guest spot on x402sday
3. Post consistently with #x402 (2-3x per week)
4. Reply to and RT other builders' x402 posts to build relationships

---

## 5. Hackathons with x402 Bounties

**Active/Upcoming hackathons**:

1. **Solana X402 Hackathon** (solana.com/hackathon)
   - $135,000 in prizes
   - Focus: internet payments, agent commerce
   - Status: Registration open
   - We could participate with SwarmX or create a demo/tutorial

2. **San Francisco Agentic Commerce x402 Hackathon** (dorahacks.io)
   - 3-day hybrid hackathon
   - Focus: AI, agentic commerce, x402
   - Builders from multiple ecosystems

3. **Solana Network State (Spring 2026)**
   - Live now (announced 4 days ago)
   - Superteam involved
   - Via Colosseum platform

4. **Colosseum** (colosseum.org)
   - Ongoing Solana hackathon platform
   - Find cofounders, share ideas
   - Regular hackathon cycles

**ACTION**:
1. Register for the Solana X402 Hackathon immediately -- either as a participant (build a SwarmX-powered project) or submit SwarmX itself as an entry
2. Check DoraHacks for upcoming x402-tagged hackathons
3. Consider sponsoring a small bounty track for "best x402 + multi-agent integration"

---

## 6. swarms.world Marketplace

**URL**: https://swarms.world

**What it is**: Swarms Marketplace by Kye Gomez. Categories include Healthcare, Education, Finance, Research, Marketing, Sales, Customer Support. Has x402 and non-x402 filters.

**Key features**:
- "Become a Vendor" - monetize agents, prompts, and tools
- "Top Agents by Market Cap" section (Agent Economy GDP)
- x402 filter tab on marketplace
- Dashboard, Marketplace, Apps, Chat, Bookmarks, Playground

**Community channels**:
- Discord: linked from footer
- Twitter: @swarms_corp (also @SwarmsChina for China market)
- X Community: dedicated X Community
- Telegram: linked from footer
- YouTube: video content
- Blog: linked from footer

**Products**:
- Python Framework
- Swarms Rust
- Swarms API
- TypeScript SDK

**How to get listed/promoted**:
- "Become a Vendor" - list agents, prompts, tools
- Sign up and create a vendor account
- x402-tagged items get a dedicated filter tab

**ACTION**:
1. Create a vendor account on swarms.world
2. List SwarmX endpoints as products with the x402 tag
3. Join the Swarms Discord and Telegram to engage with the community
4. Reach out to Kye Gomez (@KyeGomez) about featuring SwarmX as an x402 showcase

---

## 7. ElizaOS Community

**URL**: https://elizaos.ai

**Stats**: 17,976 GitHub stars, 200+ plugins, 5.3K forks, 1,352 contributors

**How plugins get discovered**:
- elizaos-plugins registry on GitHub (we have PR #322 open)
- Community Discord is the main hub
- Plugin directory at elizaos.ai
- Partnerships: Stanford Future of Digital Currency, Chainlink, Doodles

**Community channels**:
- "Join Community" button on elizaos.ai (likely Discord)
- GitHub discussions
- Partners page mentions collaboration opportunities

**How to get featured**:
1. Get PR #322 merged in elizaos-plugins registry
2. Post in ElizaOS Discord about x402 payment integration
3. Write a tutorial: "How to add x402 payments to your ElizaOS agent with SwarmX"
4. Present at ElizaOS community calls (if they exist)

**ACTION**:
1. Follow up on PR #322 -- push for merge
2. Join ElizaOS Discord and introduce SwarmX in #plugins or #showcase channel
3. Create a tutorial blog post for the ElizaOS community
4. Look for ElizaOS community calls or demo days to present

---

## 8. @dexteraisol Marketing Strategy Analysis

**Account**: @dexteraisol (Dexter AI)

**Verified account** with "x402 Agent Platform" badge

**Marketing strategy breakdown**:

1. **Weekly x402sday Spaces** (their flagship content):
   - Every Tuesday, co-hosted with @x402
   - Feature 3-4 builders per session
   - Topics: Smart wallets, agent fees, discovery, new features
   - High engagement: 200+ listeners, 50+ likes per announcement
   - Recording available for replay

2. **Builder amplification**:
   - Actively tags and promotes ecosystem builders
   - Replies to builders' posts with positive engagement
   - "Only the best from the best in #x402" style engagement

3. **Stats/updates**:
   - Posts about $DEXTER token price
   - Replies to @Helius and other Solana infra accounts
   - Ecosystem metrics sharing

4. **Engagement style**:
   - Supportive, amplifying tone
   - Tags @x402 and individual builders by name
   - Uses emojis and community language

**How to mirror their approach**:
- Post "SwarmX Weekly" stats: endpoints called, revenue, new features
- Amplify other x402 builders (creates reciprocity)
- Host or co-host a Spaces about multi-agent AI + payments
- Create visual content (endpoint dashboards, architecture diagrams)

**ACTION**:
1. Engage with @dexteraisol's posts consistently (reply, RT, quote-tweet)
2. DM to request x402sday guest spot
3. Start a "SwarmX Update" weekly X post series
4. Tag @dexteraisol when announcing new endpoints

---

## 9. AI Agent & API Directories

**Directories to submit SwarmX**:

1. **x402.study** - The Agent Payments Index
   - URL: https://x402.study
   - Tracks x402 ecosystem, has community links
   - Look for submission process

2. **Product Hunt** (producthunt.com)
   - Launch as "SwarmX -- Multi-Agent AI Teams with x402 Micropayments"
   - Best launch day: Tuesday or Wednesday
   - Get 5-10 early supporters to upvote at launch

3. **Hacker News** (news.ycombinator.com)
   - "Show HN: SwarmX -- Pay-per-call multi-agent AI orchestration via x402"
   - Focus on the technical angle: HTTP 402, stablecoins, no accounts

4. **AlternativeTo** (alternativeto.net)
   - List as alternative to: OpenAI API, Anthropic API, AI agent platforms
   - Free to submit

5. **RapidAPI** / **API.guru** / **APIs.io**
   - API discovery platforms
   - List endpoints with OpenAPI spec

6. **MCP directories**:
   - Smithery (smithery.ai) -- already have manifest
   - Glama (glama.ai) -- already have config
   - mcpize.com -- MCP monetization guide mentioned us

7. **Solana ecosystem maps**:
   - Solana.com ecosystem page
   - DeFi Llama (if applicable)
   - Messari asset profiles

8. **AI tool directories**:
   - There's An AI For That (theresanaiforthat.com)
   - AI Tools Directory (aitoolsdirectory.com)
   - Futurepedia (futurepedia.io)
   - ToolsFine (toolsfine.com)

**ACTION**: Submit to top 5 directories this week. Prioritize x402.study, Product Hunt, and Hacker News.

---

## 10. x402 Community Channels

**Found community channels**:

1. **x402 Discord** (Official)
   - Referenced on x402.study and Coinbase Developer Docs
   - "Join the x402 Discord for the latest updates"
   - This is the primary builder community
   - discord.gg link available on x402.study

2. **x402 Builders Telegram**
   - Active developer chat
   - t.me link available on x402.study
   - "Active developer chat" -- this is where builders congregate

3. **Dexter DAO Telegram**
   - https://t.me/dexterdao
   - For Dexter-specific discussions and seller approvals

4. **Primer HQ Telegram**
   - t.me/primer_HQ
   - @primer_systems community, x402 SDK builders

5. **Twitter/X Community**
   - Swarms has a dedicated X Community
   - #x402 is the primary hashtag
   - @x402 is the official protocol account

6. **Coinbase Developer Platform**
   - docs.cdp.coinbase.com
   - Official documentation with Discord links
   - CDP developer community

**ACTION**:
1. Join x402 Discord immediately and introduce SwarmX in #introductions or #showcase
2. Join x402 Builders Telegram and share what we're building
3. Join t.me/dexterdao and request OpenDexter web UI listing
4. Be an active helpful community member (answer questions, share learnings)

---

## 11. github.com/coinbase/x402

**URL**: https://github.com/coinbase/x402

**Status**:
- Discussions tab: Not enabled (404)
- Issues: 19 open
- Pull requests: 41 open
- Stars: Not captured but significant (Coinbase-backed)

**What exists**:
- README mentions ecosystem and submission process
- `typescript/site/` folder contains the x402.org website code
- Ecosystem data stored in `typescript/site/app/ecosystem/partners-data/`
- CONTRIBUTING.md for protocol contributions
- ROADMAP.md for upcoming features
- `specs/` folder mentions "The Bazaar" -- marketplace ecosystem

**Submission for ecosystem** (already detailed in #1 above):
- PR to `typescript/site/app/ecosystem/partners-data/swarmx/`
- Include metadata.json + logo

**Other engagement opportunities**:
- Open an issue or PR for something useful (bug fix, documentation improvement)
- Star the repo (social proof)
- Reference coinbase/x402 in our README

**ACTION**:
1. Submit ecosystem PR (see #1 above)
2. Star the repo
3. Look at open issues for any we can contribute to (builds relationship with maintainers)
4. Update our README to reference the coinbase/x402 repo

---

## 12. Blogs & Publications Covering AI Agent Monetization

**Target publications for guest posts or features**:

1. **Nevermined.ai Blog** -- "How to Monetize AI Agents in 2026" (published 5 days ago)
   - Very recent, covers micro-transactions and enterprise scaling
   - Guest post opportunity: "How SwarmX bridges multi-agent AI and x402 payments"

2. **Chargebee Blog** -- "Selling Intelligence: The 2026 Playbook For Pricing AI Agents"
   - 24 min read, published March 10, 2026
   - Focus on pricing models -- we have a unique angle with x402 per-call pricing

3. **MindStudio Blog** -- "How to Build and Monetize AI Agents as a Business"
   - Feb 2026, focus on no-code agent building
   - We could contribute a technical counterpoint about x402 + Swarms

4. **Aalpha.net Blog** -- "How to Monetize AI Agents - 2025"
   - Covers market sizing and value models
   - Older but high-ranking content

5. **Medium** -- Active x402 community:
   - Kye Gomez's tutorial: "How to Monetize Your Agents with Swarms and x402"
   - Jung-Hua Liu: "x402: An AI-Native Payment Protocol for the Web" (20+ likes)
   - Opportunity: Write our own Medium article

6. **LinkedIn** -- Dan Kim & Erik Reppel (Coinbase Developer Platform):
   - "5 Ways Businesses Will Use x402" (60+ reactions)
   - Dan Kim is a key x402 voice on LinkedIn
   - Opportunity: Write a LinkedIn article and tag Dan Kim

7. **AInvest** -- "x402 Protocol: The Infrastructure Enabling..."
   - Covers x402 from investment angle
   - Opportunity: Pitch a feature about SwarmX

**ACTION**:
1. Write a Medium article: "Building SwarmX: Multi-Agent AI Teams with x402 Micropayments"
2. Pitch guest posts to Nevermined.ai and Chargebee
3. Write a LinkedIn article about x402 + multi-agent AI and tag Dan Kim, Erik Reppel
4. Post on Hacker News: "Show HN: SwarmX" with technical writeup

---

## Priority Matrix

### Immediate (This Week)
| Action | Channel | Expected Impact |
|--------|---------|----------------|
| Submit ecosystem PR to coinbase/x402 | x402.org | HIGH -- official listing + co-marketing |
| Join x402 Discord + Builders Telegram | Community | HIGH -- relationship building |
| DM @dexteraisol for x402sday guest spot | X/Twitter | HIGH -- 200+ listeners per space |
| Post launch thread with #x402 | X/Twitter | MEDIUM -- visibility |
| Register for Solana X402 Hackathon | Hackathon | HIGH -- $135K prizes |

### This Month
| Action | Channel | Expected Impact |
|--------|---------|----------------|
| Write Medium article | Blog | MEDIUM -- SEO + sharing |
| Product Hunt launch | Directory | MEDIUM -- developer discovery |
| Show HN post | Directory | MEDIUM-HIGH -- tech audience |
| Create swarms.world vendor account | Swarms | MEDIUM -- marketplace presence |
| Follow up on ElizaOS PR #322 | ElizaOS | MEDIUM -- plugin discovery |

### Ongoing
| Action | Channel | Expected Impact |
|--------|---------|----------------|
| Weekly #x402 posts on X | X/Twitter | MEDIUM -- consistent presence |
| Engage with x402 community builders | Community | HIGH -- reciprocal promotion |
| Submit to AI tool directories | Directories | LOW-MEDIUM -- long-tail discovery |
| Guest posts on relevant blogs | Blog | MEDIUM -- authority building |
| Participate in hackathons | Hackathon | HIGH -- credibility + prizes |

---

## Key Insight

The x402 ecosystem is still early (22K sellers across all projects). Getting listed on x402.org/ecosystem and getting a guest spot on x402sday Spaces are the two highest-leverage actions. The community is small enough that being a consistent, helpful presence will build relationships with the core team (Coinbase CDP, Dexter AI) and other builders quickly. The Solana X402 Hackathon with $135K in prizes is an especially high-value opportunity.
