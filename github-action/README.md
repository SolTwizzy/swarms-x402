# SwarmX Contract Audit -- GitHub Action

Automatically audit smart contracts on every pull request using 4 AI agents (SecurityAuditor, EconomicAttacker, GasOptimizer, AuditReporter) via the [SwarmX](https://api.swarmx.io) API.

## Usage

```yaml
name: Contract Audit
on:
  pull_request:
    paths:
      - 'contracts/**/*.sol'

permissions:
  contents: read
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: swarmx-org/swarmx-audit@v1
        with:
          files: 'contracts/**/*.sol'
          fail-on-critical: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `files` | No | `**/*.sol` | Glob pattern for contract files to audit |
| `language` | No | `solidity` | Contract language (`solidity` or `rust`) |
| `api-url` | No | `https://api.swarmx.io` | SwarmX API URL |
| `fail-on-critical` | No | `true` | Fail the check if critical issues found |
| `wallet-private-key` | No | -- | Solana private key for paid audits (uses free tier if not set) |

## Outputs

| Output | Description |
|--------|-------------|
| `risk-score` | Overall risk score (0-100) |
| `findings-count` | Total number of findings |
| `report-url` | URL to the PR comment with the full audit report |

## What You Get

The action posts a PR comment with a structured audit report:

- **Summary table** with risk scores and finding counts per file
- **Security findings** with severity levels (critical, high, medium, low)
- **Economic attack vectors** with attack scenario descriptions
- **Gas optimizations** with estimated savings

The check fails if any critical-severity security issue is found (configurable via `fail-on-critical`).

## Free Tier vs Paid

By default the action uses the SwarmX free tier (10 calls/day per IP). For higher volume:

1. Add your Solana private key as a repository secret: `SWARMX_WALLET_KEY`
2. Reference it in your workflow:

```yaml
- uses: swarmx-org/swarmx-audit@v1
  with:
    files: 'contracts/**/*.sol'
    wallet-private-key: ${{ secrets.SWARMX_WALLET_KEY }}
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Each paid audit costs $0.10 USDC, settled via the x402 protocol.

## Rust Contracts (Solana/Anchor)

```yaml
- uses: swarmx-org/swarmx-audit@v1
  with:
    files: 'programs/**/*.rs'
    language: rust
```

## Building from Source

This action's `dist/index.js` is built with `@vercel/ncc`. To rebuild after modifying `src/index.ts`:

```bash
cd github-action
npm install
npm run build
```

This bundles all dependencies into a single `dist/index.js` file that GitHub Actions can execute directly. The compiled `dist/` directory must be committed to the repository for the action to work.

## How It Works

1. Finds contract files matching the glob pattern
2. Sends each file to the SwarmX `/x402/contract-audit` endpoint
3. 4 AI agents analyze the contract in parallel (ConcurrentWorkflow):
   - **SecurityAuditor** -- reentrancy, overflow, access control, etc.
   - **EconomicAttacker** -- flash loans, sandwich attacks, oracle manipulation
   - **GasOptimizer** -- storage patterns, loop efficiency, calldata usage
   - **AuditReporter** -- synthesizes findings into a structured risk report
4. Posts the audit report as a PR comment (updates existing comment on re-runs)
5. Fails the check if critical issues are found

## License

MIT
