# r/solana or r/cryptocurrency Post

**Subreddit:** r/solana or r/cryptocurrency

**Title:** Built a multi-agent AI platform that accepts x402 payments on Solana -- 47 endpoints from $0.001

---

**Body:**

I built SwarmX, an AI agent platform where every API call is paid in USDC via the x402 protocol. No API keys. No accounts. No subscriptions. Just USDC.

**What is x402?**

x402 is an HTTP payment protocol (think of it as HTTP 402 "Payment Required" actually working). When you call a paid endpoint and don't include payment, the server responds with a 402 status code telling you the price, the USDC address, and the network. Your client signs a payment, retries the request with the payment signature, the server verifies on-chain, and returns the response. The Dexter SDK handles this automatically. It works on Solana, Base, Ethereum, Polygon, and Arbitrum.

It's an open protocol -- not our invention. Built by the team at Dexter (backed by Coinbase). We just built a platform on top of it.

**What SwarmX does:**

47 AI endpoints across 9 categories:

- **Smart contract audit** -- 4 agents analyze your Solidity/Rust contract in parallel. Returns risk score, findings by category, and a shareable report URL. Quick scan ($0.03), standard ($0.10), or deep 6-agent audit ($0.25).
- **Token risk scoring** -- Rug pull detection, tokenomics analysis, timeline anomaly detection. SAFE/CAUTION/DANGER verdict. $0.05/call.
- **DeFi protocol risk** -- 5-agent assessment with AAA-to-D credit rating. $2.00/call.
- **Token due diligence** -- 5 agents analyze contract, tokenomics, team, market, and liquidity. Returns APEWORTHY/PROMISING/CAUTION/HIGH_RISK/RUG_LIKELY. $1.00/call.
- **Trading data** -- Token price ($0.001), supply, slot info, recent blockhash. Low-latency, short cache TTLs.
- **Wallet analysis** -- SOL balance, token holdings, DeFi positions, tx history. $0.01-$0.03/call.
- **Memecoin scoring** -- AI-powered rug probability analysis. $0.03/call.

Plus general AI tools: research reports, code review, sentiment analysis, translation, fact-checking, compliance checks.

**Revenue model:**

Every call generates USDC revenue that settles directly to our Solana wallet. No intermediary besides the Dexter facilitator (which verifies payments). We've already processed real payments on mainnet.

**This is not a token launch.** No token. No airdrop. This is infrastructure -- a platform that sells AI agent services for USDC micropayments. Open source, deployed on Railway.

**Try it free:**

First 5 calls per day per IP are free. No wallet needed. Just curl:

```
curl -X POST https://swarmx.io/x402/sentiment \
  -H "Content-Type: application/json" \
  -d '{"text": "Solana TPS is going parabolic"}'
```

Playground (no login): https://swarmx.io
GitHub: https://github.com/swarmx-org/swarms-x402

Happy to answer questions about x402 integration, the payment flow, or how multi-agent orchestration works under the hood.
