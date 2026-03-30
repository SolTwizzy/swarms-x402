#!/usr/bin/env bun
/**
 * SwarmX Demo: Multi-Agent Research Pipeline
 *
 * Sends a research query through the 3-agent pipeline:
 *   Researcher -> FactChecker -> Writer
 *
 * Usage:  bun run scripts/demo-research.ts
 *         bun run scripts/demo-research.ts --local   (use localhost:3000)
 *         bun run scripts/demo-research.ts --query "your custom question here"
 */

const PROD_URL = "https://x402-swarms-production.up.railway.app";
const LOCAL_URL = "http://localhost:3000";
const useLocal = process.argv.includes("--local");
const BASE_URL = useLocal ? LOCAL_URL : PROD_URL;

// Allow custom query via --query flag
const queryIdx = process.argv.indexOf("--query");
const DEFAULT_QUERY =
  "What are the top 3 risks of restaking protocols in 2026? " +
  "Consider smart contract risk, slashing cascades, and systemic leverage.";
const QUERY = queryIdx !== -1 && process.argv[queryIdx + 1]
  ? process.argv.slice(queryIdx + 1).join(" ")
  : DEFAULT_QUERY;

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
const BG_MAGENTA = "\x1b[45m";

function boxTop(width: number): string {
  return `${MAGENTA}${BOLD}${"╔" + "═".repeat(width - 2) + "╗"}${RESET}`;
}
function boxMid(text: string, width: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = width - 4 - stripped.length;
  return `${MAGENTA}${BOLD}║${RESET}  ${text}${" ".repeat(Math.max(0, pad))}${MAGENTA}${BOLD}║${RESET}`;
}
function boxBot(width: number): string {
  return `${MAGENTA}${BOLD}${"╚" + "═".repeat(width - 2) + "╝"}${RESET}`;
}
function hrLine(width: number): string {
  return `${DIM}${"─".repeat(width)}${RESET}`;
}
function hrDouble(width: number): string {
  return `${DIM}${"═".repeat(width)}${RESET}`;
}

function printBanner(): void {
  const W = 60;
  console.log();
  console.log(boxTop(W));
  console.log(boxMid(`${BOLD}${WHITE}SwarmX Research Pipeline${RESET}`, W));
  console.log(boxMid(`${DIM}3-Agent Sequential Workflow${RESET}`, W));
  console.log(boxBot(W));
  console.log();
}

function printPipeline(): void {
  // Visual pipeline diagram
  console.log(`  ${BOLD}Pipeline:${RESET}`);
  console.log();
  console.log(`    ${CYAN}┌─────────────┐${RESET}     ${YELLOW}┌──────────────┐${RESET}     ${GREEN}┌──────────┐${RESET}`);
  console.log(`    ${CYAN}│ ${BOLD}Researcher${RESET}  ${CYAN}│${RESET} ──▶ ${YELLOW}│ ${BOLD}FactChecker${RESET}  ${YELLOW}│${RESET} ──▶ ${GREEN}│ ${BOLD}Writer${RESET}   ${GREEN}│${RESET}`);
  console.log(`    ${CYAN}│${DIM} gpt-4o-mini ${RESET}${CYAN}│${RESET}     ${YELLOW}│${DIM} gpt-4o-mini  ${RESET}${YELLOW}│${RESET}     ${GREEN}│${DIM} gpt-4o   ${RESET}${GREEN}│${RESET}`);
  console.log(`    ${CYAN}└─────────────┘${RESET}     ${YELLOW}└──────────────┘${RESET}     ${GREEN}└──────────┘${RESET}`);
  console.log();
}

function printQuery(): void {
  console.log(`  ${BOLD}Query:${RESET}     ${WHITE}${QUERY}${RESET}`);
  console.log(`  ${BOLD}Depth:${RESET}     standard`);
  console.log(`  ${BOLD}Cost:${RESET}      ${GREEN}$0.05 USDC${RESET} ${DIM}(or FREE with free tier)${RESET}`);
  console.log(`  ${BOLD}Endpoint:${RESET}  ${DIM}${BASE_URL}/x402/research${RESET}`);
  console.log();
}

function printSpinner(message: string): { stop: (finalMsg: string) => void; update: (msg: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let currentMsg = message;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${YELLOW}${frames[i % frames.length]}${RESET} ${currentMsg}${"  "}`);
    i++;
  }, 80);
  return {
    update(msg: string) {
      currentMsg = msg;
    },
    stop(finalMsg: string) {
      clearInterval(interval);
      process.stdout.write(`\r  ${GREEN}✓${RESET} ${finalMsg}${"    "}\n`);
    },
  };
}

// ── Parse research output into sections ──────────────────────────────────────

function formatResearchOutput(raw: string, elapsed: number): void {
  const W = 60;
  console.log();
  console.log(hrDouble(W));
  console.log();

  // Try to identify pipeline stages in the output
  const lines = raw.split("\n");
  let inSection = "";
  let sectionContent: string[] = [];
  const sections: { name: string; icon: string; color: string; lines: string[] }[] = [];

  // Heuristic: look for section markers from each agent
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect agent handoff markers
    if (/researcher|research\s*findings|information\s*gathered/i.test(trimmed) && /#{1,3}|^[A-Z].*:/i.test(trimmed)) {
      if (inSection && sectionContent.length > 0) {
        sections.push({ name: inSection, icon: getIcon(inSection), color: getColor(inSection), lines: [...sectionContent] });
      }
      inSection = "researcher";
      sectionContent = [];
      continue;
    }
    if (/fact[\s-]*check|verif(y|ied|ication)/i.test(trimmed) && /#{1,3}|^[A-Z].*:|VERIFIED|UNVERIFIED|DISPUTED/i.test(trimmed)) {
      if (inSection && sectionContent.length > 0) {
        sections.push({ name: inSection, icon: getIcon(inSection), color: getColor(inSection), lines: [...sectionContent] });
      }
      inSection = "factchecker";
      sectionContent = [];
      continue;
    }
    if (/executive\s*summary|final\s*report|writer|conclusion|recommendation/i.test(trimmed) && /#{1,3}|^[A-Z].*:/i.test(trimmed)) {
      if (inSection && sectionContent.length > 0) {
        sections.push({ name: inSection, icon: getIcon(inSection), color: getColor(inSection), lines: [...sectionContent] });
      }
      inSection = "writer";
      sectionContent = [];
      continue;
    }

    sectionContent.push(trimmed);
  }

  // Push last section
  if (inSection && sectionContent.length > 0) {
    sections.push({ name: inSection, icon: getIcon(inSection), color: getColor(inSection), lines: [...sectionContent] });
  }

  // If no sections detected, display as formatted output
  if (sections.length === 0) {
    // Display with generic formatting
    console.log(`  ${CYAN}${BOLD}🔍 Agent 1: Researcher${RESET} ${DIM}(gathering data)${RESET}`);
    console.log(`  ${YELLOW}${BOLD}✅ Agent 2: FactChecker${RESET} ${DIM}(verifying claims)${RESET}`);
    console.log(`  ${GREEN}${BOLD}📝 Agent 3: Writer${RESET} ${DIM}(producing report)${RESET}`);
    console.log();
    console.log(hrLine(W));
    console.log();

    // Print the raw output with formatting
    const outputLines = raw.split("\n");
    for (const line of outputLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        console.log();
        continue;
      }

      // Headers
      if (/^#{1,3}\s/.test(trimmed)) {
        const headerText = trimmed.replace(/^#+\s*/, "");
        console.log(`  ${BOLD}${WHITE}${headerText}${RESET}`);
        continue;
      }

      // Verification tags
      let formatted = trimmed;
      formatted = formatted.replace(/\[VERIFIED\]/gi, `${GREEN}${BOLD}[VERIFIED]${RESET}`);
      formatted = formatted.replace(/\[UNVERIFIED\]/gi, `${YELLOW}${BOLD}[UNVERIFIED]${RESET}`);
      formatted = formatted.replace(/\[DISPUTED\]/gi, `${RED}${BOLD}[DISPUTED]${RESET}`);

      // Bullet points
      if (/^[-*•]\s/.test(formatted)) {
        console.log(`    ${formatted}`);
      } else if (/^\d+\.\s/.test(formatted)) {
        console.log(`    ${formatted}`);
      } else {
        console.log(`    ${formatted}`);
      }
    }
  } else {
    // Display parsed sections
    for (const section of sections) {
      console.log(`  ${section.color}${BOLD}${section.icon} ${sectionLabel(section.name)}${RESET}`);
      console.log();

      const displayLines = section.lines.filter(l => l.length > 0).slice(0, 30);
      for (const line of displayLines) {
        let formatted = line;
        formatted = formatted.replace(/\[VERIFIED\]/gi, `${GREEN}${BOLD}[VERIFIED]${RESET}`);
        formatted = formatted.replace(/\[UNVERIFIED\]/gi, `${YELLOW}${BOLD}[UNVERIFIED]${RESET}`);
        formatted = formatted.replace(/\[DISPUTED\]/gi, `${RED}${BOLD}[DISPUTED]${RESET}`);

        if (/^#{1,3}\s/.test(formatted)) {
          const headerText = formatted.replace(/^#+\s*/, "");
          console.log(`    ${BOLD}${headerText}${RESET}`);
        } else {
          console.log(`    ${formatted}`);
        }
      }

      if (section.lines.filter(l => l.length > 0).length > 30) {
        console.log(`    ${DIM}... (${section.lines.length - 30} more lines)${RESET}`);
      }
      console.log();
    }
  }

  console.log();
  console.log(hrLine(W));
  console.log();
  console.log(`  ${GREEN}${BOLD}✅ Research complete in ${(elapsed / 1000).toFixed(1)}s${RESET}`);
  console.log(`  ${DIM}   3 agents • SequentialWorkflow • Swarms orchestration${RESET}`);
  console.log();
}

function getIcon(section: string): string {
  switch (section) {
    case "researcher": return "🔍";
    case "factchecker": return "✅";
    case "writer": return "📝";
    default: return "📋";
  }
}
function getColor(section: string): string {
  switch (section) {
    case "researcher": return CYAN;
    case "factchecker": return YELLOW;
    case "writer": return GREEN;
    default: return WHITE;
  }
}
function sectionLabel(section: string): string {
  switch (section) {
    case "researcher": return "Researcher — Raw Findings";
    case "factchecker": return "FactChecker — Verification";
    case "writer": return "Writer — Final Report";
    default: return section;
  }
}

function printCurlExample(): void {
  console.log(`  ${BOLD}Try it yourself:${RESET}`);
  console.log();
  console.log(`  ${DIM}curl -X POST ${BASE_URL}/x402/research \\${RESET}`);
  console.log(`  ${DIM}  -H "Content-Type: application/json" \\${RESET}`);
  console.log(`  ${DIM}  -d '{"query": "What are the risks of restaking?", "depth": "standard"}'${RESET}`);
  console.log();
  console.log(`  ${DIM}Free tier: 10 calls/day — no wallet needed${RESET}`);
  console.log(`  ${DIM}Paid tier: $0.05 USDC per research via x402 protocol${RESET}`);
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
  printPipeline();
  printQuery();

  const spinner = printSpinner("Agent 1: Researcher gathering data...");

  const start = Date.now();

  // Simulate pipeline stage updates
  const stageTimer1 = setTimeout(() => spinner.update("Agent 2: FactChecker verifying claims..."), 8_000);
  const stageTimer2 = setTimeout(() => spinner.update("Agent 3: Writer producing final report..."), 16_000);

  try {
    const response = await fetch(`${BASE_URL}/x402/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        depth: "standard",
      }),
      signal: AbortSignal.timeout(180_000), // 3 min timeout for multi-agent pipeline
    });

    clearTimeout(stageTimer1);
    clearTimeout(stageTimer2);
    const elapsed = Date.now() - start;

    if (response.status === 402) {
      spinner.stop(`Payment required (free tier exhausted) — ${(elapsed / 1000).toFixed(1)}s`);
      console.log();
      console.log(`  ${YELLOW}${BOLD}💰 402 Payment Required${RESET}`);
      console.log(`  ${DIM}Free tier (10 calls/day) has been exhausted.${RESET}`);
      console.log(`  ${DIM}To pay: attach x402 payment header with $0.05 USDC.${RESET}`);
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

    // Extract the research result
    const rawResult = String(data.result ?? JSON.stringify(data, null, 2));
    formatResearchOutput(rawResult, elapsed);

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

    // Word count if available
    if (typeof data.wordCount === "number") {
      console.log(`  ${DIM}Report length: ~${data.wordCount} words${RESET}`);
      console.log();
    }

    printCurlExample();
  } catch (err) {
    clearTimeout(stageTimer1);
    clearTimeout(stageTimer2);
    const elapsed = Date.now() - start;
    spinner.stop(`Failed — ${(elapsed / 1000).toFixed(1)}s`);
    printError(err, elapsed);
    printCurlExample();
  }
}

main().catch(console.error);
