# eliza-x402-swarms — TODO

> Priority-ordered task list with implementation plans. Generated 2026-03-19.

---

## 1. Update Example Agent for Dexter SDK
**Priority:** P0 (blocking — can't demo without it)
**Complexity:** Small
**File:** `examples/basic-agent.ts`

The example still references Coinbase CDP keys and a v1.0 `AgentRuntime` constructor that no longer exists in `@elizaos/core` 1.7.2.

### Implementation Steps

1. **Fix imports** — Remove `ModelProviderName` (doesn't exist in 1.7.x). Add `import "dotenv/config"` for `.env` loading (dotenv is a transitive dep of `@elizaos/core`).
2. **Update character settings** — Replace `CDP_API_KEY_NAME`/`CDP_API_KEY_PRIVATE_KEY` with `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `X402_BUDGET_USD`.
3. **Fix AgentRuntime constructor** — Remove `modelProvider` and `token` params. Use `{ character, plugins: [x402SwarmsPlugin], settings: { ANTHROPIC_API_KEY, OPENAI_API_KEY } }`.
4. **Update doc comment** — Change required env vars to match `.env.example`.
5. **Add service verification** — Log `runtime.services.keys()` after init to confirm `X402_WALLET` registered.

### Verification
```bash
bun run example   # should print agent name + available actions
```
With no wallet keys: service logs a warning but doesn't crash.

---

## 2. Wire Up Real x402 Payments (Replace Mocks)
**Priority:** P0 (core functionality)
**Complexity:** Medium
**Files:** `x402WalletService.ts`, `payForService.ts`, `delegateToSwarm.ts`, `types.ts`

The payment flow works structurally but has gaps: GET-only requests, synthetic tx hashes, unbudgeted swarm calls, no Access Pass support, generic error handling.

### Implementation Steps

#### 2a. Generalize `payForResource()` — `x402WalletService.ts`
1. Add optional `RequestInit` parameter (method, headers, body) so callers can POST.
2. Import `getPaymentReceipt` from `@dexterai/x402/client` — extract real on-chain tx hash + network from `PAYMENT-RESPONSE` header.
3. Remove synthetic `dexter-${timestamp}` hash. Return `receipt.transaction` or `"no-payment-required"`.
4. Update return type to include `network`, `payer`, full `PaymentReceipt`.
5. Store `runtime` ref during `initialize()` for structured logging on every payment.

#### 2b. Add Access Pass support — `x402WalletService.ts`
1. Read new env vars: `X402_ACCESS_PASS_TIER` (e.g. `"1h"`) and `X402_ACCESS_PASS_MAX_SPEND` (e.g. `"2.00"`).
2. When set, add `accessPass: { preferTier, maxSpend }` to `WrapFetchOptions`.
3. SDK handles the rest: auto-buys pass on first call, reuses cache on subsequent calls.

#### 2c. Add HTTP method/body support — `payForService.ts`
1. Extend `PaySchema` with optional `method` (`"GET"|"POST"|"PUT"|"DELETE"`, default `"GET"`), `body`, `headers`.
2. Update LLM extraction prompt to also extract method/body.
3. Pass through to `walletService.payForResource(endpoint, { method, headers, body })`.
4. Display real tx hash and network in callback.

#### 2d. Fix `delegateToSwarm` — `delegateToSwarm.ts`
1. Switch from `walletService.getX402Fetch()` (unbudgeted) to `walletService.payForResource()` (budget-enforced) with POST payload.
2. Fix cost calculation: use `receipt.amountUsd` (delta), not `walletService.getTotalSpentUsd()` (cumulative).
3. Add Zod schema for swarm response validation. Fall back to raw text on parse failure.
4. Use response `id` field or real tx hash instead of `crypto.randomUUID()` for taskId.

#### 2e. Structured error handling — all 3 files
1. Import `X402Error` from `@dexterai/x402/client`.
2. In `payForResource()`, catch `X402Error` and map error codes to user-friendly messages:
   - `insufficient_balance` → "Fund your wallet with USDC on Base"
   - `amount_exceeds_max` → "Payment exceeds per-request limit"
   - `payment_rejected` → "Budget exhausted or domain blocked"
   - `facilitator_settle_failed` → "On-chain settlement failed"
   - `facilitator_timeout` / `rpc_timeout` → "Network timeout, retry may succeed"
3. Surface these in action callback error messages.

#### 2f. Update types — `types.ts`
1. Add `accessPassTier?: string` and `accessPassMaxSpend?: string` to `X402PaymentConfig`.
2. Add `network` and `payer` fields to `PaymentRecord`.
3. Add `SwarmAPIResponse` interface for typed parsing.

### Verification
- Build passes: `bun run build`
- With funded wallet + real x402 endpoint: payment executes, real tx hash returned
- Budget account rejects payments above per-request limit
- Access pass auto-purchases on repeated calls to same endpoint

---

## 3. Add Test Suite
**Priority:** P1 (quality gate)
**Complexity:** Medium-Large
**Files:** New `tests/` directory, `vitest.config.ts`

No tests exist. Need unit tests for each component, integration test for the full plugin, and a smoke test hitting the real OpenDexter marketplace.

### Implementation Steps

#### 3a. Infrastructure
1. Create `vitest.config.ts` — include `tests/**/*.test.ts`, environment `node`, globals `true`, mockReset `true`, timeout `30000`.
2. Create `tests/setup.ts` — shared mock factories:
   - `createMockRuntime()` — partial `IAgentRuntime` with `getSetting`, `getService`, `useModel`, `logger`
   - `createMockWalletService()` — mock `X402WalletService` with controllable `BudgetAccount`
   - `createMockBudgetAccount()` — mock with mutable `spentAmount`, `remaining`, `ledger`
   - `createMockCallback()`, `createMockMessage(text)`
3. Create `tests/fixtures.ts` — mock `DiscoveredAPI[]`, `PaymentRecord[]`, default settings map.
4. Update `package.json` scripts: `"test:unit"`, `"test:smoke"`.

#### 3b. Unit Tests (~53 cases across 6 files)

| File | Tests | Key Coverage |
|------|-------|-------------|
| `tests/services/x402WalletService.test.ts` | 11 | Init with EVM/Solana/no key, network mapping, budget calc, payForResource, stop |
| `tests/actions/discoverServices.test.ts` | 8 | Validate always true, searchAPIs call, query passthrough, empty results, error handling |
| `tests/actions/payForService.test.ts` | 11 | Validate with/without keys, LLM extraction, Zod parse, payment success/failure, response truncation |
| `tests/actions/delegateToSwarm.test.ts` | 11 | Default/custom endpoint, POST payload, SWARMS_API_KEY header, JSON/text response, error |
| `tests/providers/x402Provider.test.ts` | 5 | No service, full context, recent payments, empty history, null budget |
| `tests/evaluators/paymentEvaluator.test.ts` | 7 | Validate, 80% budget warning, no warning below, 10-payment summary |

**Mocking strategy:**
- Actions mock the wallet service (Layer 2), not the SDK directly
- Wallet service tests mock `@dexterai/x402/client` (Layer 1) via `vi.mock`
- Smoke tests use real SDK (Layer 3)

#### 3c. Integration Test (5 cases)
`tests/integration/plugin.test.ts` — Plugin shape validation, service type check, full flow (discover → pay → evaluate), provider context reflects state.

#### 3d. Smoke Test (5 cases, network-dependent)
`tests/smoke/marketplace.test.ts` — Real `searchAPIs()` calls. Gated by `RUN_SMOKE=true` env var. No wallet keys needed (just HTTP GET to marketplace). Uses `test.retry(2)` for flakiness.

### File Layout
```
tests/
  setup.ts
  fixtures.ts
  services/x402WalletService.test.ts
  actions/discoverServices.test.ts
  actions/payForService.test.ts
  actions/delegateToSwarm.test.ts
  providers/x402Provider.test.ts
  evaluators/paymentEvaluator.test.ts
  integration/plugin.test.ts
  smoke/marketplace.test.ts
vitest.config.ts
```

### Verification
```bash
bun run test           # all unit + integration (no network)
bun run test:smoke     # marketplace smoke test (needs network)
```

---

## 4. Upgrade to ElizaOS v2
**Priority:** P2 (enhancement — v1.7.x works, v2 is alpha)
**Complexity:** Medium
**Risk:** Low-Medium (v2 alpha may have instability)

The v2 API is largely backward-compatible for plugins. Main changes: action handlers must return `ActionResult`, Zod v3→v4, example rewrite.

### Implementation Steps

#### 4a. Update dependencies — `package.json`
1. `"@elizaos/core"`: `"^1.0.0"` → `"^2.0.0-alpha.32"` (both `dependencies` and `peerDependencies`)
2. `"zod"`: `"^3.22.0"` → `"^4.3.5"` (required by v2 core; basic `z.object`/`z.string`/`z.parse`/`z.infer` API unchanged)
3. Run `bun install`, verify resolution.

#### 4b. Action handlers return `ActionResult` — 3 action files
For each action (`payForService`, `discoverServices`, `delegateToSwarm`):
1. Import `ActionResult` from `@elizaos/core`.
2. Change handler return type from `Promise<void>` to `Promise<ActionResult>`.
3. Add `return { success: true, text, data }` on success paths.
4. Add `return { success: false, error }` on error paths.
5. Change `_options` param type to `HandlerOptions`.

#### 4c. Verify Service class — `x402WalletService.ts`
Already compatible. Optional: add `static async stop(runtime)` to match v2 convention:
```typescript
static async stop(runtime: IAgentRuntime): Promise<void> {
  const service = runtime.getService<X402WalletService>("X402_WALLET");
  if (service) await service.stop();
}
```

#### 4d. Verify Provider — `x402Provider.ts`
No changes needed. `Provider.get` returning `ProviderResult` is unchanged.

#### 4e. Verify Evaluator — `paymentEvaluator.ts`
Optional: return `{ success: true }` instead of `void` for consistency.

#### 4f. Verify Plugin definition — `index.ts`
Already v2-compatible. Optional: add `events` field for payment tracking via `ACTION_COMPLETED`.

#### 4g. Rewrite example — `examples/basic-agent.ts`
Restructure as `Project`/`ProjectAgent` pattern:
```typescript
import type { Project, ProjectAgent } from "@elizaos/core";
const agent: ProjectAgent = { character, plugins: [x402SwarmsPlugin] };
export const project: Project = { agents: [agent] };
export default project;
```

#### 4h. Create v1 compatibility branch
Before starting: `git branch v1-compat` for rollback.

### Verification
```bash
bun install && bun run build     # clean compile
bun run test                      # all tests pass
bun run example                   # agent starts
```

### Breaking Changes Watchlist

| Change | Impact | Files |
|--------|--------|-------|
| Action handler returns `ActionResult` | High — 3 files | `payForService.ts`, `discoverServices.ts`, `delegateToSwarm.ts` |
| Zod v3 → v4 | Low — basic API same | `payForService.ts`, `delegateToSwarm.ts` |
| `ModelProviderName` removed | Low — example only | `examples/basic-agent.ts` |
| `AgentRuntime` constructor changed | Low — example only | `examples/basic-agent.ts` |
| `HandlerOptions` type for options param | Cosmetic | All action handlers |

---

## 5. Observability & Logging Improvements
**Priority:** P3 (polish)
**Complexity:** Small
**Files:** `x402WalletService.ts`, `delegateToSwarm.ts`, `paymentEvaluator.ts`, `x402Provider.ts`

### Implementation Steps

1. **Log every payment with receipt data** — In `payForResource()`, log endpoint, txHash, network, payer, amountUsd, remainingBudget.
2. **Log swarm response metrics** — In `delegateToSwarm`, log status + token usage before/after call.
3. **Add hourly spend tracking** — In `paymentEvaluator`, warn when `hourlySpend` > 80% of per-hour budget (via `BudgetAccount.hourlySpend`).
4. **Show access pass status in provider** — In `x402Provider`, include whether an access pass is active.

---

## Completed Tasks

- [x] Generate `.env` from `.env.example` (2026-03-19)
- [x] Install dependencies with Bun (2026-03-19)
- [x] Fix `@coinbase/x402` version (`^0.1.0` → `^2.1.0`) (2026-03-19)
- [x] Fix `@elizaos/core` 1.7.x API compatibility (Service, Handler, Provider, etc.) (2026-03-19)
- [x] Swap Coinbase x402 for Dexter SDK (`@dexterai/x402@^2.0.0`) (2026-03-19)
- [x] Update `/elizaos` skill with question mode + v2 research (2026-03-19)
- [x] Build passes (`bun run build` → clean tsc) (2026-03-19)
- [x] Push to GitHub (2026-03-19)
- [x] Update example agent for Dexter SDK (2026-03-19)
- [x] Wire up real payments: getPaymentReceipt, POST support, X402Error handling, Access Pass, hourly spend (2026-03-19)
- [x] Add test suite: 162 unit/integration + 5 smoke tests across 9 files (2026-03-19)
- [x] Upgrade to ElizaOS v2 (`@elizaos/core@2.0.0-alpha.32`) — ActionResult returns, ContentValue types (2026-03-19)
- [x] Observability: structured payment logging, hourly spend tracking, access pass status in provider (2026-03-19)
- [x] Integrate real Swarms multi-agent orchestration via swarms-ts SDK — 15+ swarm architectures, 4 actions, 2 services (2026-03-26)
- [x] Update all documentation: README.md, ARCHITECTURE.md, TODO.md to reflect current codebase (2026-03-26)
- [x] Swarm templates: 4 opinionated templates with keyword detection + LLM classification (Phase 1) (2026-03-26)
- [x] x402+Swarm bridge: paid data feeds into swarm analysis with re-run support (Phase 2) (2026-03-26)
- [x] Server-side x402 sell services: 5 routes, x402Gate, X402ServerService, revenue provider (Phase 3) (2026-03-26)
- [x] SignalHawk agent example: buy data, MajorityVoting swarm, sell signals via x402 (Phase 4) (2026-03-26)
- [x] Persistence & learning with Drizzle schemas: payment history, endpoint scores, budget state (Phase 5) (2026-03-26)
