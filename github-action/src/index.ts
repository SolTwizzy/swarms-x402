import * as core from "@actions/core";
import * as github from "@actions/github";
import * as glob from "@actions/glob";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface AuditFinding {
  severity?: string;
  title: string;
  description?: string;
  attackScenario?: string;
  estimatedSavings?: string;
}

interface AuditResult {
  file: string;
  riskScore: number | null;
  findings: {
    security: AuditFinding[];
    economic: AuditFinding[];
    gas: AuditFinding[];
  };
  summary: string;
  error?: string;
}

interface ContractAuditResponse {
  riskScore: number | null;
  findings: {
    security: AuditFinding[];
    economic: AuditFinding[];
    gas: AuditFinding[];
  };
  summary: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

async function auditContract(
  apiUrl: string,
  code: string,
  language: string,
  walletKey?: string
): Promise<ContractAuditResponse> {
  const url = `${apiUrl}/x402/contract-audit`;
  const body = JSON.stringify({ code, language });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // If a wallet key is provided, include it so the server can verify
  // payment capability. The free tier (10 calls/day) works without it.
  if (walletKey) {
    headers["x-wallet-key"] = walletKey;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API returned ${res.status}: ${text}`);
  }

  return (await res.json()) as ContractAuditResponse;
}

function severityEmoji(severity?: string): string {
  switch (severity?.toLowerCase()) {
    case "critical":
      return "!!";
    case "high":
      return "!";
    case "medium":
      return "~";
    case "low":
    case "info":
      return "-";
    default:
      return "-";
  }
}

function hasCritical(result: AuditResult): boolean {
  return result.findings.security.some(
    (f) => f.severity?.toLowerCase() === "critical"
  );
}

function riskBadge(score: number | null): string {
  if (score === null) return "N/A";
  if (score >= 80) return `${score}/100 [CRITICAL]`;
  if (score >= 60) return `${score}/100 [HIGH]`;
  if (score >= 40) return `${score}/100 [MEDIUM]`;
  if (score >= 20) return `${score}/100 [LOW]`;
  return `${score}/100 [SAFE]`;
}

function countFindings(result: AuditResult): number {
  return (
    result.findings.security.length +
    result.findings.economic.length +
    result.findings.gas.length
  );
}

// ── Build PR comment body ──────────────────────────────────────────────

function buildComment(results: AuditResult[]): string {
  const lines: string[] = [];

  lines.push("## SwarmX Contract Audit Report");
  lines.push("");
  lines.push(
    "> Automated audit by [SwarmX](https://api.swarmx.io) -- 4 AI agents (SecurityAuditor, EconomicAttacker, GasOptimizer, AuditReporter)"
  );
  lines.push("");

  // Summary table
  lines.push("| File | Risk Score | Findings | Status |");
  lines.push("|------|-----------|----------|--------|");
  for (const r of results) {
    const count = countFindings(r);
    const status = r.error
      ? "Error"
      : hasCritical(r)
        ? "CRITICAL"
        : "Pass";
    lines.push(
      `| \`${r.file}\` | ${riskBadge(r.riskScore)} | ${count} | ${status} |`
    );
  }
  lines.push("");

  // Per-file details
  for (const r of results) {
    lines.push(`### \`${r.file}\``);
    lines.push("");

    if (r.error) {
      lines.push(`> Error: ${r.error}`);
      lines.push("");
      continue;
    }

    lines.push(`**Summary:** ${r.summary}`);
    lines.push("");

    if (r.findings.security.length > 0) {
      lines.push("**Security Findings:**");
      for (const f of r.findings.security) {
        lines.push(
          `- ${severityEmoji(f.severity)} [${f.severity ?? "unknown"}] **${f.title}**: ${f.description ?? ""}`
        );
      }
      lines.push("");
    }

    if (r.findings.economic.length > 0) {
      lines.push("**Economic Attack Vectors:**");
      for (const f of r.findings.economic) {
        lines.push(
          `- ${severityEmoji(f.severity)} [${f.severity ?? "unknown"}] **${f.title}**: ${f.attackScenario ?? ""}`
        );
      }
      lines.push("");
    }

    if (r.findings.gas.length > 0) {
      lines.push("**Gas Optimizations:**");
      for (const f of r.findings.gas) {
        lines.push(
          `- **${f.title}**: ${f.description ?? ""} (saves ~${f.estimatedSavings ?? "unknown"})`
        );
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    "*Powered by [SwarmX](https://api.swarmx.io) -- AI Agent Teams. One Payment.*"
  );

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    const filesPattern = core.getInput("files") || "**/*.sol";
    const language = core.getInput("language") || "solidity";
    const apiUrl = (core.getInput("api-url") || "https://api.swarmx.io").replace(/\/$/, "");
    const failOnCritical = core.getInput("fail-on-critical") !== "false";
    const walletKey = core.getInput("wallet-private-key") || undefined;

    // 1. Find matching contract files
    core.info(`Searching for contract files: ${filesPattern}`);
    const globber = await glob.create(filesPattern, {
      followSymbolicLinks: false,
    });
    const files = await globber.glob();

    if (files.length === 0) {
      core.warning(`No files found matching pattern: ${filesPattern}`);
      core.setOutput("risk-score", "0");
      core.setOutput("findings-count", "0");
      return;
    }

    core.info(`Found ${files.length} contract file(s) to audit`);

    // 2. Audit each file
    const results: AuditResult[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(process.cwd(), filePath);
      core.info(`Auditing: ${relativePath}`);

      try {
        const code = fs.readFileSync(filePath, "utf-8");

        if (code.trim().length === 0) {
          core.warning(`Skipping empty file: ${relativePath}`);
          continue;
        }

        const response = await auditContract(apiUrl, code, language, walletKey);

        results.push({
          file: relativePath,
          riskScore: response.riskScore,
          findings: response.findings ?? { security: [], economic: [], gas: [] },
          summary: response.summary ?? "No summary available",
          error: response.error,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.error(`Failed to audit ${relativePath}: ${message}`);
        results.push({
          file: relativePath,
          riskScore: null,
          findings: { security: [], economic: [], gas: [] },
          summary: "",
          error: message,
        });
      }
    }

    // 3. Compute aggregate metrics
    const maxRisk = Math.max(
      ...results.map((r) => r.riskScore ?? 0)
    );
    const totalFindings = results.reduce(
      (sum, r) => sum + countFindings(r),
      0
    );
    const anyCritical = results.some(hasCritical);

    core.setOutput("risk-score", String(maxRisk));
    core.setOutput("findings-count", String(totalFindings));

    // 4. Post PR comment (if running in a PR context)
    const token = process.env.GITHUB_TOKEN;
    const context = github.context;

    if (token && context.payload.pull_request) {
      core.info("Posting audit report as PR comment...");
      const octokit = github.getOctokit(token);
      const prNumber = context.payload.pull_request.number;

      const commentBody = buildComment(results);

      // Look for an existing SwarmX comment to update instead of spamming
      const { data: existingComments } = await octokit.rest.issues.listComments({
        ...context.repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existing = existingComments.find((c) =>
        c.body?.startsWith("## SwarmX Contract Audit Report")
      );

      if (existing) {
        await octokit.rest.issues.updateComment({
          ...context.repo,
          comment_id: existing.id,
          body: commentBody,
        });
        core.info(`Updated existing comment #${existing.id}`);
      } else {
        const { data: created } = await octokit.rest.issues.createComment({
          ...context.repo,
          issue_number: prNumber,
          body: commentBody,
        });
        core.info(`Created comment #${created.id}`);
        core.setOutput("report-url", created.html_url);
      }
    } else {
      core.info(
        "Not in a PR context or GITHUB_TOKEN not set — skipping comment"
      );
      // Print the report to the action log instead
      core.info(buildComment(results));
    }

    // 5. Fail if critical issues found
    if (failOnCritical && anyCritical) {
      core.setFailed(
        `Critical security issues found (max risk score: ${maxRisk}/100, ${totalFindings} total findings)`
      );
    } else {
      core.info(
        `Audit complete: risk score ${maxRisk}/100, ${totalFindings} findings`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`SwarmX audit action failed: ${message}`);
  }
}

run();
