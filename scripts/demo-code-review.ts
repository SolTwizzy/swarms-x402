#!/usr/bin/env bun
/**
 * SwarmX Demo: Multi-Agent Code Review
 *
 * Submits a Solana smart contract with a deliberate reentrancy bug
 * to the live SwarmX endpoint and displays the 3-agent review results.
 *
 * Usage:  bun run scripts/demo-code-review.ts
 *         bun run scripts/demo-code-review.ts --local   (use localhost:3000)
 */

const PROD_URL = "https://x402-swarms-production.up.railway.app";
const LOCAL_URL = "http://localhost:3000";
const useLocal = process.argv.includes("--local");
const BASE_URL = useLocal ? LOCAL_URL : PROD_URL;

// ── Solana program with a deliberate reentrancy bug ──────────────────────────

const BUGGY_CODE = `use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Vuln1111111111111111111111111111111111111");

#[program]
pub mod vulnerable_token_vault {
    use super::*;

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        // BUG: state updated AFTER external call (reentrancy)
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        vault.total_deposits += amount; // state update after CPI
        vault.last_depositor = ctx.accounts.user.key();
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        // BUG: no balance check before withdrawal
        // BUG: missing signer seeds for PDA authority
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
            ),
            amount,
        )?;
        vault.total_deposits -= amount; // underflow if amount > deposits
        Ok(())
    }
}

#[account]
pub struct Vault {
    pub total_deposits: u64,
    pub last_depositor: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    /// CHECK: PDA authority — missing proper validation
    pub vault_authority: AccountInfo<'info>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}`;

const CODE_LINE_COUNT = BUGGY_CODE.split("\n").length;

// ── Terminal formatting helpers ──────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BG_BLUE = "\x1b[44m";
const BG_RED = "\x1b[41m";
const BG_YELLOW = "\x1b[43m";
const BG_GREEN = "\x1b[42m";

function boxTop(width: number): string {
  return `${CYAN}${BOLD}${"╔" + "═".repeat(width - 2) + "╗"}${RESET}`;
}
function boxMid(text: string, width: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = width - 4 - stripped.length;
  return `${CYAN}${BOLD}║${RESET}  ${text}${" ".repeat(Math.max(0, pad))}${CYAN}${BOLD}║${RESET}`;
}
function boxBot(width: number): string {
  return `${CYAN}${BOLD}${"╚" + "═".repeat(width - 2) + "╝"}${RESET}`;
}
function hrLine(width: number): string {
  return `${DIM}${"─".repeat(width)}${RESET}`;
}

function severity(level: string): string {
  const up = level.toUpperCase();
  if (up.includes("CRITICAL")) return `${BG_RED}${WHITE}${BOLD} CRITICAL ${RESET}`;
  if (up.includes("HIGH")) return `${RED}${BOLD}[HIGH]${RESET}`;
  if (up.includes("MEDIUM")) return `${YELLOW}${BOLD}[MEDIUM]${RESET}`;
  if (up.includes("LOW")) return `${BLUE}[LOW]${RESET}`;
  if (up.includes("INFO")) return `${DIM}[INFO]${RESET}`;
  return `${DIM}[${up}]${RESET}`;
}

function printBanner(): void {
  const W = 60;
  console.log();
  console.log(boxTop(W));
  console.log(boxMid(`${BOLD}${WHITE}SwarmX Code Review${RESET}`, W));
  console.log(boxMid(`${DIM}3 AI Agents, One Micropayment${RESET}`, W));
  console.log(boxBot(W));
  console.log();
}

function printSubmission(): void {
  console.log(`  ${BOLD}Code submitted:${RESET}  Solana Token Vault (Anchor/Rust) — ${CODE_LINE_COUNT} lines`);
  console.log(`  ${BOLD}Cost:${RESET}            ${GREEN}$0.03 USDC${RESET} ${DIM}(or FREE with free tier)${RESET}`);
  console.log(`  ${BOLD}Agents:${RESET}          ${MAGENTA}SecurityAuditor${RESET} + ${BLUE}PerformanceReviewer${RESET} + ${CYAN}StyleChecker${RESET}`);
  console.log(`  ${BOLD}Swarm type:${RESET}      ConcurrentWorkflow (parallel execution)`);
  console.log(`  ${BOLD}Endpoint:${RESET}        ${DIM}${BASE_URL}/x402/code-review${RESET}`);
  console.log();
}

function printSpinner(message: string): { stop: (finalMsg: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${YELLOW}${frames[i % frames.length]}${RESET} ${message}`);
    i++;
  }, 80);
  return {
    stop(finalMsg: string) {
      clearInterval(interval);
      process.stdout.write(`\r  ${GREEN}✓${RESET} ${finalMsg}\n`);
    },
  };
}

// ── Parse the raw Swarms output into agent sections ──────────────────────────

interface AgentSection {
  agent: string;
  content: string;
}

function parseAgentOutput(raw: string): AgentSection[] {
  const sections: AgentSection[] = [];

  // Try to split by agent name headers in the Swarms output
  const agentPatterns = [
    { name: "SecurityAuditor", icon: "🔒", label: "Security Audit" },
    { name: "PerformanceReviewer", icon: "⚡", label: "Performance Review" },
    { name: "StyleChecker", icon: "🎨", label: "Style Check" },
  ];

  // Swarms ConcurrentWorkflow typically returns all outputs concatenated
  // Try splitting by agent name markers
  for (const ap of agentPatterns) {
    const regex = new RegExp(
      `(?:${ap.name}[:\\s]*|##\\s*${ap.label}[:\\s]*)([\\s\\S]*?)(?=(?:SecurityAuditor|PerformanceReviewer|StyleChecker|$))`,
      "i"
    );
    const match = raw.match(regex);
    if (match) {
      sections.push({ agent: ap.name, content: match[1].trim() });
    }
  }

  // If parsing failed, create a single combined section
  if (sections.length === 0) {
    sections.push({ agent: "Combined", content: raw });
  }

  return sections;
}

function formatFinding(line: string): string {
  // Highlight severity tags
  let formatted = line;
  formatted = formatted.replace(/\[CRITICAL\]/gi, severity("CRITICAL"));
  formatted = formatted.replace(/\[HIGH\]/gi, severity("HIGH"));
  formatted = formatted.replace(/\[MEDIUM\]/gi, severity("MEDIUM"));
  formatted = formatted.replace(/\[LOW\]/gi, severity("LOW"));
  formatted = formatted.replace(/\[INFO\]/gi, severity("INFO"));

  // Highlight line references
  formatted = formatted.replace(/(line\s+\d+)/gi, `${YELLOW}$1${RESET}`);

  return formatted;
}

function printResults(raw: string, elapsed: number): void {
  const W = 60;
  console.log(hrLine(W));
  console.log();

  const sections = parseAgentOutput(raw);

  if (sections.length === 1 && sections[0].agent === "Combined") {
    // Could not split — display as formatted blocks with icons
    const content = sections[0].content;

    // Display the raw output with formatting
    console.log(`  ${MAGENTA}${BOLD}🔒 Security Audit${RESET}`);
    console.log(`  ${BLUE}${BOLD}⚡ Performance Review${RESET}`);
    console.log(`  ${CYAN}${BOLD}🎨 Style Check${RESET}`);
    console.log();
    console.log(hrLine(W));
    console.log();

    // Format each line
    const lines = content.split("\n");
    let currentSection = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        console.log();
        continue;
      }

      // Detect section headers
      if (/security|audit/i.test(trimmed) && /#{1,3}|^[A-Z]/.test(trimmed)) {
        currentSection = "security";
        console.log(`  ${MAGENTA}${BOLD}🔒 ${trimmed}${RESET}`);
      } else if (/performance|optimization|gas/i.test(trimmed) && /#{1,3}|^[A-Z]/.test(trimmed)) {
        currentSection = "performance";
        console.log(`  ${BLUE}${BOLD}⚡ ${trimmed}${RESET}`);
      } else if (/style|quality|convention|documentation/i.test(trimmed) && /#{1,3}|^[A-Z]/.test(trimmed)) {
        currentSection = "style";
        console.log(`  ${CYAN}${BOLD}🎨 ${trimmed}${RESET}`);
      } else {
        // Regular content line
        const indent = "    ";
        console.log(`${indent}${formatFinding(trimmed)}`);
      }
    }
  } else {
    // Successfully parsed individual agent outputs
    const icons: Record<string, { icon: string; color: string; label: string }> = {
      SecurityAuditor: { icon: "🔒", color: MAGENTA, label: "Security Audit" },
      PerformanceReviewer: { icon: "⚡", color: BLUE, label: "Performance Review" },
      StyleChecker: { icon: "🎨", color: CYAN, label: "Style Check" },
    };

    for (const section of sections) {
      const meta = icons[section.agent] ?? { icon: "📋", color: WHITE, label: section.agent };
      console.log(`  ${meta.color}${BOLD}${meta.icon} ${meta.label}${RESET}`);

      const lines = section.content.split("\n").slice(0, 20); // Limit output
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log(`    ${formatFinding(trimmed)}`);
      }
      console.log();
    }
  }

  console.log();
  console.log(hrLine(W));
  console.log();
  console.log(`  ${GREEN}${BOLD}✅ Review complete in ${(elapsed / 1000).toFixed(1)}s${RESET}`);
  console.log(`  ${DIM}   Powered by Swarms multi-agent orchestration${RESET}`);
  console.log();
}

function printCurlExample(): void {
  console.log(`  ${BOLD}Try it yourself:${RESET}`);
  console.log();
  console.log(`  ${DIM}curl -X POST ${BASE_URL}/x402/code-review \\${RESET}`);
  console.log(`  ${DIM}  -H "Content-Type: application/json" \\${RESET}`);
  console.log(`  ${DIM}  -d '{"code": "fn main() { ... }", "language": "rust"}'${RESET}`);
  console.log();
  console.log(`  ${DIM}Free tier: 10 calls/day — no wallet needed${RESET}`);
  console.log(`  ${DIM}Paid tier: $0.03 USDC per review via x402 protocol${RESET}`);
  console.log();
}

function printError(err: unknown, elapsed: number): void {
  const W = 60;
  console.log(hrLine(W));
  console.log();
  console.log(`  ${RED}${BOLD}✗ Request failed after ${(elapsed / 1000).toFixed(1)}s${RESET}`);
  console.log();

  if (err instanceof Error) {
    if (err.message.includes("fetch") || err.message.includes("ECONNREFUSED")) {
      console.log(`  ${YELLOW}Server unreachable.${RESET} The SwarmX server may be sleeping.`);
      console.log(`  Railway free-tier instances spin down after inactivity.`);
      console.log(`  Try again in 30 seconds, or run locally with --local flag.`);
    } else {
      console.log(`  ${RED}${err.message}${RESET}`);
    }
  } else {
    console.log(`  ${RED}${String(err)}${RESET}`);
  }
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();
  printSubmission();

  const spinner = printSpinner(
    `Sending to ${useLocal ? "local" : "production"} SwarmX... (3 agents reviewing in parallel)`
  );

  const start = Date.now();

  try {
    const response = await fetch(`${BASE_URL}/x402/code-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: BUGGY_CODE,
        language: "rust",
      }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout for multi-agent
    });

    const elapsed = Date.now() - start;

    if (response.status === 402) {
      spinner.stop(`Payment required (free tier exhausted) — ${(elapsed / 1000).toFixed(1)}s`);
      console.log();
      console.log(`  ${YELLOW}${BOLD}💰 402 Payment Required${RESET}`);
      console.log(`  ${DIM}Free tier (10 calls/day) has been exhausted.${RESET}`);
      console.log(`  ${DIM}To pay: attach x402 payment header with $0.03 USDC.${RESET}`);
      console.log();

      const body = await response.json().catch(() => ({}));
      if (body && typeof body === "object") {
        const info = body as Record<string, unknown>;
        if (info.network) console.log(`  ${DIM}Network: ${info.network}${RESET}`);
        if (info.payTo) console.log(`  ${DIM}Pay to:  ${info.payTo}${RESET}`);
      }
      console.log();
      return;
    }

    if (!response.ok) {
      spinner.stop(`Error: HTTP ${response.status} — ${(elapsed / 1000).toFixed(1)}s`);
      const text = await response.text().catch(() => "");
      printError(new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`), elapsed);
      return;
    }

    const data = (await response.json()) as Record<string, unknown>;
    spinner.stop(`Response received — ${(elapsed / 1000).toFixed(1)}s`);
    console.log();

    // The raw output from Swarms contains all three agents' reviews
    const rawOutput = String(data.rawOutput ?? data.security ?? data.result ?? JSON.stringify(data, null, 2));
    printResults(rawOutput, elapsed);

    // Payment info
    const payment = data.payment as Record<string, unknown> | undefined;
    if (payment) {
      const txn = payment.transaction;
      if (txn && txn !== "undefined" && txn !== "null") {
        console.log(`  ${GREEN}💰 Paid: $${payment.amount} USDC${RESET}`);
        console.log(`  ${DIM}   Tx: ${String(txn).slice(0, 20)}...${RESET}`);
        console.log(`  ${DIM}   Network: ${payment.network}${RESET}`);
      } else {
        console.log(`  ${GREEN}🆓 Free tier — no payment charged${RESET}`);
      }
      console.log();
    }

    printCurlExample();
  } catch (err) {
    const elapsed = Date.now() - start;
    spinner.stop(`Failed — ${(elapsed / 1000).toFixed(1)}s`);
    printError(err, elapsed);
    printCurlExample();
  }
}

main().catch(console.error);
