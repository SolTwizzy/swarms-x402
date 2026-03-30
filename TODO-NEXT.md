# eliza-x402-swarms — Next Steps

> Post-MVP tasks. All 5 original TODO items and all 5 roadmap phases are complete.

---

## Run Live

### 1. Fill in `.env` with real keys
- Fund a wallet with USDC on Base Sepolia (testnet) or mainnet
- Set `EVM_PRIVATE_KEY` or `SOLANA_PRIVATE_KEY`
- Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

### 2. Run smoke tests
```bash
bun run test:smoke
```
Verifies OpenDexter marketplace API is reachable.

### 3. Test against a real x402 endpoint
Make a paid API call end-to-end. Verify tx hash is real on-chain.

### 4. Fund wallets with USDC for live testing
- Get testnet USDC from Base Sepolia faucet
- Test full buy-process-sell loop with SignalHawk
- Verify on-chain settlement via block explorer

---

## Ship

### 5. Publish to npm
```bash
npm publish --access public
```
Package: `@elizaos/plugin-x402-swarms`

### 6. Add CI/CD (GitHub Actions)
- Workflow: build + test on push/PR
- Smoke tests on schedule (daily) or `workflow_dispatch`
- No secrets needed for unit tests
- Auto-publish to npm on tagged releases

### 7. Register in elizaos-plugins
- Submit to the ElizaOS plugin registry (`elizaos-plugins` GitHub org)
- Follow plugin-specification format

### 8. Deploy to Railway/Docker
- Containerize with Dockerfile (Bun runtime)
- Deploy to Railway with env vars configured
- Expose x402 sell endpoints publicly
- Monitor with health check route (`/x402/health`)

---

## Completed

### Server-side x402 middleware (sell services)
- Used `@dexterai/x402/server` (`x402Gate`, `X402ServerService`)
- Agent exposes its own x402-protected endpoints (5 routes)
- Auto-registers on OpenDexter marketplace via `/x402/catalog`

### Event hooks for payment analytics
- Registered `ACTION_COMPLETED` events in plugin `events` field
- Track payment success/failure rates, popular endpoints, spend patterns
- Persisted to DB via Drizzle schemas (paymentHistory, endpointScores, budgetState)

### Custom HTTP routes
- Exposed `/x402/catalog` -- list sellable endpoints (discovery)
- Exposed `/x402/health` -- service status
- Exposed `/x402/research`, `/x402/analyze`, `/x402/agent`, `/x402/swarm` -- paid endpoints
- Added via plugin `routes` field (v2 feature)
