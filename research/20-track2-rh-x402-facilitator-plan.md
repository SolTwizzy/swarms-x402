# Track 2 — Robinhood-Chain x402 Facilitator Plan

Goal: SwarmX gets **paid natively on Robinhood Chain** (chainId 4663) for its RWA endpoints, settled in **USDG** via **Permit2**. This is the differentiated rail: "an AI agent service that settles on Robinhood Chain, ~2 weeks after the chain launched."

## The core architecture problem
Our server currently uses `@dexterai/x402` for the sell-side 402/verify/settle. **Dexter's facilitator only serves Base + Solana** — it cannot settle on RH Chain. So RH-Chain payments require us to **self-host a facilitator** and add a parallel resource-server path using the **Coinbase x402** packages (which support "dynamic network registration — any EVM chain"). Dexter stays for Base/Solana; the new facilitator handles chain 4663. The two coexist.

## Verified building blocks (on-chain confirmed)
- Chain: **eip155:4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, ETH gas, gasPrice ~0.058 gwei (~$0.026/settlement tx).
- Settlement token: **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Paxos). Deployed (proxy).
- **Permit2** deployed at canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` (9152 bytes) → gasless-signature ERC-20 settlement path is available.
- Uniswap v2/v3/v4 + UniswapX live (Permit2 is battle-tested here).
- Our EVM wallet (works on RH Chain): `0xD421e2Cb3dF59F25AB1574E271a8b291665Ba439` (`EVM_PRIVATE_KEY` in `.env`).
- Facilitator lib candidates: **`x402-facilitator-hono`** (Bun, wraps Coinbase x402 packages — fits our stack) / thirdweb x402 (170+ chains) / `x402-rs`.

## Components to build
1. **Facilitator service** (self-hosted, Bun, on the VPS): configured for chain 4663 + USDG + Permit2. Exposes `/verify` and `/settle`. Holds a funded signer (ETH for gas) that submits `permitTransferFrom` settlement txs. Runs as its own container on the `coolify` network (internal), next to `swarmx-app`.
2. **Resource-server integration** (in `server.ts`): the RWA endpoints emit an x402 **402 challenge** whose `accepts` array includes `{ scheme:"exact", network:"eip155:4663", asset:USDG, payTo:0xD421…, maxAmountRequired, ... }`, and delegate verify/settle to our facilitator URL. Use the Coinbase `x402` EVM `exact`/Permit2 scheme (not the Dexter SDK) for this network.
3. **Test buyer script**: an x402 client that pays $0.01 USDG on 4663 (signs Permit2) to prove end-to-end.

## Sequencing (delegated to Codex/Opus after Track 1)
- **2a — Facilitator in isolation (de-risk first).** Stand up `x402-facilitator-hono` for 4663+USDG+Permit2. Confirm the two unknowns below. Dry-`verify` needs no funds; a real `settle` needs the funded signer.
- **2b — Resource-server RH-Chain 402 path.** Add the eip155:4663 payment option to the RWA endpoints, delegating to our facilitator. Keep Base/Solana (Dexter) working unchanged.
- **2c — End-to-end proof.** Test buyer pays $0.01 USDG for `/x402/rwa/stock-dd`; confirm the on-chain settlement tx + endpoint unlock. Screenshot/tx-hash = the launch proof.

## Unknowns to resolve IN 2a (do not assume — verify on-chain / in the lib)
- **USDG settlement mechanism:** does USDG implement **EIP-3009** (`transferWithAuthorization`, USDC-style gasless)? Paxos tokens historically do NOT → we default to the **Permit2** path (`permitTransferFrom` with an off-chain signature; no prior approve needed). Confirm by reading the USDG contract / Paxos docs.
- **Facilitator custom-token support:** confirm `x402-facilitator-hono` (Coinbase x402) will settle an **arbitrary ERC-20 (USDG) via Permit2** on a **custom chain (4663)**, not just USDC. If it hard-codes USDC/EIP-3009, either configure the Permit2 path or fall back to thirdweb's facilitator.
- **Network string:** standardize on CAIP-2 `eip155:4663` across facilitator + server + buyer.

## The one prerequisite (needs your explicit go — real money)
Fund `0xD421…Ba439` on **RH Chain** with ~**$1 USDG** (for test payments; we set price to $0.01 = 100 tests) + ~**$1 ETH** (facilitator gas; ~38 settles). Path: bridge ~$2 **USDC from our Solana wallet** (`SOLANA_PRIVATE_KEY` in `.env`, ~$13 there) via Across/LI.FI relayer → USDG + ETH on 4663. Executing a bridge = an irreversible on-chain spend → I will NOT move funds without an explicit "go".

## Risk note (be honest)
RH Chain is ~11 days old. x402 facilitator support for a brand-new custom chain + USDG's exact Permit2/EIP-3009 semantics are **unproven** — 2a is exploratory and may hit snags. That's why 2a de-risks the facilitator in isolation before we wire it to the product. Track 1 (product) is independent and low-risk; Track 2 is the higher-variance bet.

## Acceptance criteria
- Facilitator `/verify` + `/settle` work for USDG on 4663 (2a).
- `/x402/rwa/stock-dd` returns a valid 402 with an eip155:4663 option and unlocks after a real USDG payment (2b/2c).
- A real settlement tx hash on RH Chain for a $0.01 payment, endpoint returns the DD report. Base/Solana paths still work.
