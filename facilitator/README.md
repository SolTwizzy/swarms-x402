# swarmx-rh-facilitator

Self-hosted **x402 payment facilitator** for **Robinhood Chain** (`eip155:4663`), settling
**USDG** (Global Dollar, Paxos) via **EIP-3009 `transferWithAuthorization`**.

This is a **standalone** service (its own `package.json` / `node_modules`, its own Bun
process). It is **not** part of the main SwarmX build — the root `tsconfig.json` only
includes `src/**/*`, so nothing here affects `bun run build`. It exists because the Dexter
x402 SDK the main server uses only settles on Base + Solana; RH Chain needs a facilitator we
host ourselves.

> Phase 2a status: **`/verify` works end-to-end in a dry run. `/settle` is code-complete but
> gated OFF** — it will not broadcast until it is explicitly enabled with a funded signer.
> No funds have been moved. See "Settle prerequisite" below.

---

## On-chain evidence (verified, not assumed)

All confirmed by read-only RPC against `https://rpc.mainnet.chain.robinhood.com`. Reproduce
with `bun run check:chain`.

| Fact | Value | How verified |
|---|---|---|
| Chain id | `0x1237` = **4663** | `eth_chainId` |
| USDG token | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `name()` = "Global Dollar", `symbol()` = "USDG", `decimals()` = **6** |
| USDG is a proxy | EIP-1967, impl `0x68184c449e1a8f34fa18d289737129fd27b66f8f` | impl slot `eth_getStorageAt` |
| **EIP-3009 support** | **YES** | `authorizationState(addr,nonce)` returns bool on the proxy; `transferWithAuthorization`/`cancelAuthorization` are routed (empty-revert on bad input) while an unknown selector reverts `0x800ab12c` |
| **EIP-2612 support** | **YES** | `PERMIT_TYPEHASH()` returns the canonical `0x6e71edae…6126c9`; `nonces(addr)` returns a uint |
| USDG EIP-712 domain | `{ name:"Global Dollar", version:"1", chainId:4663, verifyingContract:0x5fc5360D… }` | reconstructed `DOMAIN_SEPARATOR` matches on-chain `0x7a3d7400…62036` exactly (`bun run check:domain`) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3`, **9152 bytes, deployed** | `eth_getCode` (canonical bytecode) |
| Gas price | ~0.053 gwei | `eth_gasPrice` |

**Key finding:** USDG implements EIP-3009, contradicting the original assumption that Paxos
tokens don't. So we use the **EIP-3009 path** (same scheme USDC uses) — simpler than Permit2:
no prior `approve`, no Permit2 dependency, no proxy contract to deploy. Permit2 remains a
documented fallback (see below) but is not used.

---

## Settlement mechanism

**Primary (implemented): EIP-3009.** The payer signs a gasless `TransferWithAuthorization`
(EIP-712) over the USDG domain. The facilitator's funded signer submits
`transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)` to USDG; USDG
verifies the signature on-chain and moves `value` USDG from `from` to `payTo`. The payer
needs **no ETH and no prior approval**; the facilitator pays gas.

**Fallback (documented, not implemented): Permit2 `permitTransferFrom`.** Only needed for a
token lacking EIP-3009. Requires the payer to pre-`approve` Permit2, and (for the x402
witness flow) a `x402ExactPermit2Proxy` deployed on 4663. Since USDG has EIP-3009, skip it.

---

## Wire protocol (x402 v1 "exact")

Spec-compatible with the reference `x402@1.2.0` schemas, so standard x402 clients interoperate.

- `network`: **`eip155:4663`** (CAIP-2). The network string is a routing hint only — it is not
  part of the signed EIP-3009 data; only the numeric `chainId: 4663` enters the EIP-712 domain.
  (Stock `x402@1.2.0` hard-codes a closed network enum that excludes 4663, which is one reason
  we self-host rather than use its facilitator — see the research note in the parent task.)
- `PaymentRequirements.extra` carries the token EIP-712 domain: `{ name:"Global Dollar", version:"1" }`.
- EIP-712 type: `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`.

### Endpoints
- `GET  /health` — status + config.
- `GET  /supported` — `{ kinds: [{ x402Version:1, scheme:"exact", network:"eip155:4663", extra }] }`.
- `POST /verify` — body `{ paymentPayload, paymentRequirements }` → `{ isValid, invalidReason?, payer? }`. No funds; can run with no RPC in dry mode.
- `POST /settle` — same body → `{ success, transaction, network, payer?, errorReason? }`. **Gated** (see below).

---

## Run

```bash
cd facilitator
bun install

bun run check:chain    # read-only on-chain evidence
bun run check:domain   # confirm USDG EIP-712 version
bun run verify:dry     # full /verify dry-run test (no funds) — expect "ALL PASS — 7 passed"
bun run start          # serve on :4021 (PORT overridable)
```

Dry-run test result (7/7):

```
A accept-valid                     isValid=true
B reject-tampered-signature        invalid_exact_evm_payload_signature
C reject-inflated-value            invalid_exact_evm_payload_signature   (can't inflate value without re-signing)
D reject-wrong-recipient           invalid_exact_evm_payload_recipient_mismatch
E reject-expired                   invalid_exact_evm_payload_authorization_valid_before
F onchain-insufficient-funds       insufficient_funds   (real RPC read against 4663)
G settle-gated-no-broadcast        settle_disabled_no_funded_signer, tx=""
```

---

## Money-safety / settlement gate

`/settle` is the only code path that can spend funds. It is **triple-gated** and does nothing
by default:

1. `FACILITATOR_SETTLE_ENABLED` must be exactly `"true"`. Otherwise `/settle` returns
   `settle_disabled_no_funded_signer` **before** loading any key or touching the signer.
2. The signer (`EVM_PRIVATE_KEY`) must hold ETH for gas on 4663; a zero balance returns
   `signer_unfunded_no_gas` with no broadcast.
3. The payment must re-verify on-chain (balance + unused nonce) immediately before broadcast.

The broadcast line in `src/settle.ts` is marked
`vvv BELOW THIS LINE REQUIRES REAL FUNDS ON CHAIN 4663 vvv`. The private key is never read at
import time and never logged.

### Settle prerequisite (needs real funds — requires explicit go)

Signer `0xD421e2Cb3dF59F25AB1574E271a8b291665Ba439` currently holds **0 ETH and 0 USDG** on
4663 (`check:chain`). To run one real `/settle` of a $0.01 payment:

- **~0.01 USDG** in the *payer's* wallet (the buyer signs the authorization; for an internal
  end-to-end test the payer can be this same wallet). Fund with **~$1 USDG** = ~100 tests at $0.01.
- **ETH for gas in the signer** `0xD421…Ba439`. One `transferWithAuthorization` is a normal
  ERC-20-style write; at ~0.053 gwei even a generous 150k-gas estimate is ~8e-6 ETH
  (fractions of a cent). **~$1 of ETH** covers dozens of settles comfortably.

Total: **~$2** (≈ $1 USDG + ≈ $1 ETH) on chain 4663 is more than enough for the funded settle
test. Then set `FACILITATOR_SETTLE_ENABLED=true` and `EVM_PRIVATE_KEY`, and POST a valid
payment to `/settle`.

---

## Known limitations (Phase 2a)

- **EOA signatures only.** Smart-wallet (ERC-1271 / ERC-6492) payers are not yet verified; the
  x402 test buyer is an EOA. Add the 1271 path before accepting smart-wallet buyers.
- **Single token/chain by design.** Hard-wired to USDG on 4663 so it can't be misconfigured.
- **No settle proof yet.** `/settle` is unexecuted pending funds (see prerequisite).
- `authorizationState` replay-check is best-effort at verify time; the token enforces it
  authoritatively on-chain at settle.

---

## Files

```
facilitator/
  package.json          isolated deps (hono, viem, @types/bun)
  tsconfig.json         isolated; not in the main build
  .env.example
  src/
    config.ts           chain/token constants, dry-run + settle gates
    chain.ts            viem public client (eager) + lazy settlement signer
    usdg.ts             USDG ABI subset + EIP-3009 typed-data
    types.ts            x402 v1 "exact" wire types
    verify.ts           signature recovery + field + (optional) on-chain checks
    settle.ts           gated EIP-3009 broadcast (money path)
    server.ts           Hono app: /health /supported /verify /settle
    index.ts            Bun entry
  scripts/
    check-chain.ts      read-only on-chain evidence
    check-domain.ts     confirm USDG EIP-712 domain version
    verify-drytest.ts   7-case /verify dry-run (no funds)
```
