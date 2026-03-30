#!/usr/bin/env bun
/**
 * SwarmX Gallery Generator
 *
 * Calls LIVE SwarmX endpoints to produce real audit results,
 * saves them to scripts/gallery-results.json, and prints formatted output.
 *
 * Uses the free tier (10 calls/day) — no payment required.
 *
 * Usage:
 *   bun run scripts/generate-gallery.ts
 *   bun run scripts/generate-gallery.ts --local   (use localhost:3000)
 */

const PROD_URL = "https://api.swarmx.io";
const LOCAL_URL = "http://localhost:3000";
const useLocal = process.argv.includes("--local");
const BASE_URL = useLocal ? LOCAL_URL : PROD_URL;

import { writeFileSync } from "fs";
import { join } from "path";

// ── Terminal formatting ─────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

function hr(): void {
  console.log(DIM + "─".repeat(72) + RESET);
}

function riskColor(score: number): string {
  if (score >= 61) return RED;
  if (score >= 26) return YELLOW;
  return GREEN;
}

function verdictColor(verdict: string): string {
  if (verdict === "DANGER") return RED;
  if (verdict === "CAUTION") return YELLOW;
  return GREEN;
}

// ── Contract code samples ───────────────────────────────────────────────────

const REENTRANCY_CONTRACT = `// Vulnerable to reentrancy
pragma solidity ^0.8.0;

contract VulnerableBank {
    mapping(address => uint) public balances;

    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() public {
        uint amount = balances[msg.sender];
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success);
        balances[msg.sender] = 0;
    }
}`;

const ANCHOR_VAULT = `// Missing authority/signer checks
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[program]
pub mod vulnerable_vault {
    use super::*;

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        token::transfer(ctx.accounts.transfer_ctx(), amount)?;
        vault.balance -= amount;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: Account<'info, VaultState>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultState {
    pub balance: u64,
}`;

const ERC20_APPROVE = `// ERC20 approve race condition
pragma solidity ^0.8.0;

contract SimpleToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    // Vulnerable: front-running race condition on approve
    // If Alice changes approval from 100 to 50, Bob can:
    //   1. See the pending tx
    //   2. Quickly spend the old 100 allowance
    //   3. Then spend the new 50 allowance (150 total)
    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        require(balanceOf[from] >= amount, "Insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}`;

// ── Audit requests ──────────────────────────────────────────────────────────

interface AuditRequest {
  name: string;
  description: string;
  code: string;
  language: string;
}

const AUDITS: AuditRequest[] = [
  {
    name: "Reentrancy Vulnerability",
    description: "Solidity bank contract with classic reentrancy bug — state updated after external call",
    code: REENTRANCY_CONTRACT,
    language: "solidity",
  },
  {
    name: "Anchor Vault Missing Checks",
    description: "Solana/Anchor token vault with no authority validation — anyone can withdraw",
    code: ANCHOR_VAULT,
    language: "anchor",
  },
  {
    name: "ERC20 Approve Race Condition",
    description: "Standard ERC20 approve function vulnerable to front-running allowance manipulation",
    code: ERC20_APPROVE,
    language: "solidity",
  },
];

interface GalleryResult {
  type: "contract-audit" | "token-risk";
  name: string;
  description: string;
  timestamp: string;
  durationMs: number;
  priceUsd: string;
  response: Record<string, unknown>;
  error?: string;
}

async function callEndpoint(
  path: string,
  body: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; durationMs: number; error?: string }> {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - start;
    const data = (await resp.json()) as Record<string, unknown>;

    if (!resp.ok) {
      return { data, durationMs, error: `HTTP ${resp.status}: ${JSON.stringify(data)}` };
    }
    return { data, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    return { data: null, durationMs, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}SwarmX Gallery Generator${RESET}`);
  console.log(`${DIM}Target: ${BASE_URL}${RESET}\n`);

  const results: GalleryResult[] = [];

  // ── Contract Audits ─────────────────────────────────────────────────────
  for (const audit of AUDITS) {
    hr();
    console.log(`${BOLD}${BLUE}CONTRACT AUDIT: ${audit.name}${RESET}`);
    console.log(`${DIM}${audit.description}${RESET}`);
    console.log(`${DIM}Calling POST /x402/contract-audit ...${RESET}\n`);

    const { data, durationMs, error } = await callEndpoint("/x402/contract-audit", {
      code: audit.code,
      language: audit.language,
    });

    if (error) {
      console.log(`${RED}ERROR: ${error}${RESET}\n`);
      results.push({
        type: "contract-audit",
        name: audit.name,
        description: audit.description,
        timestamp: new Date().toISOString(),
        durationMs,
        priceUsd: "0.10",
        response: data ?? {},
        error,
      });
      continue;
    }

    const riskScore = (data?.riskScore as number) ?? 0;
    const findings = (data?.findings as Record<string, unknown[]>) ?? {};
    const summary = (data?.summary as string) ?? "";
    const secCount = Array.isArray(findings.security) ? findings.security.length : 0;
    const econCount = Array.isArray(findings.economic) ? findings.economic.length : 0;
    const gasCount = Array.isArray(findings.gas) ? findings.gas.length : 0;
    const totalFindings = secCount + econCount + gasCount;

    const rc = riskColor(riskScore);
    console.log(`  ${BOLD}Risk Score: ${rc}${riskScore}/100${RESET}`);
    console.log(`  ${BOLD}Findings:${RESET} ${RED}${secCount} security${RESET} | ${YELLOW}${econCount} economic${RESET} | ${CYAN}${gasCount} gas${RESET} (${totalFindings} total)`);
    console.log(`  ${DIM}Summary: ${summary.slice(0, 200)}${RESET}`);
    console.log(`  ${DIM}Duration: ${(durationMs / 1000).toFixed(1)}s | Cost: $0.10${RESET}\n`);

    results.push({
      type: "contract-audit",
      name: audit.name,
      description: audit.description,
      timestamp: new Date().toISOString(),
      durationMs,
      priceUsd: "0.10",
      response: data!,
    });
  }

  // ── Token Risk: USDC ──────────────────────────────────────────────────────
  hr();
  console.log(`${BOLD}${MAGENTA}TOKEN RISK: USDC (should be SAFE)${RESET}`);
  console.log(`${DIM}Mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v${RESET}`);
  console.log(`${DIM}Calling POST /x402/token-risk ...${RESET}\n`);

  const { data: tokenData, durationMs: tokenMs, error: tokenErr } = await callEndpoint(
    "/x402/token-risk",
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chain: "solana" }
  );

  if (tokenErr) {
    console.log(`${RED}ERROR: ${tokenErr}${RESET}\n`);
    results.push({
      type: "token-risk",
      name: "USDC Token Risk",
      description: "Risk assessment for USDC (Circle) — expected verdict: SAFE",
      timestamp: new Date().toISOString(),
      durationMs: tokenMs,
      priceUsd: "0.05",
      response: tokenData ?? {},
      error: tokenErr,
    });
  } else {
    const verdict = (tokenData?.verdict as string) ?? "UNKNOWN";
    const riskScore = (tokenData?.riskScore as number) ?? 0;
    const summary = (tokenData?.summary as string) ?? "";
    const vc = verdictColor(verdict);

    console.log(`  ${BOLD}Verdict: ${vc}${verdict}${RESET}`);
    console.log(`  ${BOLD}Risk Score: ${riskColor(riskScore)}${riskScore}/100${RESET}`);
    console.log(`  ${DIM}Summary: ${summary.slice(0, 200)}${RESET}`);
    console.log(`  ${DIM}Duration: ${(tokenMs / 1000).toFixed(1)}s | Cost: $0.05${RESET}\n`);

    results.push({
      type: "token-risk",
      name: "USDC Token Risk",
      description: "Risk assessment for USDC (Circle) — expected verdict: SAFE",
      timestamp: new Date().toISOString(),
      durationMs: tokenMs,
      priceUsd: "0.05",
      response: tokenData!,
    });
  }

  // ── Save results ──────────────────────────────────────────────────────────
  hr();
  const outPath = join(import.meta.dir, "gallery-results.json");
  const gallery = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    results,
  };
  writeFileSync(outPath, JSON.stringify(gallery, null, 2));
  console.log(`${GREEN}${BOLD}Saved ${results.length} results to scripts/gallery-results.json${RESET}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const totalCost = results.reduce((s, r) => s + parseFloat(r.priceUsd), 0);
  const errors = results.filter((r) => r.error).length;

  console.log(`\n${BOLD}Summary:${RESET}`);
  console.log(`  ${results.length} endpoints called (${errors} errors)`);
  console.log(`  Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  Total cost: $${totalCost.toFixed(2)} (free tier)`);
  console.log(`  View gallery at: ${BASE_URL}/x402/gallery\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
