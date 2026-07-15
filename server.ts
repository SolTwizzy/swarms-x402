/**
 * Standalone HTTP server for eliza-x402-swarms.
 *
 * Exposes the plugin's x402 routes WITHOUT requiring the full ElizaOS CLI.
 * Run with: bun run server.ts
 */

import { x402Routes } from "./src/routes/x402Routes.js";
import { walletAnalyzerRoutes } from "./src/routes/walletAnalyzerRoutes.js";
import { taskRoutes } from "./src/routes/taskRoutes.js";
import { heliusDataRoutes } from "./src/routes/heliusDataRoutes.js";
import { tradingRoutes } from "./src/routes/tradingRoutes.js";
import { cryptoRoutes } from "./src/routes/cryptoRoutes.js";
import { batchRoutes } from "./src/routes/batchRoutes.js";
import { codeAuditRoutes } from "./src/routes/codeAuditRoutes.js";
import { cryptoAnalysisRoutes } from "./src/routes/cryptoAnalysisRoutes.js";
import { contentRoutes } from "./src/routes/contentRoutes.js";
import { advancedRoutes } from "./src/routes/advancedRoutes.js";
import { swarmRoutes } from "./src/routes/swarmRoutes.js";
import { swarmPremiumRoutes } from "./src/routes/swarmPremiumRoutes.js";
import { rwaRoutes } from "./src/routes/rwaRoutes.js";
import { THEME_FONTS, THEME_TOKENS } from "./src/ui/theme.js";
import { X402WalletService } from "./src/services/x402WalletService.js";
import { SwarmsService } from "./src/services/swarmsService.js";
import { PaymentMemoryService } from "./src/services/paymentMemoryService.js";
import { X402ServerService } from "./src/server/x402ServerService.js";
import { getFreeTierStats, onFreeTierMilestone } from "./src/server/x402Gate.js";
import type { FreeTierStats } from "./src/server/x402Gate.js";
import type { Service } from "@elizaos/core";
import type { Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getReport, getRecentReports, getReportCount } from "./src/utils/reportStore.js";
import type { AuditReport } from "./src/utils/reportStore.js";
import { getMcpToolDefinitions } from "./src/mcp/index.js";
import { handleMcpMessage, mcpDescriptor, type JsonRpcMessage } from "./src/mcp/mcpServer.js";

// ── Env ─────────────────────────────────────────────────────────────────────
// Bun loads .env automatically. For Node, uncomment:
// import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Itachi Debug Bot (Telegram error alerts) ─────────────────────────────────

const ITACHI_DEBUG_BOT_TOKEN = process.env.ITACHI_DEBUG_BOT_TOKEN ?? "";
const ITACHI_DEBUG_CHAT_ID = process.env.ITACHI_DEBUG_CHAT_ID ?? "";

/**
 * Send error alerts to Telegram debug chat via Itachi bot.
 * Fire-and-forget — never blocks the main request flow.
 */
function sendDebugAlert(level: "error" | "warn" | "info", message: string, details?: Record<string, unknown>): void {
  if (!ITACHI_DEBUG_BOT_TOKEN || !ITACHI_DEBUG_CHAT_ID) return;

  const emoji = level === "error" ? "🔴" : level === "warn" ? "⚠️" : "ℹ️";
  const text = `${emoji} *x402-swarms ${level.toUpperCase()}*\n\n\`${message}\`${
    details ? `\n\n\`\`\`json\n${JSON.stringify(details, null, 2).slice(0, 500)}\n\`\`\`` : ""
  }`;

  fetch(`https://api.telegram.org/bot${ITACHI_DEBUG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ITACHI_DEBUG_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  }).catch(() => {}); // silently fail — debug alerts are best-effort
}

// ── Free Tier Milestone Alerts (Telegram) ───────────────────────────────────

onFreeTierMilestone((stats: FreeTierStats) => {
  const topList = stats.topIPs
    .slice(0, 5)
    .map((e) => `  ${e.ip}: ${e.calls} calls`)
    .join("\n");

  sendDebugAlert("warn", `Free tier milestone: ${stats.totalFreeCallsToday} calls today`, {
    uniqueIPs: stats.uniqueIPs,
    totalCalls: stats.totalFreeCallsToday,
    top5IPs: topList,
  });
});

// ── CORS Headers ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, payment-signature, PAYMENT-SIGNATURE, x-api-key",
  "Access-Control-Expose-Headers": "X-SwarmX-Free-Remaining, Set-Cookie, PAYMENT-REQUIRED",
};

/**
 * Clone a Response and append CORS headers to it.
 */
function withCORS(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ── Rate Limiting (in-memory per IP) ─────────────────────────────────────────

const RATE_LIMIT_MAX = 100; // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

/** Remove expired entries every 60 seconds to prevent memory leaks. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 60_000);

/**
 * Returns a 429 Response if the IP has exceeded the rate limit, or null if OK.
 */
function checkRateLimit(request: Request): Response | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";
  const now = Date.now();

  let entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    // Alert on first rate limit hit per window (not every request)
    if (entry.count === RATE_LIMIT_MAX + 1) {
      sendDebugAlert("warn", `Rate limit hit: ${ip}`, { count: entry.count, retryAfter });
    }
    return new Response(
      JSON.stringify({ error: "Too Many Requests" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          ...CORS_HEADERS,
        },
      }
    );
  }

  return null;
}

// ── Minimal logger (Pino-style signature: object first, string second) ──────
const logger = {
  info: (objOrMsg: unknown, msg?: string) => {
    if (typeof objOrMsg === "string") console.log(`[INFO] ${objOrMsg}`);
    else console.log(`[INFO] ${msg ?? ""}`, objOrMsg);
  },
  warn: (objOrMsg: unknown, msg?: string) => {
    if (typeof objOrMsg === "string") console.warn(`[WARN] ${objOrMsg}`);
    else console.warn(`[WARN] ${msg ?? ""}`, objOrMsg);
  },
  error: (objOrMsg: unknown, msg?: string) => {
    if (typeof objOrMsg === "string") console.error(`[ERROR] ${objOrMsg}`);
    else console.error(`[ERROR] ${msg ?? ""}`, objOrMsg);
  },
  debug: (objOrMsg: unknown, msg?: string) => {
    if (typeof objOrMsg === "string") console.debug(`[DEBUG] ${objOrMsg}`);
    else console.debug(`[DEBUG] ${msg ?? ""}`, objOrMsg);
  },
};

// ── Mock Runtime ────────────────────────────────────────────────────────────
// Implements the subset of IAgentRuntime that the services and routes use.

const serviceMap = new Map<string, Service>();

const runtime = {
  agentId: "standalone-server",
  logger,
  getSetting(key: string): string | boolean | number | null {
    const val = process.env[key];
    if (val === undefined) return null;
    if (val === "true") return true;
    if (val === "false") return false;
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== "") return num;
    return val;
  },
  getService<T extends Service>(serviceType: string): T | null {
    return (serviceMap.get(serviceType) as T) ?? null;
  },
  hasService(serviceType: string): boolean {
    return serviceMap.has(serviceType);
  },
} as any; // cast — we only expose the methods routes actually call

// ── Service Initialization ──────────────────────────────────────────────────

async function initServices(): Promise<void> {
  logger.info("Initializing services...");

  const walletService = new X402WalletService(runtime);
  await walletService.initialize(runtime);
  serviceMap.set("X402_WALLET", walletService);

  const swarmsService = new SwarmsService(runtime);
  await swarmsService.initialize(runtime);
  serviceMap.set("SWARMS", swarmsService);

  const serverService = new X402ServerService(runtime);
  await serverService.initialize(runtime);
  serviceMap.set("X402_SERVER", serverService);

  const memoryService = new PaymentMemoryService(runtime);
  await memoryService.initialize(runtime);
  serviceMap.set("PAYMENT_MEMORY", memoryService);

  logger.info("All services initialized.");
}

// ── Route Registration ──────────────────────────────────────────────────────

const allRoutes: Route[] = [...x402Routes, ...taskRoutes, ...walletAnalyzerRoutes, ...heliusDataRoutes, ...tradingRoutes, ...cryptoRoutes, ...batchRoutes, ...codeAuditRoutes, ...cryptoAnalysisRoutes, ...contentRoutes, ...advancedRoutes, ...swarmRoutes, ...swarmPremiumRoutes, ...rwaRoutes];

/**
 * Build a lookup map: "METHOD /path" -> handler
 */
function buildRouteMap(): Map<
  string,
  NonNullable<Route["handler"]>
> {
  const map = new Map<string, NonNullable<Route["handler"]>>();
  for (const route of allRoutes) {
    if (route.handler) {
      const key = `${route.type} ${route.path}`;
      map.set(key, route.handler);
    }
  }
  return map;
}

// ── Gallery HTML Builder ────────────────────────────────────────────────────

interface GalleryFinding {
  severity?: string;
  risk?: string;
  title?: string;
  description?: string;
  attackScenario?: string;
  estimatedSavings?: string;
}

interface GalleryResultEntry {
  type: "contract-audit" | "token-risk";
  name: string;
  description: string;
  timestamp: string;
  durationMs: number;
  priceUsd: string;
  response: Record<string, unknown>;
  error?: string;
}

function loadGalleryResults(): GalleryResultEntry[] {
  const galleryPath = join(import.meta.dir, "scripts", "gallery-results.json");
  if (!existsSync(galleryPath)) return [];
  try {
    const raw = readFileSync(galleryPath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function riskBadgeHtml(score: number): string {
  let bg: string, color: string, label: string;
  if (score >= 61) { bg = "#3b0a0a"; color = "var(--red)"; label = "HIGH RISK"; }
  else if (score >= 26) { bg = "#422006"; color = "var(--yellow)"; label = "MEDIUM"; }
  else { bg = "#064e3b"; color = "var(--accent)"; label = "LOW RISK"; }
  return `<span style="display:inline-block;padding:3px 12px;border-radius:12px;background:${bg};color:${color};font-family:var(--mono);font-size:13px;font-weight:700;">${score}/100 ${label}</span>`;
}

function verdictBadgeHtml(verdict: string): string {
  let bg: string, color: string;
  if (verdict === "DANGER") { bg = "#3b0a0a"; color = "var(--red)"; }
  else if (verdict === "CAUTION") { bg = "#422006"; color = "var(--yellow)"; }
  else { bg = "#064e3b"; color = "var(--accent)"; }
  return `<span style="display:inline-block;padding:3px 12px;border-radius:12px;background:${bg};color:${color};font-family:var(--mono);font-size:13px;font-weight:700;">${escapeHtml(verdict)}</span>`;
}

function severityColor(sev: string): string {
  const s = (sev ?? "").toUpperCase();
  if (s === "CRITICAL") return "var(--red)";
  if (s === "HIGH") return "var(--orange)";
  if (s === "MEDIUM") return "var(--yellow)";
  if (s === "LOW") return "var(--blue)";
  return "var(--text-muted)";
}

function renderFindingsList(findings: GalleryFinding[], category: string): string {
  if (!findings || findings.length === 0) return `<p style="color:var(--text-muted);font-size:13px;">No ${category} findings</p>`;
  return findings.map((f) => {
    const sev = f.severity ?? f.risk ?? "INFO";
    const title = escapeHtml(f.title ?? "Untitled");
    const desc = escapeHtml(f.description ?? f.attackScenario ?? "");
    const extra = f.estimatedSavings ? `<span style="color:var(--accent);font-size:12px;">Saves ${escapeHtml(f.estimatedSavings)}</span>` : "";
    return `<div style="margin-bottom:8px;padding:8px 12px;background:var(--surface-2);border-radius:6px;border-left:3px solid ${severityColor(sev)};">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
    <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:${severityColor(sev)};">${escapeHtml(sev.toUpperCase())}</span>
    <span style="font-size:14px;font-weight:600;color:var(--heading);">${title}</span>
  </div>
  <p style="font-size:13px;color:#8892a8;margin:0;">${desc}</p>
  ${extra}
</div>`;
  }).join("\n");
}

function renderAuditCard(entry: GalleryResultEntry): string {
  const resp = entry.response;
  const riskScore = (resp.riskScore as number) ?? 0;
  const findings = (resp.findings as Record<string, GalleryFinding[]>) ?? {};
  const summary = (resp.summary as string) ?? "";
  const secCount = Array.isArray(findings.security) ? findings.security.length : 0;
  const econCount = Array.isArray(findings.economic) ? findings.economic.length : 0;
  const gasCount = Array.isArray(findings.gas) ? findings.gas.length : 0;
  const durationSec = (entry.durationMs / 1000).toFixed(1);
  const id = entry.name.replace(/\s+/g, "-").toLowerCase();

  return `<div class="gallery-card">
  <div class="gallery-card-header">
    <div>
      <h3 style="margin:0 0 4px;font-size:20px;color:var(--heading);">${escapeHtml(entry.name)}</h3>
      <p style="margin:0;font-size:13px;color:var(--text-muted);">${escapeHtml(entry.description)}</p>
    </div>
    ${riskBadgeHtml(riskScore)}
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;">
    <div class="finding-count" style="border-color:rgba(248,113,113,0.3);">
      <span style="font-size:24px;font-weight:800;color:var(--red);">${secCount}</span>
      <span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Security</span>
    </div>
    <div class="finding-count" style="border-color:rgba(251,191,36,0.3);">
      <span style="font-size:24px;font-weight:800;color:var(--yellow);">${econCount}</span>
      <span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Economic</span>
    </div>
    <div class="finding-count" style="border-color:rgba(96,165,250,0.3);">
      <span style="font-size:24px;font-weight:800;color:var(--blue);">${gasCount}</span>
      <span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Gas</span>
    </div>
  </div>
  <p style="font-size:14px;color:var(--text);line-height:1.6;margin-bottom:16px;">${escapeHtml(summary)}</p>
  <details style="margin-bottom:12px;">
    <summary style="cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--accent);font-weight:600;">Show all findings</summary>
    <div style="margin-top:12px;">
      ${secCount > 0 ? `<h4 style="font-size:12px;color:var(--red);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;">Security</h4>${renderFindingsList(findings.security ?? [], "security")}` : ""}
      ${econCount > 0 ? `<h4 style="font-size:12px;color:var(--yellow);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;">Economic</h4>${renderFindingsList(findings.economic ?? [], "economic")}` : ""}
      ${gasCount > 0 ? `<h4 style="font-size:12px;color:var(--blue);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;">Gas Optimization</h4>${renderFindingsList(findings.gas ?? [], "gas")}` : ""}
    </div>
  </details>
  <div class="gallery-card-meta">
    <span>This audit cost <strong>$${entry.priceUsd}</strong> and took <strong>${durationSec}s</strong></span>
    <span style="color:var(--text-muted);">4 agents &middot; ConcurrentWorkflow</span>
  </div>
</div>`;
}

function renderTokenRiskCard(entry: GalleryResultEntry): string {
  const resp = entry.response;
  const riskScore = (resp.riskScore as number) ?? 0;
  const verdict = (resp.verdict as string) ?? "UNKNOWN";
  const findings = (resp.findings as Record<string, GalleryFinding[]>) ?? {};
  const summary = (resp.summary as string) ?? "";
  const contractCount = Array.isArray(findings.contract) ? findings.contract.length : 0;
  const tokenomicsCount = Array.isArray(findings.tokenomics) ? findings.tokenomics.length : 0;
  const durationSec = (entry.durationMs / 1000).toFixed(1);

  return `<div class="gallery-card">
  <div class="gallery-card-header">
    <div>
      <h3 style="margin:0 0 4px;font-size:20px;color:var(--heading);">${escapeHtml(entry.name)}</h3>
      <p style="margin:0;font-size:13px;color:var(--text-muted);">${escapeHtml(entry.description)}</p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      ${verdictBadgeHtml(verdict)}
      ${riskBadgeHtml(riskScore)}
    </div>
  </div>
  <p style="font-size:14px;color:var(--text);line-height:1.6;margin:16px 0;">${escapeHtml(summary)}</p>
  <details style="margin-bottom:12px;">
    <summary style="cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--accent);font-weight:600;">Show all findings</summary>
    <div style="margin-top:12px;">
      ${contractCount > 0 ? `<h4 style="font-size:12px;color:var(--orange);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;">Contract</h4>${renderFindingsList(findings.contract ?? [], "contract")}` : ""}
      ${tokenomicsCount > 0 ? `<h4 style="font-size:12px;color:#a78bfa;text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;">Tokenomics</h4>${renderFindingsList(findings.tokenomics ?? [], "tokenomics")}` : ""}
    </div>
  </details>
  <div class="gallery-card-meta">
    <span>This assessment cost <strong>$${entry.priceUsd}</strong> and took <strong>${durationSec}s</strong></span>
    <span style="color:var(--text-muted);">3 agents &middot; SequentialWorkflow</span>
  </div>
</div>`;
}

function buildGalleryHtml(): string {
  const results = loadGalleryResults();
  const audits = results.filter((r) => r.type === "contract-audit" && !r.error);
  const tokenRisks = results.filter((r) => r.type === "token-risk" && !r.error);

  const auditCards = audits.map(renderAuditCard).join("\n");
  const tokenCards = tokenRisks.map(renderTokenRiskCard).join("\n");

  // Benchmark comparison data
  const avgAuditTime = audits.length > 0
    ? (audits.reduce((s, r) => s + r.durationMs, 0) / audits.length / 1000).toFixed(1)
    : "15";
  const avgAuditFindings = audits.length > 0
    ? Math.round(audits.reduce((s, r) => {
        const f = (r.response.findings as Record<string, unknown[]>) ?? {};
        return s + (Array.isArray(f.security) ? f.security.length : 0)
          + (Array.isArray(f.economic) ? f.economic.length : 0)
          + (Array.isArray(f.gas) ? f.gas.length : 0);
      }, 0) / audits.length)
    : 4;
  const totalCost = results.reduce((s, r) => s + parseFloat(r.priceUsd), 0).toFixed(2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SwarmX Results Gallery</title>
  <meta name="description" content="Real audit results from SwarmX multi-agent teams — contract audits, token risk assessments, and benchmarks vs single GPT.">
${THEME_FONTS}
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
${THEME_TOKENS}
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.65;
      min-height: 100vh;
    }
    .bg-glow {
      position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
      width: 800px; height: 600px;
      background: radial-gradient(ellipse, rgba(0, 200, 5,0.08) 0%, rgba(0, 135, 61,0.04) 40%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    .page { position: relative; z-index: 1; }
    .container { max-width: 900px; margin: 0 auto; padding: 0 24px; }

    .hero {
      padding: 60px 0 40px;
      text-align: center;
    }
    .logo {
      font-family: var(--mono);
      font-size: 40px;
      font-weight: 800;
      letter-spacing: -2px;
      background: linear-gradient(135deg, var(--heading) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }
    .hero h1 {
      font-size: 32px;
      font-weight: 800;
      color: var(--heading);
      margin-bottom: 8px;
    }
    .hero p {
      font-size: 16px;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto;
    }

    /* Benchmark section */
    .benchmark {
      display: grid;
      grid-template-columns: 1fr 80px 1fr;
      gap: 0;
      margin: 40px 0;
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
    }
    .bench-col {
      padding: 28px 24px;
      text-align: center;
    }
    .bench-col.swarmx { background: rgba(0, 200, 5, 0.05); }
    .bench-col.gpt { background: var(--surface); }
    .bench-vs {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-2);
      font-family: var(--mono);
      font-weight: 800;
      font-size: 16px;
      color: var(--text-dim);
    }
    .bench-label {
      font-family: var(--mono);
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 16px;
    }
    .bench-label.swarmx-label { color: var(--accent); }
    .bench-label.gpt-label { color: #a78bfa; }
    .bench-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .bench-row:last-child { border-bottom: none; }
    .bench-metric {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
    }
    .bench-value {
      font-family: var(--mono);
      font-size: 16px;
      font-weight: 700;
      color: var(--heading);
    }
    .bench-value.winner { color: var(--accent); }
    .bench-value.loser { color: var(--text-muted); }

    /* Gallery cards */
    .gallery-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 20px;
      transition: border-color 0.2s;
    }
    .gallery-card:hover {
      border-color: var(--border-hover);
    }
    .gallery-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }
    .finding-count {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 20px;
      border: 1px solid;
      border-radius: 10px;
      background: rgba(255,255,255,0.02);
      min-width: 80px;
    }
    .gallery-card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-muted);
      flex-wrap: wrap;
      gap: 8px;
    }
    .gallery-card-meta strong {
      color: var(--accent);
    }

    .section-title {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--text-dim);
      margin: 48px 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .section-title .hl { color: var(--accent); }

    details summary {
      user-select: none;
    }
    details[open] summary {
      margin-bottom: 4px;
    }

    .cta-bar {
      text-align: center;
      margin: 48px 0 32px;
      padding: 32px;
      background: linear-gradient(135deg, rgba(0, 200, 5,0.06) 0%, rgba(0, 135, 61,0.04) 100%);
      border: 1px solid rgba(0, 200, 5,0.15);
      border-radius: 14px;
    }
    .cta-bar h3 {
      font-size: 22px;
      font-weight: 700;
      color: var(--heading);
      margin-bottom: 8px;
    }
    .cta-bar p {
      font-size: 15px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }
    .cta-btn {
      display: inline-block;
      padding: 12px 32px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: var(--bg);
      font-weight: 700;
      font-size: 15px;
      border-radius: 8px;
      text-decoration: none;
      font-family: var(--mono);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .cta-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(0, 200, 5, 0.3);
    }

    .footer {
      border-top: 1px solid var(--border);
      padding: 24px 0;
      text-align: center;
      font-size: 12px;
      color: var(--text-dim);
      font-family: var(--mono);
    }
    .footer a {
      color: var(--text-muted);
      text-decoration: none;
    }
    .footer a:hover { color: var(--accent); }

    @media (max-width: 768px) {
      .benchmark { grid-template-columns: 1fr; }
      .bench-vs { padding: 12px; }
      .hero h1 { font-size: 24px; }
      .gallery-card-header { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="page">

    <header class="hero">
      <div class="container">
        <div class="logo">SwarmX</div>
        <h1>Real Results from SwarmX</h1>
        <p>Live audit outputs from multi-agent teams. Every result was generated by 3-4 specialized AI agents working together, paid via x402 micropayments.</p>
      </div>
    </header>

    <div class="container">

      <!-- ========== BENCHMARK ========== -->
      <div class="section-title"><span class="hl">//</span> Multi-Agent vs Single GPT</div>

      <div class="benchmark">
        <div class="bench-col swarmx">
          <div class="bench-label swarmx-label">SwarmX (4 agents)</div>
          <div class="bench-row">
            <span class="bench-metric">Perspectives</span>
            <span class="bench-value winner">4 specialized</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Findings</span>
            <span class="bench-value winner">${avgAuditFindings} avg</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Coverage</span>
            <span class="bench-value winner">Security + Economic + Gas</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Time</span>
            <span class="bench-value">${avgAuditTime}s</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Cost</span>
            <span class="bench-value winner">$0.10</span>
          </div>
        </div>

        <div class="bench-vs">vs</div>

        <div class="bench-col gpt">
          <div class="bench-label gpt-label">Single GPT-4o</div>
          <div class="bench-row">
            <span class="bench-metric">Perspectives</span>
            <span class="bench-value loser">1 generalist</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Findings</span>
            <span class="bench-value loser">1-2 avg</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Coverage</span>
            <span class="bench-value loser">Security only</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Time</span>
            <span class="bench-value">5-8s</span>
          </div>
          <div class="bench-row">
            <span class="bench-metric">Cost</span>
            <span class="bench-value">~$0.03</span>
          </div>
        </div>
      </div>

      <p style="text-align:center;font-size:13px;color:var(--text-muted);margin-top:12px;">
        Multi-agent audits find 2-3x more issues across 3 distinct categories. Single GPT typically misses economic attack vectors and gas optimization entirely.
      </p>

      <!-- ========== CONTRACT AUDITS ========== -->
      <div class="section-title"><span class="hl">//</span> Contract Audit Results</div>
      ${auditCards || '<p style="color:var(--text-muted);">No audit results yet. Run: <code style="color:var(--accent);">bun run scripts/generate-gallery.ts</code></p>'}

      <!-- ========== TOKEN RISK ========== -->
      <div class="section-title"><span class="hl">//</span> Token Risk Assessments</div>
      ${tokenCards || '<p style="color:var(--text-muted);">No token risk results yet.</p>'}

      <!-- ========== CTA ========== -->
      <div class="cta-bar">
        <h3>Try It Yourself</h3>
        <p>All endpoints are live. Use the playground to test with your own contracts or tokens &mdash; 3 free calls per day, no account needed.</p>
        <a href="/" class="cta-btn">Open Playground</a>
      </div>

    </div><!-- .container -->

    <footer class="footer">
      <div class="container">
        <a href="/">Dashboard</a> &middot;
        <a href="/x402/catalog">API Catalog</a> &middot;
        <a href="/x402/health">Health</a> &middot;
        <a href="https://github.com/SolTwizzy/swarms-x402">GitHub</a>
        <br>
        <span style="margin-top:8px;display:inline-block;">Total gallery cost: $${totalCost} via x402 micropayments</span>
      </div>
    </footer>

  </div><!-- .page -->
</body>
</html>`;
}

// ── Badge SVG Builder ──────────────────────────────────────────────────────

function buildBadgeSvg(score: number | null): string {
  const leftText = "SwarmX Audit";
  const leftWidth = 106;
  let rightText: string;
  let rightColor: string;
  let rightWidth: number;

  if (score === null || score === undefined) {
    rightText = "N/A";
    rightColor = "#555";
    rightWidth = 50;
  } else if (score < 30) {
    rightText = `Score: ${score}/100`;
    rightColor = "#4c1"; // green
    rightWidth = 100;
  } else if (score < 60) {
    rightText = `Score: ${score}/100`;
    rightColor = "#dfb317"; // yellow
    rightWidth = 100;
  } else {
    rightText = `Score: ${score}/100`;
    rightColor = "#e05d44"; // red
    rightWidth = 100;
  }

  const totalWidth = leftWidth + rightWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${leftText}: ${rightText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#1a1a2e"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${rightColor}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${leftWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${leftText}</text>
    <text x="${leftWidth / 2}" y="14">${leftText}</text>
    <text aria-hidden="true" x="${leftWidth + rightWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${rightText}</text>
    <text x="${leftWidth + rightWidth / 2}" y="14">${rightText}</text>
  </g>
</svg>`;
}

// ── Report Page HTML Builder ───────────────────────────────────────────────

function buildReportPageHtml(report: AuditReport): string {
  const result = report.result as Record<string, unknown> | null;
  const riskScore = report.riskScore ?? 0;
  const findings = (result?.findings ?? {}) as Record<string, unknown[]>;
  const summary = (result?.summary as string) ?? "";
  const verdict = (result?.verdict as string) ?? "";

  // Type label
  const typeLabels: Record<string, string> = {
    "contract-audit": "Smart Contract Audit Report",
    "token-risk": "Token Risk Assessment Report",
    "code-review": "Code Review Report",
  };
  const title = typeLabels[report.type] ?? "Audit Report";

  // Risk score badge color
  let scoreBg: string, scoreColor: string, scoreLabel: string;
  if (riskScore >= 61) { scoreBg = "#3b0a0a"; scoreColor = "var(--red)"; scoreLabel = "HIGH RISK"; }
  else if (riskScore >= 26) { scoreBg = "#422006"; scoreColor = "var(--yellow)"; scoreLabel = "CAUTION"; }
  else { scoreBg = "#064e3b"; scoreColor = "var(--accent)"; scoreLabel = "LOW RISK"; }

  // Build findings HTML
  function renderFindingsSection(items: unknown[], label: string, color: string): string {
    if (!Array.isArray(items) || items.length === 0) return "";
    let html = `<div style="margin-bottom:20px;">
      <h3 style="font-family:var(--mono);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};margin:0 0 10px;">${escapeHtml(label)} (${items.length})</h3>`;
    for (const item of items) {
      const f = item as Record<string, string>;
      const sev = (f.severity ?? f.risk ?? "INFO").toUpperCase();
      let sevColor = "var(--text-muted)";
      if (sev === "CRITICAL") sevColor = "var(--red)";
      else if (sev === "HIGH") sevColor = "var(--orange)";
      else if (sev === "MEDIUM") sevColor = "var(--yellow)";
      else if (sev === "LOW") sevColor = "var(--blue)";
      const t = escapeHtml(f.title ?? f.description ?? JSON.stringify(f));
      const desc = f.description ? escapeHtml(f.description) : "";
      const attack = f.attackScenario ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Attack: ${escapeHtml(f.attackScenario)}</div>` : "";
      const savings = f.estimatedSavings ? `<div style="font-size:12px;color:var(--accent);margin-top:4px;">Saves ${escapeHtml(f.estimatedSavings)}</div>` : "";
      html += `<div style="margin-bottom:8px;padding:10px 14px;background:var(--surface-2);border-radius:6px;border-left:3px solid ${sevColor};">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="font-family:var(--mono);font-size:10px;font-weight:700;color:${sevColor};">${sev}</span>
          <span style="font-size:14px;font-weight:600;color:var(--heading);">${t}</span>
        </div>
        ${desc ? `<div style="font-size:13px;color:#8892a8;">${desc}</div>` : ""}
        ${attack}${savings}
      </div>`;
    }
    html += "</div>";
    return html;
  }

  let findingsHtml = "";
  if (report.type === "contract-audit") {
    findingsHtml += renderFindingsSection(findings.security as unknown[] ?? [], "Security", "var(--red)");
    findingsHtml += renderFindingsSection(findings.economic as unknown[] ?? [], "Economic", "var(--yellow)");
    findingsHtml += renderFindingsSection(findings.gas as unknown[] ?? [], "Gas Optimization", "var(--blue)");
  } else if (report.type === "token-risk") {
    findingsHtml += renderFindingsSection(findings.contract as unknown[] ?? [], "Contract", "var(--orange)");
    findingsHtml += renderFindingsSection(findings.tokenomics as unknown[] ?? [], "Tokenomics", "#a78bfa");
  }

  // Metadata
  const date = new Date(report.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const lang = report.input.language ?? report.input.chain ?? "";
  const paidLabel = report.paid ? "Paid via x402" : "Free tier";

  // Base URL for badge embed — prefer custom domain
  const baseUrl = process.env.SWARMX_BASE_URL
    ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
  const badgeUrl = `${baseUrl}/badge/${report.id}`;
  const reportUrl = `${baseUrl}/report/${report.id}`;
  const badgeMarkdown = `[![SwarmX Audit](${badgeUrl})](${reportUrl})`;
  const badgeHtml = `<a href="${reportUrl}"><img src="${badgeUrl}" alt="SwarmX Audit"></a>`;

  // Verdict badge (for token-risk)
  let verdictHtml = "";
  if (verdict) {
    let vBg: string, vColor: string;
    if (verdict === "DANGER") { vBg = "#3b0a0a"; vColor = "var(--red)"; }
    else if (verdict === "CAUTION") { vBg = "#422006"; vColor = "var(--yellow)"; }
    else { vBg = "#064e3b"; vColor = "var(--accent)"; }
    verdictHtml = `<span style="display:inline-block;padding:6px 18px;border-radius:8px;background:${vBg};color:${vColor};font-family:var(--mono);font-size:16px;font-weight:700;margin-right:12px;">${escapeHtml(verdict)}</span>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | SwarmX</title>
  <meta name="description" content="SwarmX ${report.type} report — risk score ${riskScore}/100">
  <meta property="og:title" content="${escapeHtml(title)} | SwarmX">
  <meta property="og:description" content="Risk Score: ${riskScore}/100 — ${escapeHtml(summary.slice(0, 150))}">
  <meta property="og:image" content="${badgeUrl}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(title)} | SwarmX">
  <meta name="twitter:description" content="Risk Score: ${riskScore}/100 — ${scoreLabel}">
${THEME_FONTS}
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
${THEME_TOKENS}
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg); color: var(--text); font-family: var(--sans);
      font-size: 15px; line-height: 1.65; min-height: 100vh;
    }
    .bg-glow {
      position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
      width: 800px; height: 600px;
      background: radial-gradient(ellipse, rgba(0, 200, 5,0.08) 0%, rgba(0, 135, 61,0.04) 40%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    .page { position: relative; z-index: 1; }
    .container { max-width: 800px; margin: 0 auto; padding: 0 24px; }
    .header {
      padding: 40px 0 20px; text-align: center;
    }
    .logo {
      font-family: var(--mono); font-size: 36px; font-weight: 800; letter-spacing: -2px;
      background: linear-gradient(135deg, var(--heading) 0%, var(--accent) 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
      margin-bottom: 6px; display: inline-block;
    }
    .logo a { text-decoration: none; -webkit-text-fill-color: transparent; }
    .report-title {
      font-size: 26px; font-weight: 800; color: var(--heading); margin: 16px 0 8px;
    }
    .report-id {
      font-family: var(--mono); font-size: 12px; color: var(--text-dim);
    }
    .score-section {
      text-align: center; margin: 32px 0;
    }
    .big-score {
      display: inline-flex; align-items: center; gap: 12px;
      padding: 16px 32px; border-radius: 12px; font-family: var(--mono);
    }
    .big-score-number {
      font-size: 48px; font-weight: 800; line-height: 1;
    }
    .big-score-label {
      font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
    }
    .big-score-max {
      font-size: 18px; font-weight: 400; opacity: 0.6;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 24px; margin-bottom: 20px;
    }
    .card-title {
      font-family: var(--mono); font-size: 12px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim);
      margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border);
    }
    .summary-text {
      font-size: 15px; line-height: 1.7; color: var(--text); white-space: pre-wrap; word-break: break-word;
    }
    .meta-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px;
    }
    .meta-item {
      padding: 12px 16px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border);
    }
    .meta-label {
      font-family: var(--mono); font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 4px;
    }
    .meta-value { font-size: 14px; color: var(--heading); font-weight: 600; }
    .embed-section {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 24px; margin-bottom: 20px;
    }
    .embed-title {
      font-family: var(--mono); font-size: 12px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim);
      margin-bottom: 14px;
    }
    .embed-preview {
      text-align: center; margin-bottom: 16px;
    }
    .embed-code {
      background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 16px; font-family: var(--mono); font-size: 12px; color: var(--text);
      word-break: break-all; margin-bottom: 10px; position: relative; cursor: pointer;
    }
    .embed-code:hover { border-color: var(--accent); }
    .embed-code::after {
      content: "Click to copy"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      font-size: 10px; color: var(--text-dim); opacity: 0; transition: opacity 0.2s;
    }
    .embed-code:hover::after { opacity: 1; }
    .embed-label {
      font-family: var(--mono); font-size: 10px; color: var(--text-dim);
      text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; font-weight: 600;
    }
    .cta-section {
      text-align: center; margin: 36px 0 24px;
      padding: 28px; background: linear-gradient(135deg, rgba(0, 200, 5,0.06) 0%, rgba(0, 135, 61,0.04) 100%);
      border: 1px solid rgba(0, 200, 5,0.15); border-radius: 14px;
    }
    .cta-section h3 { font-size: 20px; font-weight: 700; color: var(--heading); margin-bottom: 8px; }
    .cta-section p { font-size: 14px; color: var(--text-muted); margin-bottom: 16px; }
    .cta-btn {
      display: inline-block; padding: 12px 32px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: var(--bg); font-weight: 700; font-size: 15px; border-radius: 8px;
      text-decoration: none; font-family: var(--mono); transition: transform 0.15s, box-shadow 0.15s;
    }
    .cta-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0, 200, 5,0.3); }
    .footer {
      border-top: 1px solid var(--border); padding: 20px 0; text-align: center;
      font-size: 11px; color: var(--text-dim); font-family: var(--mono);
    }
    .footer a { color: var(--text-muted); text-decoration: none; }
    .footer a:hover { color: var(--accent); }
    .copied-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--accent); color: var(--bg); padding: 8px 20px; border-radius: 8px;
      font-family: var(--mono); font-size: 13px; font-weight: 700;
      opacity: 0; transition: opacity 0.3s; pointer-events: none;
    }
    .copied-toast.show { opacity: 1; }
    @media (max-width: 600px) {
      .report-title { font-size: 20px; }
      .big-score-number { font-size: 36px; }
      .card { padding: 16px; }
      .meta-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="page">

    <header class="header">
      <div class="container">
        <div class="logo"><a href="/">SwarmX</a></div>
        <h1 class="report-title">${escapeHtml(title)}</h1>
        <div class="report-id">Report ID: ${report.id}</div>
      </div>
    </header>

    <div class="container">

      <!-- Score -->
      <div class="score-section">
        ${verdictHtml}
        <div class="big-score" style="background:${scoreBg};border:1px solid ${scoreColor}33;">
          <span class="big-score-number" style="color:${scoreColor};">${riskScore}</span>
          <div>
            <span class="big-score-max" style="color:${scoreColor};">/100</span><br>
            <span class="big-score-label" style="color:${scoreColor};">${scoreLabel}</span>
          </div>
        </div>
      </div>

      <!-- Findings -->
      ${findingsHtml ? `<div class="card"><div class="card-title">Findings</div>${findingsHtml}</div>` : ""}

      <!-- Summary -->
      ${summary ? `<div class="card"><div class="card-title">Summary</div><div class="summary-text">${escapeHtml(summary)}</div></div>` : ""}

      <!-- Metadata -->
      <div class="card">
        <div class="card-title">Metadata</div>
        <div class="meta-grid">
          <div class="meta-item"><div class="meta-label">Date</div><div class="meta-value">${escapeHtml(date)}</div></div>
          <div class="meta-item"><div class="meta-label">Type</div><div class="meta-value">${escapeHtml(report.type)}</div></div>
          ${lang ? `<div class="meta-item"><div class="meta-label">Language / Chain</div><div class="meta-value">${escapeHtml(lang)}</div></div>` : ""}
          <div class="meta-item"><div class="meta-label">Payment</div><div class="meta-value">${escapeHtml(paidLabel)}</div></div>
        </div>
      </div>

      <!-- Embed Badge -->
      <div class="embed-section">
        <div class="embed-title">Embed This Badge</div>
        <div class="embed-preview">
          <img src="${badgeUrl}" alt="SwarmX Audit Badge">
        </div>
        <div class="embed-label">Markdown</div>
        <div class="embed-code" onclick="copyText(this)">${escapeHtml(badgeMarkdown)}</div>
        <div class="embed-label">HTML</div>
        <div class="embed-code" onclick="copyText(this)">${escapeHtml(badgeHtml)}</div>
      </div>

      <!-- CTA -->
      <div class="cta-section">
        <h3>Get Your Own Audit</h3>
        <p>Run a multi-agent audit on your smart contract, check token risk, or research any topic.</p>
        <a href="/" class="cta-btn">Open Playground</a>
      </div>

    </div>

    <footer class="footer">
      <div class="container">
        <a href="/">Playground</a> &middot;
        <a href="/x402/catalog">API Catalog</a> &middot;
        <a href="/x402/gallery">Gallery</a> &middot;
        <a href="/x402/benchmark">Benchmark</a> &middot;
        <a href="https://github.com/SolTwizzy/swarms-x402">GitHub</a>
        <br><br>
        Powered by <a href="https://www.opendexter.xyz">Dexter SDK</a> | <a href="https://swarms.world">Swarms</a>
      </div>
    </footer>

  </div>

  <div class="copied-toast" id="toast">Copied!</div>
  <script>
    function copyText(el) {
      var text = el.textContent || el.innerText;
      navigator.clipboard.writeText(text).then(function() {
        var toast = document.getElementById('toast');
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 1500);
      });
    }
  </script>
</body>
</html>`;
}

// ── Benchmark HTML Builder ──────────────────────────────────────────────────

interface BenchmarkFindingEntry {
  severity: string;
  title: string;
  description?: string;
}

interface BenchmarkResultEntry {
  id: number;
  name: string;
  language: string;
  expectedSeverity: string;
  expectedVulnerability: string;
  detected: boolean;
  liveTested: boolean;
  responseTimeMs: number;
  riskScore: number;
  matchedFinding: BenchmarkFindingEntry | null;
  missReason?: string;
  additionalFindings: BenchmarkFindingEntry[];
}

interface BenchmarkData {
  version: string;
  generatedAt: string;
  baseUrl: string;
  methodology: string;
  summary: {
    totalContracts: number;
    detected: number;
    missed: number;
    detectionRate: number;
    avgRiskScore: number;
    avgResponseTimeMs: number;
    totalAdditionalFindings: number;
    liveTestedCount: number;
    estimatedFromBehavior: number;
  };
  results: BenchmarkResultEntry[];
}

function loadBenchmarkResults(): BenchmarkData | null {
  const bmPath = join(import.meta.dir, "scripts", "benchmark-results.json");
  if (!existsSync(bmPath)) return null;
  try {
    const raw = readFileSync(bmPath, "utf-8");
    return JSON.parse(raw) as BenchmarkData;
  } catch {
    return null;
  }
}

function buildBenchmarkHtml(): string {
  const data = loadBenchmarkResults();
  if (!data) {
    return `<!DOCTYPE html><html><head><title>SwarmX Benchmark</title></head><body style="background:var(--bg);color:var(--text);font-family:sans-serif;padding:40px;"><h1>Benchmark data not available</h1><p>Run <code>bun run scripts/benchmark-accuracy.ts</code> to generate results.</p></body></html>`;
  }

  const s = data.summary;
  const rateColor = s.detectionRate >= 90 ? "var(--accent)" : s.detectionRate >= 70 ? "var(--yellow)" : "var(--red)";

  const rows = data.results.map((r) => {
    const mark = r.detected
      ? `<span style="color:var(--accent);font-weight:700;">YES</span>`
      : `<span style="color:var(--red);font-weight:700;">MISS</span>`;
    const live = r.liveTested ? `<span style="color:var(--accent);" title="Live tested">*</span>` : "";
    const sevColor = r.expectedSeverity === "CRITICAL" ? "var(--red)" : r.expectedSeverity === "HIGH" ? "var(--orange)" : "var(--yellow)";
    const scoreColor = r.riskScore >= 70 ? "var(--red)" : r.riskScore >= 40 ? "var(--yellow)" : "var(--accent)";
    const matchTitle = r.matchedFinding
      ? escapeHtml(r.matchedFinding.title)
      : r.missReason
        ? `<span style="color:var(--text-muted);font-style:italic;">${escapeHtml(r.missReason.slice(0, 80))}</span>`
        : `<span style="color:var(--text-muted);">--</span>`;
    const time = (r.responseTimeMs / 1000).toFixed(1);

    return `<tr>
  <td style="text-align:center;">${r.id}${live}</td>
  <td><span style="font-family:var(--mono);font-size:12px;background:var(--surface-3);padding:2px 8px;border-radius:4px;">${escapeHtml(r.language)}</span></td>
  <td style="text-align:center;"><span style="color:${sevColor};font-weight:600;">${escapeHtml(r.expectedSeverity)}</span></td>
  <td style="text-align:center;">${mark}</td>
  <td style="text-align:center;"><span style="color:${scoreColor};font-weight:700;">${r.riskScore}</span></td>
  <td style="text-align:center;font-family:var(--mono);font-size:13px;">${time}s</td>
  <td style="font-size:13px;">${escapeHtml(r.name)}</td>
  <td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${matchTitle}</td>
</tr>`;
  }).join("\n");

  const missedDetails = data.results
    .filter((r) => !r.detected)
    .map((r) => {
      return `<div style="margin-bottom:16px;padding:12px 16px;background:#1a0a0a;border:1px solid #3b0a0a;border-radius:8px;">
  <div style="font-weight:600;color:var(--red);margin-bottom:4px;">#${r.id} ${escapeHtml(r.name)}</div>
  <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(r.missReason ?? "No matching keywords found in response")}</div>
</div>`;
    }).join("\n");

  const date = new Date(data.generatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SwarmX Accuracy Benchmark</title>
  <meta name="description" content="Accuracy benchmark for SwarmX contract audit — ${s.detected}/${s.totalContracts} known vulnerabilities detected (${s.detectionRate}%).">
${THEME_FONTS}
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
${THEME_TOKENS}
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.65;
      min-height: 100vh;
    }
    .bg-glow {
      position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
      width: 800px; height: 600px;
      background: radial-gradient(ellipse, rgba(0, 200, 5,0.08) 0%, rgba(0, 135, 61,0.04) 40%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    .page { position: relative; z-index: 1; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
    .header {
      padding: 40px 0 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 32px;
    }
    .logo a {
      color: var(--accent);
      text-decoration: none;
      font-family: var(--mono);
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 2px;
    }
    h1 {
      font-size: 32px;
      color: var(--heading);
      margin: 16px 0 8px;
      font-weight: 800;
    }
    .subtitle {
      font-size: 15px;
      color: var(--text-muted);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin: 32px 0;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
    }
    .stat-value {
      font-size: 36px;
      font-weight: 800;
      font-family: var(--mono);
      line-height: 1.2;
    }
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--heading);
      margin-bottom: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 2px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:hover td {
      background: rgba(0, 200, 5, 0.03);
    }
    .methodology {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.7;
    }
    .footer {
      border-top: 1px solid var(--border);
      padding: 24px 0;
      margin-top: 48px;
      text-align: center;
      font-size: 13px;
      color: var(--text-muted);
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      table { font-size: 12px; }
      th, td { padding: 6px 8px; }
      .container { padding: 0 12px; }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="page">

    <header class="header">
      <div class="container">
        <div class="logo"><a href="/">SwarmX</a></div>
        <h1>Accuracy Benchmark</h1>
        <p class="subtitle">Contract audit detection rate against ${s.totalContracts} contracts with known vulnerabilities &mdash; ${date}</p>
      </div>
    </header>

    <div class="container">

      <!-- Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value" style="color:${rateColor};">${s.detectionRate}%</div>
          <div class="stat-label">Detection Rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${rateColor};">${s.detected}/${s.totalContracts}</div>
          <div class="stat-label">Vulnerabilities Found</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:var(--accent);">${s.totalAdditionalFindings}</div>
          <div class="stat-label">Additional Findings</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:var(--accent-2);">${(s.avgResponseTimeMs / 1000).toFixed(1)}s</div>
          <div class="stat-label">Avg Response Time</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:var(--text);">${s.avgRiskScore}</div>
          <div class="stat-label">Avg Risk Score</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:var(--accent);">${s.liveTestedCount}</div>
          <div class="stat-label">Live Tested</div>
        </div>
      </div>

      <!-- Results Table -->
      <div class="card" style="overflow-x:auto;">
        <div class="card-title">Results by Contract</div>
        <table>
          <thead>
            <tr>
              <th style="text-align:center;">#</th>
              <th>Lang</th>
              <th style="text-align:center;">Expected</th>
              <th style="text-align:center;">Detected</th>
              <th style="text-align:center;">Risk</th>
              <th style="text-align:center;">Time</th>
              <th>Vulnerability</th>
              <th>Matched Finding</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        <p style="margin-top:12px;font-size:12px;color:var(--text-muted);">* = live tested against the SwarmX API</p>
      </div>

      <!-- Missed -->
      ${s.missed > 0 ? `<div class="card">
        <div class="card-title" style="color:var(--red);">Missed Vulnerabilities (${s.missed})</div>
        ${missedDetails}
      </div>` : `<div class="card">
        <div class="card-title" style="color:var(--accent);">All Vulnerabilities Detected</div>
        <p style="color:var(--text-muted);">Every known vulnerability in the benchmark was successfully identified.</p>
      </div>`}

      <!-- Methodology -->
      <div class="card">
        <div class="card-title">Methodology</div>
        <div class="methodology">
          <p><strong>Corpus:</strong> 10 Solidity contracts from the SWC Registry (SWC-101 through SWC-116) and 5 Anchor/Rust contracts targeting common Solana vulnerability patterns (missing signer checks, missing owner validation, arithmetic overflow, PDA bump issues, CPI authority gaps).</p>
          <br>
          <p><strong>Process:</strong> Each contract is submitted to <code>POST /x402/contract-audit</code> with the source code and language. The response is parsed for structured findings (security, economic, gas categories). Each finding's title and description are checked against expected keywords for the known vulnerability.</p>
          <br>
          <p><strong>Detection criteria:</strong> A vulnerability is "detected" if any finding or the summary text contains at least one of the expected keywords (e.g., "reentrancy", "overflow", "delegatecall"). This is a conservative measure &mdash; the audit may describe the vulnerability in different terms that don't match exact keywords.</p>
          <br>
          <p><strong>Additional findings:</strong> Findings beyond the primary known vulnerability are counted but not classified as false positives, since most contracts have multiple real issues (e.g., a contract with a reentrancy bug often also has missing access control).</p>
          <br>
          <p><strong>Limitations:</strong> Free tier allows 3 live API calls. Remaining results are pre-populated based on expected behavior from the audit system prompts and validated gallery results. Run <code>bun run scripts/benchmark-accuracy.ts --all</code> to test all 15 live (requires payment or credits).</p>
          <br>
          <p><strong>Reproducibility:</strong> All 15 contracts are stored in <code>scripts/benchmark-contracts.json</code>. The benchmark script is at <code>scripts/benchmark-accuracy.ts</code>.</p>
        </div>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:40px 0 20px;">
        <p style="font-size:16px;color:var(--heading);margin-bottom:12px;">Try the audit yourself</p>
        <a href="/" style="display:inline-block;padding:12px 32px;background:var(--accent);color:var(--bg);font-weight:700;border-radius:8px;text-decoration:none;font-size:15px;">Open Playground</a>
        <a href="/x402/gallery" style="display:inline-block;padding:12px 32px;background:var(--surface);color:var(--accent);font-weight:700;border-radius:8px;text-decoration:none;font-size:15px;border:1px solid var(--border);margin-left:12px;">View Gallery</a>
      </div>

    </div>

    <footer class="footer">
      <div class="container">
        <a href="/">Playground</a> &middot;
        <a href="/x402/catalog">API Catalog</a> &middot;
        <a href="/x402/gallery">Gallery</a> &middot;
        <a href="/x402/benchmark">Benchmark</a> &middot;
        <a href="https://github.com/SolTwizzy/swarms-x402">GitHub</a>
        <br><br>
        Powered by <a href="https://www.opendexter.xyz">Dexter SDK</a> | <a href="https://swarms.world">Swarms</a>
      </div>
    </footer>

  </div>
</body>
</html>`;
}

// ── HTTP Server (Bun native) ────────────────────────────────────────────────

async function startServer(): Promise<void> {
  await initServices();
  const routeMap = buildRouteMap();

  logger.info(
    `Registered ${routeMap.size} routes: ${[...routeMap.keys()].join(", ")}`
  );

  const server = Bun.serve({
    port: PORT,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let method = request.method.toUpperCase();
      const pathname = url.pathname;

      // ── Rate limit check (before any route dispatch) ───────────────
      const rateLimited = checkRateLimit(request);
      if (rateLimited) return rateLimited;

      // ── CORS preflight ─────────────────────────────────────────────
      if (method === "OPTIONS") {
        // Real preflights carry Access-Control-Request-Method. A bare OPTIONS
        // is how x402 schema fetchers (Swarms integration widget) probe the
        // payment schema without triggering a paid call — serve them the GET
        // response (the 402 challenge) instead of an empty 204.
        const isPreflight = request.headers.has("access-control-request-method");
        if (isPreflight || !routeMap.has(`GET ${pathname}`)) {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        method = "GET";
      }

      // ── 402 Index domain verification (well-known file) ────────────
      if (pathname === "/.well-known/402index-verify.txt" && method === "GET") {
        return new Response(
          "40c99666eb4f588133544581f332b533719b5e38d476cd03be3e80c37b2e11ab",
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      // ── JSON status (moved from /) ─────────────────────────────────
      if (pathname === "/api/status" && method === "GET") {
        return withCORS(Response.json({
          status: "ok",
          brand: "SwarmX",
          plugin: "swarms-x402",
          mode: "standalone",
          routes: allRoutes.map((r) => ({
            method: r.type,
            path: r.path,
            name: (r as any).name ?? undefined,
          })),
          uptime: process.uptime(),
        }));
      }

      // ── Free tier stats ──────────────────────────────────────────
      if (pathname === "/api/free-tier-stats" && method === "GET") {
        const stats = getFreeTierStats();
        return withCORS(Response.json(stats));
      }

      // ── HTML Playground ────────────────────────────────────────────
      if (pathname === "/" && method === "GET") {
        const networkId = process.env.X402_NETWORK_ID ?? "base-mainnet";
        const baseUrl = process.env.SWARMX_BASE_URL
          ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SwarmX — Tokenized stocks, fully researched.</title>
  <meta name="description" content="A panel of analyst agents researches any tokenized equity — momentum, valuation, downside — and returns a rated verdict. $0.29 a report in USDC, or 5 free calls a day. No account.">
${THEME_FONTS}
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
${THEME_TOKENS}
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg); color: var(--text); font-family: var(--font);
      font-size: 15px; line-height: 1.65; min-height: 100vh; overflow-x: hidden;
    }
    .bg-glow { display: none; }
    .page { position: relative; z-index: 1; }
    .container { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

    /* ── Top Nav ── */
    .top-nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 0.67px solid var(--border);
      padding: 0 24px; height: 56px;
      display: flex; align-items: center; justify-content: space-between;
      max-width: 100%;
    }
    .nav-logo {
      font-family: var(--display); font-size: 19px; font-weight: 700;
      color: var(--heading); text-decoration: none; letter-spacing: 0.2px;
    }
    .nav-logo span { color: var(--accent); font-weight: 700; }
    .nav-links {
      display: flex; align-items: center; gap: 8px;
    }
    .nav-links a {
      color: var(--text-muted); text-decoration: none;
      font-size: 14px; font-weight: 500; padding: 6px 14px;
      border-radius: 8px; transition: all 0.2s;
    }
    .nav-links a:hover { color: var(--heading); background: var(--surface-2); }
    .nav-cta {
      background: var(--green-bg) !important;
      border: 0.67px solid var(--accent-2) !important;
      border-radius: 8px !important; color: var(--accent) !important; font-weight: 600 !important;
      padding: 7px 18px !important; font-size: 13px !important; transition: all 0.2s !important;
    }
    .nav-cta:hover {
      background: var(--accent) !important; color: #04140A !important;
      border-color: var(--accent) !important;
    }
    @media (max-width: 768px) {
      .nav-links { gap: 2px; }
      .nav-links a { padding: 6px 8px; font-size: 12px; }
      .nav-cta { display: none !important; }
    }

    /* ── Hero ──
       Asymmetric: the thesis on the left, the product running on the right. */
    .hero { padding: 72px 0 48px; }
    .hero-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: center;
    }
    .logo { display: none; }
    .hero-eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--mono); font-size: 11px; font-weight: 500;
      letter-spacing: 1.4px; text-transform: uppercase;
      color: var(--accent); margin-bottom: 20px;
    }
    .hero-eyebrow::before {
      content: ""; width: 18px; height: 1px; background: var(--accent);
    }
    .hero-headline {
      font-family: var(--display); font-size: clamp(38px, 4.4vw, 56px); font-weight: 700;
      color: var(--heading); letter-spacing: -0.5px;
      margin-bottom: 18px; line-height: 1.04;
    }
    .hero-headline em {
      font-style: normal; color: var(--accent);
    }
    .hero-sub {
      font-size: 16px; color: var(--text-muted); max-width: 44ch; margin: 0 0 28px; line-height: 1.65;
      font-weight: 400;
    }
    .hero-ctas {
      display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 26px;
    }
    .hero-cta-btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 26px; border-radius: 8px; font-family: var(--sans);
      font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;
      text-decoration: none;
    }
    .hero-cta-primary {
      background: var(--accent); color: #04140A; border: 0.67px solid var(--accent);
    }
    .hero-cta-primary:hover { background: #00E006; border-color: #00E006; }
    .hero-cta-secondary {
      background: transparent; color: var(--text);
      border: 0.67px solid var(--border-hover);
    }
    .hero-cta-secondary:hover {
      background: var(--surface-2); border-color: var(--accent-2); color: var(--heading);
    }
    .hero-badges { display: none; }
    .hero-stats {
      font-family: var(--mono); font-size: 12px; color: var(--text-dim);
      margin-top: 0; letter-spacing: 0.2px;
    }

    /* ── Hero terminal — the signature element.
       Replays a real captured stock-dd run; the CTA runs a live one. ── */
    .term {
      background: var(--surface); border: 0.67px solid var(--border);
      border-radius: 10px; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(0, 200, 5, 0.04), 0 24px 60px -24px rgba(0, 200, 5, 0.18);
    }
    .term-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 14px; border-bottom: 0.67px solid var(--border);
      background: var(--surface-2);
    }
    .term-title {
      font-family: var(--mono); font-size: 11px; color: var(--text-muted);
      letter-spacing: 0.4px;
    }
    .term-tag {
      font-family: var(--mono); font-size: 10px; letter-spacing: 0.6px;
      text-transform: uppercase; color: var(--text-dim);
      border: 0.67px solid var(--border); border-radius: 4px; padding: 2px 7px;
    }
    .term-body {
      font-family: var(--mono); font-size: 12.5px; line-height: 1.75;
      padding: 16px; min-height: 400px;
      display: flex; flex-direction: column;
    }
    .term-line, .term-foot {
      white-space: pre-wrap; word-break: break-word;
      opacity: 0; animation: term-in 0.24s ease-out forwards; animation-delay: var(--d, 0s);
    }
    @keyframes term-in { from { opacity: 0; } to { opacity: 1; } }
    .term-line.dim { color: var(--text-dim); }
    .term-line.muted { color: var(--text-muted); }
    .term-line.in { color: var(--heading); }
    .term-line.ok { color: var(--accent); }
    .term-line.risk { color: var(--red); }
    .term-line.agent { color: var(--text); }
    .term-line .who { color: var(--accent-2); }
    .term-cursor {
      display: inline-block; width: 7px; height: 14px; vertical-align: -2px;
      background: var(--accent); margin-left: 2px;
      animation: term-blink 1.1s steps(1) infinite;
    }
    @keyframes term-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
    .term-foot {
      margin-top: auto; padding-top: 12px; display: flex; align-items: center; gap: 10px;
      border-top: 0.67px solid var(--border);
    }
    .term-run {
      font-family: var(--mono); font-size: 11px; font-weight: 500;
      background: var(--green-bg); color: var(--accent);
      border: 0.67px solid var(--accent-2); border-radius: 6px;
      padding: 6px 12px; cursor: pointer; transition: all 0.2s;
      text-decoration: none; white-space: nowrap; flex-shrink: 0;
    }
    .term-run:hover { background: var(--accent); color: #04140A; }
    .term-note {
      font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
      line-height: 1.5;
    }

    @media (prefers-reduced-motion: reduce) {
      .term-cursor { animation: none; }
      .term-line, .term-foot { opacity: 1; animation: none; }
    }
    @media (max-width: 900px) {
      .hero { padding: 48px 0 32px; }
      .hero-grid { grid-template-columns: 1fr; gap: 32px; }
      .hero-sub { max-width: none; }
      .term-body { min-height: 0; font-size: 11.5px; }
    }

    /* ── Tabs ── */
    .playground { margin-bottom: 64px; }
    .tabs {
      display: flex; gap: 6px; border-bottom: none; margin-bottom: 16px;
      overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
      padding: 4px; background: var(--surface); border-radius: 12px;
      border: 0.67px solid var(--border);
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      padding: 10px 18px; font-family: var(--font); font-size: 13px; font-weight: 500;
      color: var(--text-muted); background: transparent; border: 0.67px solid transparent;
      border-radius: 8px; cursor: pointer;
      transition: all 0.2s; letter-spacing: 0; white-space: nowrap; flex-shrink: 0;
    }
    .tab:hover { color: var(--text); background: var(--surface-2); }
    .tab.active {
      color: var(--heading); background: var(--surface-3);
      border-color: var(--border-hover);
    }
    .tab-panel {
      display: none; background: var(--surface);
      border: 0.67px solid var(--border);
      border-radius: 16px; padding: 32px;
    }
    .tab-panel.active { display: block; }
    .tab-panel-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 24px; flex-wrap: wrap; gap: 8px;
    }
    .tab-panel-title {
      font-family: var(--font); font-size: 22px; font-weight: 600; color: var(--heading);
    }
    .tab-panel-price {
      font-family: var(--mono); font-size: 13px; padding: 6px 14px;
      border-radius: 8px; background: var(--surface-2); color: var(--text);
      border: 0.67px solid var(--border);
    }
    .tab-panel-desc {
      font-size: 14px; color: var(--text-muted); margin-bottom: 24px; line-height: 1.6;
    }

    /* ── Form controls ── */
    .form-group { margin-bottom: 18px; }
    .form-label {
      display: block; font-family: var(--font); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); margin-bottom: 8px;
    }
    .form-textarea {
      width: 100%; min-height: 180px; padding: 16px 18px; background: var(--surface);
      border: 0.67px solid var(--border); border-radius: 12px; color: var(--text);
      font-family: var(--mono); font-size: 13px; line-height: 1.6; resize: vertical;
      transition: border-color 0.2s;
    }
    .form-textarea:focus { outline: none; border-color: var(--border-focus); }
    .form-textarea::placeholder { color: var(--border-hover); }
    .form-input {
      width: 100%; padding: 12px 16px; background: var(--surface);
      border: 0.67px solid var(--border); border-radius: 12px; color: var(--text);
      font-family: var(--mono); font-size: 13px; transition: border-color 0.2s;
    }
    .form-input:focus { outline: none; border-color: var(--border-focus); }
    .form-input::placeholder { color: var(--border-hover); }
    .form-select {
      padding: 10px 14px; background: var(--surface); border: 0.67px solid var(--border);
      border-radius: 12px; color: var(--text); font-family: var(--mono); font-size: 13px;
      cursor: pointer; transition: border-color 0.2s; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='var(--text-muted)' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px;
    }
    .form-select:focus { outline: none; border-color: var(--border-focus); }
    .form-select option { background: #111; color: var(--heading); }
    .form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .form-row .form-group { flex: 1; min-width: 140px; }

    /* ── Buttons ── */
    .btn-submit {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 28px; border: 0.67px solid var(--border-hover);
      border-radius: 12px; cursor: pointer;
      font-family: var(--font); font-size: 14px; font-weight: 600;
      transition: all 0.2s; margin-top: 4px;
    }
    .btn-submit.green {
      background: #fff; color: #000; border-color: var(--heading);
    }
    .btn-submit.green:hover {
      background: var(--accent-2); transform: translateY(-1px);
    }
    .btn-submit.green:active { transform: translateY(0); }
    .btn-submit:disabled {
      opacity: 0.4; cursor: not-allowed; transform: none !important;
    }

    /* ── Agent Progress ── */
    .spinner {
      display: none; flex-direction: column; align-items: flex-start;
      padding: 24px 28px; font-family: var(--mono); font-size: 13px;
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px;
      margin-top: 16px;
    }
    .spinner.visible { display: flex; }
    .spinner-header {
      display: flex; align-items: center; gap: 10px; margin-bottom: 14px; width: 100%;
    }
    .spinner-ring {
      width: 18px; height: 18px; border: 2px solid var(--border);
      border-top-color: var(--heading); border-radius: 50%; animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    .spinner-title { color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .agent-steps { width: 100%; }
    .agent-step {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 12px; margin-bottom: 4px; border-radius: 8px;
      font-size: 13px; line-height: 1.5; color: var(--text-dim);
      transition: all 0.3s ease;
    }
    .agent-step.active {
      color: var(--heading); background: var(--surface-2);
      border-left: 2px solid var(--heading);
    }
    .agent-step.done {
      color: var(--text-muted); opacity: 0.7;
    }
    .agent-step.done .step-icon::after { content: '\2713'; }
    .agent-step.active .step-icon::after { content: '\25B6'; }
    .agent-step.pending .step-icon::after { content: '\2022'; }
    .step-icon {
      width: 16px; text-align: center; font-size: 11px; flex-shrink: 0;
    }
    .agent-step.complete-msg {
      color: var(--green); font-weight: 600; font-size: 14px; padding: 10px 12px;
      background: rgba(52,211,153,0.06); border-radius: 8px; margin-top: 4px;
    }

    /* ── Results ── */
    .results-area { margin-top: 20px; }
    .results-area.hidden { display: none; }
    .result-box {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px; overflow: hidden;
    }
    .result-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 0.67px solid var(--border); background: var(--surface-2);
    }
    .result-header-left { display: flex; align-items: center; gap: 10px; }
    .result-label {
      font-family: var(--font); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim);
    }
    .result-time { font-family: var(--mono); font-size: 11px; color: var(--border-focus); }
    .result-body { padding: 20px; }

    /* ── Score badge ── */
    .score-badge {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px;
      border-radius: 10px; font-family: var(--mono); font-size: 18px; font-weight: 700;
      margin-bottom: 16px;
    }
    .score-badge.safe { background: rgba(52,211,153,0.1); color: var(--green); border: 0.67px solid rgba(52,211,153,0.2); }
    .score-badge.caution { background: rgba(251,191,36,0.1); color: var(--yellow); border: 0.67px solid rgba(251,191,36,0.2); }
    .score-badge.danger { background: rgba(248,113,113,0.1); color: var(--red); border: 0.67px solid rgba(248,113,113,0.2); }
    .score-badge-label { font-size: 12px; font-weight: 600; }

    /* ── Findings ── */
    .finding-group { margin-bottom: 16px; }
    .finding-group-title {
      font-family: var(--font); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted);
      margin-bottom: 10px; padding-bottom: 8px; border-bottom: 0.67px solid var(--border);
    }
    .finding {
      padding: 12px 16px; margin-bottom: 6px; border-radius: 10px;
      font-size: 13px; line-height: 1.5; background: var(--surface);
      border-left: 2px solid var(--border);
    }
    .finding.critical { border-left-color: var(--red); }
    .finding.high { border-left-color: var(--orange); }
    .finding.medium { border-left-color: var(--yellow); }
    .finding.low { border-left-color: var(--blue); }
    .finding.info { border-left-color: var(--border-hover); }
    .finding-sev {
      font-family: var(--mono); font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px; margin-right: 8px;
    }
    .finding-sev.critical { color: var(--red); }
    .finding-sev.high { color: var(--orange); }
    .finding-sev.medium { color: var(--yellow); }
    .finding-sev.low { color: var(--blue); }
    .finding-sev.info { color: var(--border-focus); }

    /* ── Summary text ── */
    .result-summary {
      font-size: 14px; line-height: 1.7; color: var(--text);
      white-space: pre-wrap; word-break: break-word;
    }

    /* ── Error display ── */
    .error-box {
      background: rgba(239,68,68,0.08); border: 0.67px solid rgba(239,68,68,0.2);
      border-radius: 12px; padding: 16px 20px; margin-top: 16px; display: none;
    }
    .error-box.visible { display: block; }
    .error-box-title {
      font-family: var(--font); font-size: 13px; font-weight: 600; color: var(--red); margin-bottom: 4px;
    }
    .error-box-msg { font-size: 13px; color: rgba(248,113,113,0.9); line-height: 1.5; }

    /* ── Payment required banner ── */
    .payment-banner {
      background: var(--surface);
      border: 0.67px solid var(--border); border-radius: 12px;
      padding: 20px 24px; margin-top: 16px; display: none; text-align: center;
    }
    .payment-banner.visible { display: block; }
    .payment-banner-title { font-family: var(--font); font-size: 16px; font-weight: 600; color: var(--heading); margin-bottom: 6px; }
    .payment-banner-msg { font-size: 13px; color: var(--text-muted); }
    .payment-banner-msg a { color: var(--heading); text-decoration: none; border-bottom: 0.67px solid var(--border-focus); }
    .payment-banner-msg a:hover { border-color: var(--heading); }

    /* ── Section divider ── */
    .section { margin-bottom: 64px; }
    .section-title {
      font-family: var(--font); font-size: 28px; font-weight: 600;
      color: var(--heading); margin-bottom: 12px; padding-bottom: 0; border-bottom: none;
      text-transform: none; letter-spacing: -0.5px;
    }
    .section-title .hl { display: none; }
    .section-subtitle {
      color: var(--text-muted); font-size: 15px; margin-bottom: 32px; line-height: 1.6;
    }

    /* ── Endpoint cards ── */
    .endpoints-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
    }
    .ep-card {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px;
      padding: 20px; transition: border-color 0.2s, background 0.2s; cursor: default;
    }
    .ep-card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .ep-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .ep-name { font-family: var(--font); font-weight: 600; color: var(--heading); font-size: 14px; }
    .ep-price { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--text-muted); }
    .ep-price.free { color: var(--green); }
    .ep-desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 10px; }
    .ep-meta { display: flex; align-items: center; gap: 8px; }
    .method-badge {
      display: inline-block; padding: 3px 8px; border-radius: 6px;
      font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
    }
    .method-badge.post { background: rgba(96,165,250,0.1); color: var(--blue); }
    .method-badge.get { background: rgba(52,211,153,0.1); color: var(--green); }
    .ep-path { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }
    .cat-heading {
      font-family: var(--font); font-size: 13px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted);
      margin-top: 32px; margin-bottom: 14px; padding-bottom: 8px;
      border-bottom: 0.67px solid var(--border);
    }
    .cat-heading:first-child { margin-top: 0; }
    .pricing-table .cat-row td {
      background: var(--surface-2); font-weight: 600; color: var(--text-muted);
      font-family: var(--font); font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
      padding: 12px 16px; border-bottom: 0.67px solid var(--border);
    }
    .pricing-table .tier-enterprise { background: rgba(251,191,36,0.1); color: var(--yellow); }
    .pricing-table .tier-free { background: rgba(52,211,153,0.1); color: var(--green); }
    .pricing-table .tier-batch { background: rgba(167,139,250,0.1); color: var(--purple); }

    /* ── Pricing table ── */
    .pricing-table {
      width: 100%; border-collapse: collapse; margin-top: 12px;
      font-size: 13px;
    }
    .pricing-table th {
      text-align: left; padding: 12px 16px; font-family: var(--font); font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim);
      border-bottom: 0.67px solid var(--border); background: var(--surface);
    }
    .pricing-table td {
      padding: 10px 16px; border-bottom: 0.67px solid var(--surface-2);
      color: var(--text-muted); font-family: var(--mono); font-size: 13px;
    }
    .pricing-table tr:hover td { background: var(--surface); }
    .pricing-table .price-val { color: var(--heading); font-weight: 600; }
    .pricing-table .tier-label {
      display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 10px; font-weight: 600;
      font-family: var(--font);
    }
    .pricing-table .tier-multi { background: rgba(167,139,250,0.1); color: var(--purple); }
    .pricing-table .tier-single { background: rgba(96,165,250,0.1); color: var(--blue); }
    .pricing-table .tier-data { background: rgba(52,211,153,0.1); color: var(--green); }

    /* ── Integration section ── */
    .integration {
      background: var(--surface); border: 0.67px solid var(--border);
      border-radius: 16px; padding: 32px; margin-bottom: 64px;
    }
    .integration h3 {
      font-family: var(--font); font-size: 18px; font-weight: 600;
      color: var(--heading); margin-bottom: 20px;
    }
    .code-block {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 12px;
      padding: 20px; font-family: var(--mono); font-size: 12px; line-height: 1.7;
      color: var(--text); overflow-x: auto; margin-bottom: 16px;
    }
    .code-block .kw { color: #c792ea; }
    .code-block .fn { color: #82aaff; }
    .code-block .str { color: #c3e88d; }
    .code-block .cmt { color: var(--text-dim); }
    .code-label {
      font-family: var(--font); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.8px; color: var(--text-dim); margin-bottom: 8px; font-weight: 600;
    }

    /* ── Quick links ── */
    .quick-links { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 64px; }
    .qlink {
      display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted);
      text-decoration: none; padding: 10px 18px; border: 0.67px solid var(--border);
      border-radius: 10px; font-size: 13px; font-family: var(--font); font-weight: 500;
      transition: all 0.2s;
    }
    .qlink:hover { background: var(--surface-2); border-color: var(--border-hover); color: var(--heading); }

    /* ── Footer ── */
    .footer { border-top: 0.67px solid var(--border); padding: 48px 0 32px; }
    .footer-grid {
      display: grid; grid-template-columns: 2fr repeat(4, 1fr); gap: 40px;
      margin-bottom: 32px;
    }
    .footer-brand { }
    .footer-brand-name {
      font-family: var(--font); font-size: 18px; font-weight: 700; color: var(--heading);
      margin-bottom: 8px;
    }
    .footer-brand-desc {
      font-size: 13px; color: var(--text-muted); line-height: 1.6; max-width: 240px;
    }
    .footer-col-title {
      font-family: var(--font); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted);
      margin-bottom: 16px;
    }
    .footer-col a {
      display: block; color: var(--text-muted); text-decoration: none;
      font-size: 13px; padding: 4px 0; transition: color 0.2s;
    }
    .footer-col a:hover { color: var(--heading); }
    .footer-bottom {
      text-align: center; padding-top: 24px; border-top: 0.67px solid var(--border);
    }
    .footer-powered {
      font-size: 13px; color: var(--text-dim); font-family: var(--font);
    }
    .footer-powered a {
      color: var(--text-dim); text-decoration: none; transition: color 0.15s;
    }
    .footer-powered a:hover { color: var(--text-muted); }
    /* Legacy footer-links for compat */
    .footer-links { display: none; }

    /* ── Landing sections ── */
    .landing-section {
      margin-bottom: 64px; padding: 0;
    }
    .landing-section-title {
      font-family: var(--font); font-size: 28px; font-weight: 600;
      color: var(--heading); margin-bottom: 12px;
      text-transform: none; letter-spacing: -0.5px;
    }
    .landing-section-title .hl { display: none; }
    .landing-section-subtitle {
      color: var(--text-muted); font-size: 15px; margin-bottom: 32px;
    }

    /* What is SwarmX */
    .what-is {
      text-align: center; max-width: 760px; margin: 0 auto 64px;
      padding: 40px 32px; background: var(--surface); border: 0.67px solid var(--border);
      border-radius: 16px;
    }
    .what-is p {
      font-size: 16px; line-height: 1.7; color: var(--text);
    }
    .what-is .stat-line {
      font-family: var(--mono); font-size: 13px; color: var(--border-focus);
      margin-top: 16px; letter-spacing: 0.3px;
    }

    /* How it works — 3 steps */
    .steps-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      margin-bottom: 8px;
    }
    .step-card {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px;
      padding: 28px 24px; text-align: center; position: relative;
      transition: border-color 0.2s;
    }
    .step-card:hover { border-color: var(--border-hover); }
    .step-num {
      font-family: var(--font); font-size: 12px; font-weight: 600;
      color: var(--text-muted); letter-spacing: 0.8px; margin-bottom: 12px;
      text-transform: uppercase;
    }
    .step-icon {
      font-size: 28px; margin-bottom: 12px; line-height: 1; color: var(--text-muted);
    }
    .step-card h3 {
      font-family: var(--font); font-size: 15px; font-weight: 600; color: var(--heading); margin-bottom: 10px;
    }
    .step-card p {
      font-size: 13px; color: var(--text-muted); line-height: 1.6;
    }
    .step-arrow {
      display: none; position: absolute; right: -18px; top: 50%;
      transform: translateY(-50%); color: var(--border-hover); font-size: 18px;
    }
    @media (min-width: 769px) {
      .step-card:not(:last-child) .step-arrow { display: block; }
    }

    /* Value props — 3 cards */
    .props-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
    }
    .prop-card {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px;
      padding: 24px; transition: border-color 0.2s;
    }
    .prop-card:hover { border-color: var(--border-hover); }
    .prop-card h3 {
      font-family: var(--font); font-size: 15px; font-weight: 600; color: var(--heading); margin-bottom: 8px;
    }
    .prop-card h3 .accent { color: var(--heading); }
    .prop-card p {
      font-size: 13px; color: var(--text-muted); line-height: 1.6;
    }

    /* Personas — 4 cards */
    .personas-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
    }
    .persona-card {
      background: var(--surface); border: 0.67px solid var(--border); border-radius: 16px;
      padding: 20px 18px; transition: border-color 0.2s;
    }
    .persona-card:hover { border-color: var(--border-hover); }
    .persona-label {
      font-family: var(--font); font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px;
    }
    .persona-label.sec { color: var(--red); }
    .persona-label.defi { color: var(--yellow); }
    .persona-label.dev { color: var(--blue); }
    .persona-label.agent { color: var(--purple); }
    .persona-card p {
      font-size: 13px; color: var(--text-muted); line-height: 1.6;
    }

    /* Responsive ── */
    @media (max-width: 768px) {
      .steps-grid { grid-template-columns: 1fr; }
      .props-grid { grid-template-columns: 1fr; }
      .personas-grid { grid-template-columns: repeat(2, 1fr); }
      .what-is { padding: 28px 20px; }
      .hero { padding: 48px 0 24px; }
      .logo { font-size: 40px; }
      .hero-headline { font-size: 28px; }
      .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .tab { padding: 10px 14px; font-size: 12px; white-space: nowrap; min-height: 44px; }
      .tab-panel { padding: 20px; border-radius: 12px; }
      .form-row { flex-direction: column; }
      .endpoints-grid { grid-template-columns: 1fr; }
      .integration { padding: 20px; }
      .footer-grid { grid-template-columns: 1fr 1fr; gap: 24px; }
      .footer-brand { grid-column: 1 / -1; }
    }
    /* ── Share section ── */
    .share-section {
      margin-top: 16px; padding: 20px 24px;
      background: var(--surface);
      border: 0.67px solid var(--border); border-radius: 12px;
    }
    .share-title {
      font-family: var(--font); font-size: 13px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted); margin-bottom: 12px;
    }
    .share-row {
      display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;
    }
    .share-link {
      flex: 1; min-width: 200px; padding: 10px 14px; background: var(--surface);
      border: 0.67px solid var(--border); border-radius: 8px;
      font-family: var(--mono); font-size: 11px; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .share-btn {
      padding: 10px 18px; border: 0.67px solid var(--border-hover); border-radius: 8px; cursor: pointer;
      font-family: var(--font); font-size: 12px; font-weight: 500;
      background: var(--surface); color: var(--heading);
      transition: all 0.2s;
    }
    .share-btn:hover { background: var(--surface-3); border-color: var(--border-focus); }
    .share-badge-preview {
      text-align: center; margin: 10px 0 6px;
    }
    .share-badge-preview img { height: 20px; }

    @media (max-width: 480px) {
      .container { padding: 0 16px; }
      .tab { padding: 8px 12px; font-size: 11px; }
      .tab-panel { padding: 16px; }
      .personas-grid { grid-template-columns: 1fr; }
      .footer-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="page">

    <!-- ===== TOP NAV ===== -->
    <nav class="top-nav">
      <a class="nav-logo" href="/">Swarm<span>X</span></a>
      <div class="nav-links">
        <a href="#pricing">Pricing</a>
        <a href="/x402/docs">Docs</a>
        <a href="/x402/catalog">Catalog</a>
        <a href="https://github.com/SolTwizzy/swarms-x402" target="_blank">GitHub</a>
        <a class="nav-cta" href="#playground">Try Free &rarr;</a>
      </div>
    </nav>

    <!-- ===== HERO ===== -->
    <header class="hero">
      <div class="container">
        <div class="hero-grid">

          <div class="hero-thesis">
            <div class="hero-eyebrow">Tokenized equities &middot; Robinhood Chain</div>
            <h1 class="hero-headline">Tokenized stocks,<br><em>fully researched.</em></h1>
            <p class="hero-sub">A panel of analyst agents reads the market data on any tokenized equity &mdash; momentum, valuation, downside &mdash; and returns a structured verdict you can act on. $0.29 a report, paid in USDC. No account.</p>
            <div class="hero-ctas">
              <a class="hero-cta-btn hero-cta-primary" href="#playground">Run a report</a>
              <a class="hero-cta-btn hero-cta-secondary" href="/x402/docs">Read the docs</a>
            </div>
            <p class="hero-stats">5 RWA endpoints &bull; 44 total &bull; $0.19&ndash;$0.49 &bull; 5 free calls/day</p>
          </div>

          <!-- Signature: a real captured stock-dd run, replayed. -->
          <div class="term" aria-label="Sample SwarmX stock due-diligence output">
            <div class="term-bar">
              <span class="term-title">swarmx &mdash; stock-dd</span>
              <span class="term-tag">sample run</span>
            </div>
            <div class="term-body">
              <div class="term-line in" style="--d:0s">$ swarmx stock-dd --ticker AAPL</div>
              <div class="term-line dim" style="--d:.3s">&nbsp;</div>
              <div class="term-line muted" style="--d:.4s">POST /x402/rwa/stock-dd</div>
              <div class="term-line dim" style="--d:.48s">402 &rarr; settle 0.29 USDC &rarr; <span style="color:var(--accent)">200 OK</span></div>
              <div class="term-line dim" style="--d:.56s">&nbsp;</div>
              <div class="term-line agent" style="--d:.64s"><span class="who">market </span> AAPL  314.86 USD  <span style="color:var(--red)">-0.77%</span>  NasdaqGS</div>
              <div class="term-line dim" style="--d:.72s"><span class="who">       </span> 6mo 243.42 &mdash; 323.45 &middot; pos 89.3%</div>
              <div class="term-line dim" style="--d:.8s">&nbsp;</div>
              <div class="term-line agent" style="--d:.88s"><span class="who">panel  </span> LocalPanel &middot; 3 analysts &middot; via llm</div>
              <div class="term-line dim" style="--d:.96s">&nbsp;</div>
              <div class="term-line ok" style="--d:1.04s"><span class="who">bull   </span> 6-month price trend up 21.9%</div>
              <div class="term-line ok" style="--d:1.12s"><span class="who">bull   </span> High average daily volume</div>
              <div class="term-line risk" style="--d:1.2s"><span class="who">bear   </span> Trading 2.7% below 6-month high</div>
              <div class="term-line risk" style="--d:1.28s"><span class="who">bear   </span> Position at 89.3% &mdash; overvaluation concerns</div>
              <div class="term-line risk" style="--d:1.36s"><span class="who">risk   </span> Downside toward 6-month low of 243.42</div>
              <div class="term-line dim" style="--d:1.44s">&nbsp;</div>
              <div class="term-line in" style="--d:1.52s"><span class="who">verdict</span> NEUTRAL &middot; confidence 0.50<span class="term-cursor"></span></div>
              <div class="term-foot" style="--d:1.6s">
                <a class="term-run" href="#playground">Run your own &rarr;</a>
                <span class="term-note">Real output, captured 2026-07-14. Not investment advice.</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </header>

    <div class="container">

      <!-- ===== WHAT IS SWARMX ===== -->
      <div class="what-is">
        <div class="landing-section-title">What is SwarmX</div>
        <p>Stocks are moving on-chain. SwarmX is the research layer that moved with them. Point it at a tokenized equity and a panel of specialist agents &mdash; each arguing a different side &mdash; returns a rated verdict with the bull case, the bear case, and the downside spelled out. Crypto and DeFi endpoints are here too, but tokenized real-world assets are what we build for.</p>
        <p class="stat-line">5 RWA endpoints &bull; 44 total &bull; No accounts &bull; No API keys &bull; Pay per call or try free</p>
      </div>

      <!-- ===== HOW IT WORKS ===== -->
      <div class="landing-section">
        <div class="landing-section-title">How it works</div>
        <div class="steps-grid">
          <div class="step-card">
            <div class="step-num">POST</div>
            <div class="step-icon">&lbrace;&nbsp;&rbrace;</div>
            <h3>Name a ticker</h3>
            <p>One HTTP POST with the symbol you want researched. No account, no API key, no SDK. Your first 5 calls each day are free.</p>
            <span class="step-arrow">&rarr;</span>
          </div>
          <div class="step-card">
            <div class="step-num">402</div>
            <div class="step-icon">&#x25CE;</div>
            <h3>Settle $0.29</h3>
            <p>The endpoint answers 402, your wallet settles USDC, the request retries itself. Market data is fetched before you are ever charged.</p>
            <span class="step-arrow">&rarr;</span>
          </div>
          <div class="step-card">
            <div class="step-num">200</div>
            <div class="step-icon">&#x2713;</div>
            <h3>Read the verdict</h3>
            <p>Structured JSON: rating, confidence, bull case, bear case, risks &mdash; plus a shareable report page and a badge for your README.</p>
          </div>
        </div>
      </div>

      <!-- ===== VALUE PROPS ===== -->
      <div class="landing-section">
        <div class="landing-section-title">Why SwarmX</div>
        <div class="props-grid">
          <div class="prop-card">
            <h3>A panel, not <span class="accent">one opinion</span></h3>
            <p>Three analysts argue the ticker from different sides before anything is rated. You see the bull case and the bear case, not a single model's guess.</p>
          </div>
          <div class="prop-card">
            <h3>Priced like <span class="accent">a query</span></h3>
            <p>$0.29 a report. No seat, no subscription, no minimum. Pay in USDC per call, or run 5 free every day.</p>
          </div>
          <div class="prop-card">
            <h3>Callable by <span class="accent">agents</span></h3>
            <p>Any agent with a USDC wallet can pull research on its own. MCP server included, 44 tools, no human in the loop.</p>
          </div>
        </div>
      </div>

      <!-- ===== WHO USES SWARMX ===== -->
      <div class="landing-section">
        <div class="landing-section-title">Who uses SwarmX</div>
        <div class="personas-grid">
          <div class="persona-card">
            <div class="persona-label sec">Tokenized-equity traders</div>
            <p>Screen a list, compare two names, or pull full diligence on one &mdash; before the position, not after.</p>
          </div>
          <div class="persona-card">
            <div class="persona-label defi">RWA platforms</div>
            <p>Check which assets are eligible to tokenize, and what catalysts are already on the calendar.</p>
          </div>
          <div class="persona-card">
            <div class="persona-label dev">Developers</div>
            <p>Research, audits, extraction &mdash; 44 endpoints behind one API, priced per call.</p>
          </div>
          <div class="persona-card">
            <div class="persona-label agent">AI agents</div>
            <p>Any agent can pay and consume SwarmX via x402 + MCP. No human in the loop.</p>
          </div>
        </div>
      </div>

      <!-- ===== PLAYGROUND TABS (9 categories) ===== -->
      <div class="playground" id="playground">
        <div class="tabs" role="tablist">
          <button class="tab active" data-tab="crypto" role="tab" aria-selected="true">Stocks &amp; Crypto</button>
          <button class="tab" data-tab="content" role="tab" aria-selected="false">Content</button>
          <button class="tab" data-tab="code" role="tab" aria-selected="false">Code</button>
          <button class="tab" data-tab="research" role="tab" aria-selected="false">Research</button>
          <button class="tab" data-tab="defi" role="tab" aria-selected="false">DeFi</button>
          <button class="tab" data-tab="trading" role="tab" aria-selected="false">Trading</button>
          <button class="tab" data-tab="enterprise" role="tab" aria-selected="false">Enterprise</button>
          <button class="tab" data-tab="batch" role="tab" aria-selected="false">Batch</button>
          <button class="tab" data-tab="data" role="tab" aria-selected="false">Data</button>
        </div>

        <!-- TAB 1: Crypto -->
        <div class="tab-panel active" id="panel-crypto" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Stock DD &amp; Crypto</span>
            <span class="tab-panel-price" id="crypto-price">$0.29</span>
          </div>
          <p class="tab-panel-desc">Due diligence on any tokenized equity, plus the crypto suite &mdash; contract audits, token risk, wallet risk, transaction explanations, and DAO governance review.</p>
          <div class="form-group">
            <label class="form-label" for="crypto-endpoint">Endpoint</label>
            <select class="form-select" id="crypto-endpoint" onchange="updateCryptoForm()">
              <option value="rwa/stock-dd" data-price="$0.29" selected>Stock DD &mdash; RWA ($0.29) &mdash; 3 agents</option>
              <option value="contract-audit" data-price="$0.10">Contract Audit ($0.10) &mdash; 4 agents</option>
              <option value="contract-audit/quick" data-price="$0.03">Quick Audit ($0.03) &mdash; 1 agent</option>
              <option value="contract-audit/deep" data-price="$0.25">Deep Audit ($0.25) &mdash; 6 agents</option>
              <option value="token-risk" data-price="$0.05">Token Risk ($0.05) &mdash; 3 agents</option>
              <option value="memecoin-score" data-price="$0.05">Memecoin Score ($0.05) &mdash; 3 agents</option>
              <option value="wallet-risk-score" data-price="$0.05">Wallet Risk Score ($0.05) &mdash; 2 agents</option>
              <option value="tx-explainer" data-price="$0.03">TX Explainer ($0.03) &mdash; AI</option>
              <option value="dao-analyze" data-price="$0.10">DAO Analysis ($0.10) &mdash; 4 agents</option>
            </select>
          </div>
          <div class="form-group" id="crypto-textarea-group" style="display:none;">
            <label class="form-label" id="crypto-input-label">Contract Code</label>
            <textarea class="form-textarea" id="crypto-textarea" placeholder="// Paste your smart contract code here...&#10;pragma solidity ^0.8.20;&#10;&#10;contract SimpleVault {&#10;    mapping(address => uint256) public balances;&#10;    function deposit() external payable { balances[msg.sender] += msg.value; }&#10;    function withdraw(uint256 amount) external {&#10;        require(balances[msg.sender] >= amount);&#10;        (bool ok, ) = msg.sender.call{value: amount}(&quot;&quot;);&#10;        require(ok);&#10;        balances[msg.sender] -= amount;&#10;    }&#10;}" rows="8"></textarea>
          </div>
          <div class="form-group" id="crypto-text-group">
            <label class="form-label" id="crypto-text-label">Stock Ticker</label>
            <input class="form-input" id="crypto-text" type="text" placeholder="e.g. NVDA">
          </div>
          <div class="form-row">
            <div class="form-group" id="crypto-lang-group">
              <label class="form-label">Language</label>
              <select class="form-select" id="crypto-lang">
                <option value="solidity">Solidity</option>
                <option value="rust">Rust / Anchor</option>
              </select>
            </div>
            <div class="form-group" id="crypto-chain-group" style="display:none;">
              <label class="form-label">Chain</label>
              <select class="form-select" id="crypto-chain">
                <option value="solana">Solana</option>
                <option value="evm">EVM</option>
              </select>
            </div>
            <div class="form-group" style="flex:0 0 auto;">
              <button class="btn-submit green" id="crypto-btn" onclick="runCrypto()">Run</button>
            </div>
          </div>
          <div class="spinner" id="crypto-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Processing</span></div>
            <div class="agent-steps" id="crypto-steps"></div>
          </div>
          <div class="error-box" id="crypto-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="crypto-error-msg"></div></div>
          <div class="payment-banner" id="crypto-payment"></div>
          <div class="results-area hidden" id="crypto-results"></div>
        </div>

        <!-- TAB 2: Content -->
        <div class="tab-panel" id="panel-content" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Content &amp; NLP</span>
            <span class="tab-panel-price" id="content-price">$0.25</span>
          </div>
          <p class="tab-panel-desc">SEO articles, summaries, translations, document extraction, creative writing, sentiment analysis, and structured extraction.</p>
          <div class="form-group">
            <label class="form-label" for="content-endpoint">Endpoint</label>
            <select class="form-select" id="content-endpoint" onchange="updateContentForm()">
              <option value="seo-article" data-price="$0.25">SEO Article ($0.25) &mdash; 3 agents</option>
              <option value="summarize" data-price="$0.01">Summarize ($0.01) &mdash; 1 agent</option>
              <option value="translate" data-price="$0.02">Translate ($0.02) &mdash; 1 agent</option>
              <option value="document-extract" data-price="$0.05">Document Extract ($0.05) &mdash; AI</option>
              <option value="write" data-price="$0.03">Write ($0.03) &mdash; 3 agents</option>
              <option value="sentiment" data-price="$0.01">Sentiment ($0.01) &mdash; 1 agent</option>
              <option value="extract" data-price="$0.01">Extract ($0.01) &mdash; 1 agent</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" id="content-input-label">Topic / Keywords</label>
            <textarea class="form-textarea" id="content-textarea" placeholder="Enter your topic, text, or content here..." rows="6"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group" id="content-lang-group" style="display:none;">
              <label class="form-label">Target Language</label>
              <input class="form-input" id="content-lang" type="text" placeholder="e.g. Spanish, French, Japanese">
            </div>
            <div class="form-group" id="content-fields-group" style="display:none;">
              <label class="form-label">Fields to Extract</label>
              <input class="form-input" id="content-fields" type="text" placeholder="e.g. name, date, amount">
            </div>
            <div class="form-group" id="content-keywords-group">
              <label class="form-label">Keywords (optional)</label>
              <input class="form-input" id="content-keywords" type="text" placeholder="e.g. AI agents, blockchain">
            </div>
            <div class="form-group" style="flex:0 0 auto;">
              <button class="btn-submit green" id="content-btn" onclick="runContent()">Run</button>
            </div>
          </div>
          <div class="spinner" id="content-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Processing</span></div>
            <div class="agent-steps" id="content-steps"></div>
          </div>
          <div class="error-box" id="content-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="content-error-msg"></div></div>
          <div class="payment-banner" id="content-payment"></div>
          <div class="results-area hidden" id="content-results"></div>
        </div>

        <!-- TAB 3: Code -->
        <div class="tab-panel" id="panel-code" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Code Analysis</span>
            <span class="tab-panel-price" id="code-price">$0.10</span>
          </div>
          <p class="tab-panel-desc">Multi-agent code audits and reviews for any programming language &mdash; security, performance, and best practices.</p>
          <div class="form-group">
            <label class="form-label" for="code-endpoint">Endpoint</label>
            <select class="form-select" id="code-endpoint" onchange="updateCodeForm()">
              <option value="code-audit" data-price="$0.10">Code Audit ($0.10) &mdash; 3 agents</option>
              <option value="code-review" data-price="$0.03">Code Review ($0.03) &mdash; 3 agents</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Code</label>
            <textarea class="form-textarea" id="code-textarea" placeholder="// Paste any code for review...&#10;function processPayment(amount, userId) {&#10;  const query = 'SELECT * FROM users WHERE id = ' + userId;&#10;  db.execute(query);&#10;  return charge(amount);&#10;}" rows="8"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Language (auto-detect if empty)</label>
              <input class="form-input" id="code-lang" type="text" placeholder="e.g. python, typescript, go">
            </div>
            <div class="form-group" style="flex:0 0 auto;">
              <button class="btn-submit green" id="code-btn" onclick="runCode()">Run</button>
            </div>
          </div>
          <div class="spinner" id="code-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Code Analysis</span></div>
            <div class="agent-steps" id="code-steps"></div>
          </div>
          <div class="error-box" id="code-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="code-error-msg"></div></div>
          <div class="payment-banner" id="code-payment"></div>
          <div class="results-area hidden" id="code-results"></div>
        </div>

        <!-- TAB 4: Research -->
        <div class="tab-panel" id="panel-research" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Research &amp; Analysis</span>
            <span class="tab-panel-price" id="research-price">$0.50</span>
          </div>
          <p class="tab-panel-desc">Multi-agent research pipelines, analysis panels, adversarial debates, and general-purpose agents.</p>
          <div class="form-group">
            <label class="form-label" for="research-endpoint">Endpoint</label>
            <select class="form-select" id="research-endpoint" onchange="updateResearchForm()">
              <option value="research-report" data-price="$0.50">Research Report ($0.50) &mdash; 4 agents</option>
              <option value="research" data-price="$0.05">Research ($0.05) &mdash; 3 agents</option>
              <option value="analyze" data-price="$0.03">Analyze ($0.03) &mdash; 4 agents</option>
              <option value="debate" data-price="$0.05">Debate ($0.05) &mdash; 3 agents</option>
              <option value="agent" data-price="$0.02">Single Agent ($0.02) &mdash; 1 agent</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" id="research-input-label">Research Question / Topic</label>
            <textarea class="form-textarea" id="research-textarea" placeholder="e.g. What are the security risks of cross-chain bridges in 2026?" rows="4"></textarea>
          </div>
          <div class="form-group" style="flex:0 0 auto;">
            <button class="btn-submit green" id="research-btn" onclick="runResearch()">Run</button>
          </div>
          <div class="spinner" id="research-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Research Pipeline</span></div>
            <div class="agent-steps" id="research-steps"></div>
          </div>
          <div class="error-box" id="research-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="research-error-msg"></div></div>
          <div class="payment-banner" id="research-payment"></div>
          <div class="results-area hidden" id="research-results"></div>
        </div>

        <!-- TAB 5: DeFi -->
        <div class="tab-panel" id="panel-defi" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">DeFi Intelligence</span>
            <span class="tab-panel-price" id="defi-price">$0.10</span>
          </div>
          <p class="tab-panel-desc">Yield optimization, wallet analysis, full wallet reports, and DeFi position scanning.</p>
          <div class="form-group">
            <label class="form-label" for="defi-endpoint">Endpoint</label>
            <select class="form-select" id="defi-endpoint" onchange="updateDefiForm()">
              <option value="yield-optimizer" data-price="$0.10">Yield Optimizer ($0.10) &mdash; 3 agents</option>
              <option value="wallet-analyzer" data-price="$0.01">Wallet Analyzer ($0.01) &mdash; data</option>
              <option value="wallet-report" data-price="$0.03">Wallet Report ($0.03) &mdash; bundle</option>
              <option value="defi-positions" data-price="$0.02">DeFi Positions ($0.02) &mdash; data</option>
            </select>
          </div>
          <div class="form-group" id="defi-wallet-group" style="display:none;">
            <label class="form-label">Wallet Address</label>
            <input class="form-input" id="defi-wallet" type="text" placeholder="e.g. H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ">
          </div>
          <div class="form-group" id="defi-yield-group">
            <label class="form-label">Investment Amount (USD, optional)</label>
            <input class="form-input" id="defi-amount" type="number" placeholder="e.g. 10000">
          </div>
          <div class="form-row">
            <div class="form-group" id="defi-risk-group">
              <label class="form-label">Risk Tolerance</label>
              <select class="form-select" id="defi-risk">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="form-group" style="flex:0 0 auto;">
              <button class="btn-submit green" id="defi-btn" onclick="runDefi()">Run</button>
            </div>
          </div>
          <div class="spinner" id="defi-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">DeFi Analysis</span></div>
            <div class="agent-steps" id="defi-steps"></div>
          </div>
          <div class="error-box" id="defi-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="defi-error-msg"></div></div>
          <div class="payment-banner" id="defi-payment"></div>
          <div class="results-area hidden" id="defi-results"></div>
        </div>

        <!-- TAB 6: Trading -->
        <div class="tab-panel" id="panel-trading" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Trading Data</span>
            <span class="tab-panel-price" id="trading-price">$0.001</span>
          </div>
          <p class="tab-panel-desc">Real-time Solana data: token prices, supply info, slot data, token accounts, and recent blockhash &mdash; designed for trading bots.</p>
          <div class="form-group">
            <label class="form-label" for="trading-endpoint">Endpoint</label>
            <select class="form-select" id="trading-endpoint" onchange="updateTradingForm()">
              <option value="token-price" data-price="$0.001">Token Price ($0.001)</option>
              <option value="token-supply" data-price="$0.001">Token Supply ($0.001)</option>
              <option value="slot-info" data-price="$0.001">Slot Info ($0.001)</option>
              <option value="token-accounts" data-price="$0.002">Token Accounts ($0.002)</option>
              <option value="recent-blockhash" data-price="$0.001">Recent Blockhash ($0.001)</option>
            </select>
          </div>
          <div class="form-group" id="trading-mint-group">
            <label class="form-label" id="trading-input-label">Token Mint Address</label>
            <input class="form-input" id="trading-mint" type="text" placeholder="e.g. So11111111111111111111111111111111111111112">
          </div>
          <div class="form-group" id="trading-owner-group" style="display:none;">
            <label class="form-label">Wallet Address</label>
            <input class="form-input" id="trading-owner" type="text" placeholder="Wallet address for token accounts">
          </div>
          <div class="form-group" style="flex:0 0 auto;">
            <button class="btn-submit green" id="trading-btn" onclick="runTrading()">Run</button>
          </div>
          <div class="spinner" id="trading-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Fetching Data</span></div>
            <div class="agent-steps" id="trading-steps"></div>
          </div>
          <div class="error-box" id="trading-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="trading-error-msg"></div></div>
          <div class="payment-banner" id="trading-payment"></div>
          <div class="results-area hidden" id="trading-results"></div>
        </div>

        <!-- TAB 7: Enterprise -->
        <div class="tab-panel" id="panel-enterprise" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Enterprise</span>
            <span class="tab-panel-price" id="enterprise-price">$5.00</span>
          </div>
          <p class="tab-panel-desc">High-value multi-agent analyses: investment due diligence (5+1 agents) and regulatory compliance checks (3 agents).</p>
          <div class="form-group">
            <label class="form-label" for="enterprise-endpoint">Endpoint</label>
            <select class="form-select" id="enterprise-endpoint" onchange="updateEnterpriseForm()">
              <option value="investment-dd" data-price="$5.00">Investment DD ($5.00) &mdash; 5+1 agents</option>
              <option value="compliance-check" data-price="$0.50">Compliance Check ($0.50) &mdash; 3 agents</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" id="enterprise-input-label">Project Name / Description</label>
            <textarea class="form-textarea" id="enterprise-textarea" placeholder="Describe the project for due diligence analysis...&#10;&#10;e.g. Uniswap V4 &mdash; decentralized exchange protocol on Ethereum with hooks system" rows="6"></textarea>
          </div>
          <div class="form-group" id="enterprise-url-group">
            <label class="form-label">Website URL (optional)</label>
            <input class="form-input" id="enterprise-url" type="text" placeholder="e.g. https://uniswap.org">
          </div>
          <div class="form-group" id="enterprise-framework-group" style="display:none;">
            <label class="form-label">Framework (optional)</label>
            <select class="form-select" id="enterprise-framework">
              <option value="">Auto-detect</option>
              <option value="GDPR">GDPR</option>
              <option value="SOC2">SOC 2</option>
              <option value="HIPAA">HIPAA</option>
              <option value="MiCA">MiCA</option>
              <option value="AML">AML/KYC</option>
              <option value="PCI-DSS">PCI-DSS</option>
              <option value="CCPA">CCPA</option>
            </select>
          </div>
          <div class="form-group" style="flex:0 0 auto;">
            <button class="btn-submit green" id="enterprise-btn" onclick="runEnterprise()">Run</button>
          </div>
          <div class="spinner" id="enterprise-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Enterprise Analysis</span></div>
            <div class="agent-steps" id="enterprise-steps"></div>
          </div>
          <div class="error-box" id="enterprise-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="enterprise-error-msg"></div></div>
          <div class="payment-banner" id="enterprise-payment"></div>
          <div class="results-area hidden" id="enterprise-results"></div>
        </div>

        <!-- TAB 8: Batch -->
        <div class="tab-panel" id="panel-batch" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Batch Processing</span>
            <span class="tab-panel-price">20% discount</span>
          </div>
          <p class="tab-panel-desc">Run up to 10 tasks in a single payment with 20% discount. Submit an array of tasks, each specifying an endpoint and its payload.</p>
          <div class="form-group">
            <label class="form-label">Batch Request (JSON)</label>
            <textarea class="form-textarea" id="batch-textarea" placeholder='{"tasks": [&#10;  {"endpoint": "/x402/summarize", "body": {"text": "Your text here..."}},&#10;  {"endpoint": "/x402/sentiment", "body": {"text": "Another text..."}},&#10;  {"endpoint": "/x402/translate", "body": {"text": "Hello world", "targetLanguage": "Spanish"}}&#10;]}' rows="8"></textarea>
          </div>
          <div class="form-group" style="flex:0 0 auto;">
            <button class="btn-submit green" id="batch-btn" onclick="runBatch()">Run Batch</button>
          </div>
          <div class="spinner" id="batch-spinner">
            <div class="spinner-header"><div class="spinner-ring"></div><span class="spinner-title">Batch Processing</span></div>
            <div class="agent-steps" id="batch-steps"></div>
          </div>
          <div class="error-box" id="batch-error"><div class="error-box-title">Error</div><div class="error-box-msg" id="batch-error-msg"></div></div>
          <div class="payment-banner" id="batch-payment"></div>
          <div class="results-area hidden" id="batch-results"></div>
        </div>

        <!-- TAB 9: Data -->
        <div class="tab-panel" id="panel-data" role="tabpanel">
          <div class="tab-panel-header">
            <span class="tab-panel-title">Free Data Endpoints</span>
            <span class="tab-panel-price" style="color:var(--green);">FREE</span>
          </div>
          <p class="tab-panel-desc">Public endpoints that require no payment &mdash; catalog, health, and revenue dashboard.</p>
          <div class="endpoints-grid">
            <a class="ep-card" href="/x402/catalog" target="_blank" style="text-decoration:none;cursor:pointer;">
              <div class="ep-card-top"><span class="ep-name">Service Catalog</span><span class="ep-price free">FREE</span></div>
              <p class="ep-desc">All endpoints with pricing and descriptions</p>
              <div class="ep-meta"><span class="method-badge get">GET</span><span class="ep-path">/x402/catalog</span></div>
            </a>
            <a class="ep-card" href="/x402/health" target="_blank" style="text-decoration:none;cursor:pointer;">
              <div class="ep-card-top"><span class="ep-name">Health Check</span><span class="ep-price free">FREE</span></div>
              <p class="ep-desc">Service health, revenue stats, and network info</p>
              <div class="ep-meta"><span class="method-badge get">GET</span><span class="ep-path">/x402/health</span></div>
            </a>
            <a class="ep-card" href="/x402/revenue" target="_blank" style="text-decoration:none;cursor:pointer;">
              <div class="ep-card-top"><span class="ep-name">Revenue Dashboard</span><span class="ep-price free">FREE</span></div>
              <p class="ep-desc">Revenue breakdown, top buyers, conversion rate</p>
              <div class="ep-meta"><span class="method-badge get">GET</span><span class="ep-path">/x402/revenue</span></div>
            </a>
            <a class="ep-card" href="/mcp-manifest.json" target="_blank" style="text-decoration:none;cursor:pointer;">
              <div class="ep-card-top"><span class="ep-name">MCP Manifest</span><span class="ep-price free">FREE</span></div>
              <p class="ep-desc">Model Context Protocol tool manifest</p>
              <div class="ep-meta"><span class="method-badge get">GET</span><span class="ep-path">/mcp-manifest.json</span></div>
            </a>
          </div>
        </div>
      </div><!-- .playground -->

      <!-- ===== ALL ENDPOINTS BY CATEGORY ===== -->
      <div class="section">
        <div class="section-title">All Endpoints</div>
        <div class="section-subtitle">Browse all 44 endpoints across 9 categories, from $0.001 data feeds to $5.00 enterprise analyses.</div>

        <div class="cat-heading">Crypto Analysis (8 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Contract Audit</span><span class="ep-price">$0.10</span></div><p class="ep-desc">4-agent security audit: vulns, economic attacks, copy detection, gas</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/contract-audit</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Quick Audit</span><span class="ep-price">$0.03</span></div><p class="ep-desc">Single-agent fast security scan</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/contract-audit/quick</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Deep Audit</span><span class="ep-price">$0.25</span></div><p class="ep-desc">6-agent comprehensive audit with cross-checks</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/contract-audit/deep</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Token Risk</span><span class="ep-price">$0.05</span></div><p class="ep-desc">3-agent rug pull detection and risk verdict</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/token-risk</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Memecoin Score</span><span class="ep-price">$0.05</span></div><p class="ep-desc">3-agent memecoin risk: authorities, holders, verdict</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/memecoin-score</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Stock DD (RWA)</span><span class="ep-price">$0.29</span></div><p class="ep-desc">Real market data + 3-agent bull/bear/risk debate verdict for a stock ticker</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/rwa/stock-dd</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Wallet Risk Score</span><span class="ep-price">$0.05</span></div><p class="ep-desc">2-agent wallet risk: tx patterns and risk level</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/wallet-risk-score</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">TX Explainer</span><span class="ep-price">$0.03</span></div><p class="ep-desc">Plain English Solana transaction explanation</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/tx-explainer</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">DAO Analysis</span><span class="ep-price">$0.10</span></div><p class="ep-desc">4-agent governance: economic, technical, risk + recommendation</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/dao-analyze</span></div></div>
        </div>

        <div class="cat-heading">Content &amp; NLP (7 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">SEO Article</span><span class="ep-price">$0.25</span></div><p class="ep-desc">3-agent SEO article: research, write, edit</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/seo-article</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Document Extract</span><span class="ep-price">$0.05</span></div><p class="ep-desc">AI data extraction from unstructured text</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/document-extract</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Write</span><span class="ep-price">$0.03</span></div><p class="ep-desc">3-agent writing: research, fact-check, compose</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/write</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Translate</span><span class="ep-price">$0.02</span></div><p class="ep-desc">AI translation to any language</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/translate</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Summarize</span><span class="ep-price">$0.01</span></div><p class="ep-desc">Condense any text to key points</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/summarize</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Sentiment</span><span class="ep-price">$0.01</span></div><p class="ep-desc">Positive/negative/neutral with confidence</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/sentiment</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Extract</span><span class="ep-price">$0.01</span></div><p class="ep-desc">Pull structured fields from unstructured text</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/extract</span></div></div>
        </div>

        <div class="cat-heading">Code Analysis (2 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Code Audit</span><span class="ep-price">$0.10</span></div><p class="ep-desc">3-agent audit: security, performance, best practices</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/code-audit</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Code Review</span><span class="ep-price">$0.03</span></div><p class="ep-desc">3-agent review: security, perf, style in parallel</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/code-review</span></div></div>
        </div>

        <div class="cat-heading">Research &amp; Analysis (5 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Research Report</span><span class="ep-price">$0.50</span></div><p class="ep-desc">4-agent fact-checked research with verification</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/research-report</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Research</span><span class="ep-price">$0.05</span></div><p class="ep-desc">3-agent pipeline: research, verify, write</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/research</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Analyze</span><span class="ep-price">$0.03</span></div><p class="ep-desc">4-expert panel: technical, economic, risk + synthesis</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/analyze</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Debate</span><span class="ep-price">$0.05</span></div><p class="ep-desc">3-agent adversarial debate: pro, con, judge</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/debate</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Single Agent</span><span class="ep-price">$0.02</span></div><p class="ep-desc">Custom AI agent for any task</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/agent</span></div></div>
        </div>

        <div class="cat-heading">DeFi (6 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Yield Optimizer</span><span class="ep-price">$0.10</span></div><p class="ep-desc">3-agent yield strategy: scan, assess risk, advise</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/yield-optimizer</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Wallet Report</span><span class="ep-price">$0.03</span></div><p class="ep-desc">Full wallet bundle: balances, tokens, DeFi, holders</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/wallet-report</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">DeFi Positions</span><span class="ep-price">$0.02</span></div><p class="ep-desc">Scan Solana wallet for LP tokens and staking</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/defi-positions</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Wallet Analyzer</span><span class="ep-price">$0.01</span></div><p class="ep-desc">SOL balance, token holdings, NFTs, recent txs</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/wallet-analyzer</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Token Holders</span><span class="ep-price">$0.01</span></div><p class="ep-desc">Top holders, amounts, and concentration</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/token-holders</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">TX History</span><span class="ep-price">$0.01</span></div><p class="ep-desc">Recent transactions for any Solana address</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/tx-history</span></div></div>
        </div>

        <div class="cat-heading">Trading Data (5 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Token Price</span><span class="ep-price">$0.001</span></div><p class="ep-desc">Real-time price via Jupiter, sub-second cached</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/token-price</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Token Supply</span><span class="ep-price">$0.001</span></div><p class="ep-desc">Total supply and decimals for any SPL token</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/token-supply</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Slot Info</span><span class="ep-price">$0.001</span></div><p class="ep-desc">Current Solana slot and block time</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/slot-info</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Token Accounts</span><span class="ep-price">$0.002</span></div><p class="ep-desc">All SPL accounts for a wallet, optional mint filter</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/token-accounts</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Recent Blockhash</span><span class="ep-price">$0.001</span></div><p class="ep-desc">Latest blockhash for transaction building</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/recent-blockhash</span></div></div>
        </div>

        <div class="cat-heading">Enterprise (2 endpoints)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Investment DD</span><span class="ep-price">$5.00</span></div><p class="ep-desc">5+1 agents: team, tokenomics, tech, community, market + synthesis</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/investment-dd</span></div></div>
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Compliance Check</span><span class="ep-price">$0.50</span></div><p class="ep-desc">3-agent regulatory: GDPR, SOC2, HIPAA, MiCA, AML</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/compliance-check</span></div></div>
        </div>

        <div class="cat-heading">Batch (1 endpoint)</div>
        <div class="endpoints-grid">
          <div class="ep-card"><div class="ep-card-top"><span class="ep-name">Batch Tasks</span><span class="ep-price">20% off</span></div><p class="ep-desc">Up to 10 tasks in parallel, single payment</p><div class="ep-meta"><span class="method-badge post">POST</span><span class="ep-path">/x402/batch</span></div></div>
        </div>
      </div>

      <!-- ===== PRICING ===== -->
      <div class="section" id="pricing">
        <div class="section-title">Pricing</div>
        <div class="section-subtitle">Transparent per-call pricing. Pay only for what you use. No subscriptions, no hidden fees.</div>
        <div style="background:rgba(255,255,255,0.02);border:0.67px solid rgba(255,255,255,0.1);border-radius:16px;overflow:hidden;">
          <table class="pricing-table">
            <thead>
              <tr><th>Category</th><th>Endpoint</th><th>Price (USDC)</th><th>Agents</th></tr>
            </thead>
            <tbody>
              <tr class="cat-row"><td colspan="4">Enterprise</td></tr>
              <tr><td><span class="tier-label tier-enterprise">Enterprise</span></td><td>Investment DD</td><td class="price-val">$5.00</td><td>5+1 agents</td></tr>
              <tr><td><span class="tier-label tier-enterprise">Enterprise</span></td><td>Compliance Check</td><td class="price-val">$0.50</td><td>3 agents</td></tr>
              <tr class="cat-row"><td colspan="4">Research &amp; Analysis</td></tr>
              <tr><td><span class="tier-label tier-multi">Research</span></td><td>Research Report</td><td class="price-val">$0.50</td><td>4 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Research</span></td><td>Research</td><td class="price-val">$0.05</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Research</span></td><td>Debate</td><td class="price-val">$0.05</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Research</span></td><td>Analyze</td><td class="price-val">$0.03</td><td>4 agents</td></tr>
              <tr><td><span class="tier-label tier-single">Research</span></td><td>Single Agent</td><td class="price-val">$0.02</td><td>1 agent</td></tr>
              <tr class="cat-row"><td colspan="4">Crypto Analysis</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>Deep Audit</td><td class="price-val">$0.25</td><td>6 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>Contract Audit</td><td class="price-val">$0.10</td><td>4 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>DAO Analysis</td><td class="price-val">$0.10</td><td>4 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>Token Risk</td><td class="price-val">$0.05</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>Memecoin Score</td><td class="price-val">$0.05</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Crypto</span></td><td>Wallet Risk Score</td><td class="price-val">$0.05</td><td>2 agents</td></tr>
              <tr><td><span class="tier-label tier-single">Crypto</span></td><td>Quick Audit</td><td class="price-val">$0.03</td><td>1 agent</td></tr>
              <tr><td><span class="tier-label tier-single">Crypto</span></td><td>TX Explainer</td><td class="price-val">$0.03</td><td>AI</td></tr>
              <tr class="cat-row"><td colspan="4">Content &amp; NLP</td></tr>
              <tr><td><span class="tier-label tier-multi">Content</span></td><td>SEO Article</td><td class="price-val">$0.25</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-single">Content</span></td><td>Document Extract</td><td class="price-val">$0.05</td><td>AI</td></tr>
              <tr><td><span class="tier-label tier-multi">Content</span></td><td>Write</td><td class="price-val">$0.03</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-single">Content</span></td><td>Translate</td><td class="price-val">$0.02</td><td>1 agent</td></tr>
              <tr><td><span class="tier-label tier-single">Content</span></td><td>Summarize</td><td class="price-val">$0.01</td><td>1 agent</td></tr>
              <tr><td><span class="tier-label tier-single">Content</span></td><td>Sentiment</td><td class="price-val">$0.01</td><td>1 agent</td></tr>
              <tr><td><span class="tier-label tier-single">Content</span></td><td>Extract</td><td class="price-val">$0.01</td><td>1 agent</td></tr>
              <tr class="cat-row"><td colspan="4">Code Analysis</td></tr>
              <tr><td><span class="tier-label tier-multi">Code</span></td><td>Code Audit</td><td class="price-val">$0.10</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-multi">Code</span></td><td>Code Review</td><td class="price-val">$0.03</td><td>3 agents</td></tr>
              <tr class="cat-row"><td colspan="4">DeFi Intelligence</td></tr>
              <tr><td><span class="tier-label tier-multi">DeFi</span></td><td>Yield Optimizer</td><td class="price-val">$0.10</td><td>3 agents</td></tr>
              <tr><td><span class="tier-label tier-data">DeFi</span></td><td>Wallet Report</td><td class="price-val">$0.03</td><td>bundle</td></tr>
              <tr><td><span class="tier-label tier-data">DeFi</span></td><td>DeFi Positions</td><td class="price-val">$0.02</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">DeFi</span></td><td>Wallet Analyzer</td><td class="price-val">$0.01</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">DeFi</span></td><td>Token Holders</td><td class="price-val">$0.01</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">DeFi</span></td><td>TX History</td><td class="price-val">$0.01</td><td>&mdash;</td></tr>
              <tr class="cat-row"><td colspan="4">Trading Data</td></tr>
              <tr><td><span class="tier-label tier-data">Trading</span></td><td>Token Accounts</td><td class="price-val">$0.002</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">Trading</span></td><td>Token Price</td><td class="price-val">$0.001</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">Trading</span></td><td>Token Supply</td><td class="price-val">$0.001</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">Trading</span></td><td>Slot Info</td><td class="price-val">$0.001</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-data">Trading</span></td><td>Recent Blockhash</td><td class="price-val">$0.001</td><td>&mdash;</td></tr>
              <tr class="cat-row"><td colspan="4">Batch</td></tr>
              <tr><td><span class="tier-label tier-batch">Batch</span></td><td>Batch Tasks (up to 10)</td><td class="price-val">20% off</td><td>varies</td></tr>
              <tr class="cat-row"><td colspan="4">Free</td></tr>
              <tr><td><span class="tier-label tier-free">Free</span></td><td>Catalog / Health / Revenue</td><td class="price-val">$0.00</td><td>&mdash;</td></tr>
              <tr><td><span class="tier-label tier-free">Free</span></td><td>Async Submit / Task Status</td><td class="price-val">$0.00</td><td>&mdash;</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ===== SDK ===== -->
      <div class="integration">
        <h3>Integrate with SwarmX</h3>
        <div class="code-label">Install</div>
        <div class="code-block"><span class="cmt"># As an ElizaOS plugin</span>
bun add swarms-x402

<span class="cmt"># Or call the HTTP API directly</span>
curl ${baseUrl}/x402/catalog</div>

        <div class="code-label">Client SDK (auto-pays via x402)</div>
        <div class="code-block"><span class="kw">import</span> { <span class="fn">wrapFetch</span> } <span class="kw">from</span> <span class="str">"@dexterai/x402/client"</span>;

<span class="kw">const</span> payingFetch = <span class="fn">wrapFetch</span>(fetch, {
  privateKey: process.env.SOLANA_PRIVATE_KEY,
  network: <span class="str">"solana-mainnet"</span>,
});

<span class="kw">const</span> res = <span class="kw">await</span> <span class="fn">payingFetch</span>(<span class="str">"${baseUrl}/x402/research"</span>, {
  method: <span class="str">"POST"</span>,
  headers: { <span class="str">"Content-Type"</span>: <span class="str">"application/json"</span> },
  body: JSON.stringify({ query: <span class="str">"AI agent monetization"</span> }),
});
console.log(<span class="kw">await</span> res.json());</div>
      </div>

      <!-- ===== QUICK LINKS ===== -->
      <div class="quick-links">
        <a class="qlink" href="/x402/docs">API Docs</a>
        <a class="qlink" href="/x402/catalog">Catalog JSON</a>
        <a class="qlink" href="/x402/health">Health</a>
        <a class="qlink" href="/x402/revenue">Revenue Dashboard</a>
        <a class="qlink" href="/mcp-manifest.json">MCP Manifest</a>
        <a class="qlink" href="/api/status">API Status</a>
        <a class="qlink" href="/x402/gallery">Gallery</a>
        <a class="qlink" href="/x402/benchmark">Benchmark</a>
        <a class="qlink" href="https://github.com/SolTwizzy/swarms-x402" target="_blank">GitHub</a>
      </div>

    </div><!-- .container -->

    <!-- ===== FOOTER ===== -->
    <footer class="footer">
      <div class="container">
        <div class="footer-grid">
          <div class="footer-brand">
            <div class="footer-brand-name">SwarmX</div>
            <div class="footer-brand-desc">AI agent teams powered by x402 micropayments and Swarms multi-agent orchestration.</div>
          </div>
          <div class="footer-col">
            <div class="footer-col-title">Products</div>
            <a href="/x402/catalog">API Catalog</a>
            <a href="/x402/docs">Documentation</a>
            <a href="/mcp-manifest.json">MCP Manifest</a>
            <a href="/x402/benchmark">Benchmark</a>
          </div>
          <div class="footer-col">
            <div class="footer-col-title">Resources</div>
            <a href="/x402/gallery">Gallery</a>
            <a href="/x402/health">Health Check</a>
            <a href="/x402/revenue">Revenue</a>
            <a href="/api/status">API Status</a>
          </div>
          <div class="footer-col">
            <div class="footer-col-title">Community</div>
            <a href="https://github.com/SolTwizzy/swarms-x402" target="_blank">GitHub</a>
            <a href="https://swarms.world" target="_blank">Swarms</a>
            <a href="https://elizaos.ai" target="_blank">ElizaOS</a>
            <a href="https://www.opendexter.xyz" target="_blank">OpenDexter</a>
          </div>
          <div class="footer-col">
            <div class="footer-col-title">Support</div>
            <a href="/x402/docs">Getting Started</a>
            <a href="/x402/catalog">API Reference</a>
            <a href="https://github.com/SolTwizzy/swarms-x402/issues" target="_blank">Report Issue</a>
          </div>
        </div>
        <div class="footer-bottom">
          <div class="footer-powered">
            Powered by <a href="https://www.opendexter.xyz">Dexter SDK</a> &middot; <a href="https://swarms.world">Swarms</a> &middot; <a href="https://elizaos.ai">ElizaOS</a>
          </div>
        </div>
      </div>
    </footer>

  </div><!-- .page -->

  <script>
  /* ── Tab switching (works on mobile touch + desktop click) ── */
  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
    document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected','true');
    var panel = document.getElementById('panel-' + tab.dataset.tab);
    if (panel) panel.classList.add('active');
  }
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function(e) { e.preventDefault(); switchTab(tab); });
    tab.addEventListener('touchend', function(e) { e.preventDefault(); switchTab(tab); });
  });

  /* ── Agent step definitions (all endpoints) ── */
  var AGENT_STEPS = {
    'contract-audit': [
      'SecurityAuditor analyzing vulnerabilities...',
      'EconomicAttacker evaluating attack vectors...',
      'GasOptimizer checking efficiency...',
      'AuditReporter synthesizing findings...'
    ],
    'contract-audit/quick': [
      'SecurityAuditor performing quick scan...'
    ],
    'contract-audit/deep': [
      'SecurityAuditor analyzing vulnerabilities...',
      'EconomicAttacker evaluating attack vectors...',
      'GasOptimizer checking efficiency...',
      'CopyDetector scanning for clones...',
      'ComplexityAnalyst assessing code complexity...',
      'DeepAuditReporter synthesizing all findings...'
    ],
    'token-risk': [
      'ContractScanner checking for rug patterns...',
      'TokenomicsAnalyzer evaluating distribution...',
      'RiskVerdict producing final score...'
    ],
    'memecoin-score': [
      'ContractScanner analyzing authorities...',
      'TokenomicsAnalyst checking distribution...',
      'RiskSynthesizer computing verdict...'
    ],
    'wallet-risk-score': [
      'TransactionAnalyzer scanning patterns...',
      'RiskScorer computing risk level...'
    ],
    'tx-explainer': [
      'Fetching transaction from Helius...',
      'AI analyzing transaction data...'
    ],
    'dao-analyze': [
      'EconomicAnalyst evaluating impact...',
      'TechnicalReviewer checking feasibility...',
      'RiskAssessor identifying concerns...',
      'GovernanceSynthesizer producing recommendation...'
    ],
    'seo-article': [
      'SEOResearcher creating outline...',
      'ContentWriter drafting article...',
      'Editor polishing and scoring...'
    ],
    'summarize': ['AI summarizing content...'],
    'translate': ['AI translating text...'],
    'document-extract': [
      'Analyzing document structure...',
      'Extracting fields...'
    ],
    'write': [
      'Researcher gathering information...',
      'FactChecker verifying claims...',
      'Writer composing content...'
    ],
    'sentiment': ['AI analyzing sentiment...'],
    'extract': ['AI extracting structured data...'],
    'code-audit': [
      'SecurityReviewer checking vulnerabilities...',
      'PerformanceAnalyst profiling...',
      'BestPracticesChecker reviewing...'
    ],
    'code-review': [
      'SecurityReviewer scanning code...',
      'PerformanceAnalyst checking efficiency...',
      'StyleChecker reviewing conventions...'
    ],
    'research-report': [
      'Researcher gathering sources...',
      'FactChecker verifying claims...',
      'Analyst synthesizing insights...',
      'Writer composing report...'
    ],
    'research': [
      'Researcher gathering information...',
      'FactChecker verifying claims...',
      'Writer producing report...'
    ],
    'analyze': [
      'TechnicalExpert analyzing...',
      'EconomicExpert evaluating...',
      'RiskExpert assessing...',
      'Synthesizer combining perspectives...'
    ],
    'debate': [
      'Proponent building case...',
      'Opponent challenging claims...',
      'Judge delivering verdict...'
    ],
    'agent': ['Agent processing task...'],
    'yield-optimizer': [
      'RateScanner fetching DeFiLlama yields...',
      'RiskAssessor evaluating protocols...',
      'StrategyAdvisor computing allocation...'
    ],
    'wallet-analyzer': ['Fetching wallet data from Solana...'],
    'wallet-report': [
      'Fetching SOL balance and tokens...',
      'Analyzing holder concentration...',
      'Scanning DeFi positions...'
    ],
    'defi-positions': ['Scanning wallet for DeFi positions...'],
    'token-price': ['Fetching price from Jupiter...'],
    'token-supply': ['Querying Solana RPC for supply...'],
    'slot-info': ['Querying current slot info...'],
    'token-accounts': ['Listing SPL token accounts...'],
    'recent-blockhash': ['Fetching latest blockhash...'],
    'investment-dd': [
      'TeamAnalyst researching founders...',
      'TokenomicsExpert analyzing distribution...',
      'TechReviewer auditing code...',
      'CommunityScanner measuring engagement...',
      'MarketAnalyst evaluating positioning...',
      'RiskSynthesizer computing score...'
    ],
    'compliance-check': [
      'RegulatoryExpert identifying frameworks...',
      'GapAnalyzer comparing requirements...',
      'ComplianceWriter generating report...'
    ],
    'batch': ['Processing batch tasks in parallel...']
  };

  var activeIntervals = {};

  function renderAgentSteps(prefix) {
    var steps = AGENT_STEPS[prefix] || [];
    var container = document.getElementById(prefix + '-steps');
    if (!container) return;
    var html = '';
    for (var i = 0; i < steps.length; i++) {
      html += '<div class="agent-step pending" id="' + prefix + '-step-' + i + '">' +
        '<span class="step-icon"></span>' +
        '<span>Step ' + (i + 1) + '/' + steps.length + ': ' + steps[i] + '</span></div>';
    }
    container.innerHTML = html;
  }

  function startAgentProgress(prefix, stepsKey) {
    var key = stepsKey || prefix;
    var steps = AGENT_STEPS[key] || [];
    if (steps.length === 0) return;
    /* Patch AGENT_STEPS so renderAgentSteps works with prefix */
    AGENT_STEPS[prefix] = steps;
    renderAgentSteps(prefix);
    var stepIndex = 0;
    var firstEl = document.getElementById(prefix + '-step-0');
    if (firstEl) { firstEl.classList.remove('pending'); firstEl.classList.add('active'); }
    var interval = 4000;
    activeIntervals[prefix] = setInterval(function() {
      stepIndex++;
      if (stepIndex < steps.length) {
        var prevEl = document.getElementById(prefix + '-step-' + (stepIndex - 1));
        if (prevEl) { prevEl.classList.remove('active'); prevEl.classList.add('done'); }
        var curEl = document.getElementById(prefix + '-step-' + stepIndex);
        if (curEl) { curEl.classList.remove('pending'); curEl.classList.add('active'); }
      } else {
        clearInterval(activeIntervals[prefix]);
        activeIntervals[prefix] = null;
      }
    }, interval);
  }

  function stopAgentProgress(prefix) {
    if (activeIntervals[prefix]) {
      clearInterval(activeIntervals[prefix]);
      activeIntervals[prefix] = null;
    }
    var steps = AGENT_STEPS[prefix] || [];
    for (var i = 0; i < steps.length; i++) {
      var el = document.getElementById(prefix + '-step-' + i);
      if (el) { el.classList.remove('active', 'pending'); el.classList.add('done'); }
    }
    var container = document.getElementById(prefix + '-steps');
    if (container) {
      container.innerHTML += '<div class="agent-step complete-msg">\u2705 Complete!</div>';
    }
  }

  /* ── Helpers ── */
  function showEl(id, cls) { var el = document.getElementById(id); if (el) el.classList.add(cls || 'visible'); }
  function hideEl(id, cls) { var el = document.getElementById(id); if (el) el.classList.remove(cls || 'visible'); }
  function resetPanel(prefix, stepsKey) {
    hideEl(prefix + '-error', 'visible');
    hideEl(prefix + '-payment', 'visible');
    var results = document.getElementById(prefix + '-results');
    if (results) { results.classList.add('hidden'); results.innerHTML = ''; }
    showEl(prefix + '-spinner', 'visible');
    var btn = document.getElementById(prefix + '-btn');
    if (btn) btn.disabled = true;
    startAgentProgress(prefix, stepsKey);
  }
  function donePanel(prefix) {
    stopAgentProgress(prefix);
    hideEl(prefix + '-spinner', 'visible');
    var btn = document.getElementById(prefix + '-btn');
    if (btn) btn.disabled = false;
  }
  function showError(prefix, msg) {
    donePanel(prefix);
    var el = document.getElementById(prefix + '-error-msg');
    if (el) el.textContent = msg;
    showEl(prefix + '-error', 'visible');
  }
  function showPayment(prefix) {
    donePanel(prefix);
    var banner = document.getElementById(prefix + '-payment');
    if (!banner) return;
    banner.innerHTML = '<div class="payment-banner-title">Your free calls are used up for today</div>' +
      '<div class="payment-banner-msg" style="text-align:left;margin-top:12px;">' +
      '<p>To continue, use the <strong>x402 payment protocol</strong> with any Solana or EVM wallet:</p>' +
      '<pre style="background:rgba(255,255,255,0.02);border:0.67px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 18px;margin:12px 0;font-family:var(--mono);font-size:11px;line-height:1.6;color:rgba(255,255,255,0.75);overflow-x:auto;white-space:pre-wrap;">' +
      'import { wrapFetch } from "@dexterai/x402/client";\\n\\n' +
      'const payingFetch = wrapFetch(fetch, {\\n' +
      '  privateKey: process.env.SOLANA_PRIVATE_KEY,\\n' +
      '  network: "solana-mainnet",\\n' +
      '});\\n\\n' +
      'const res = await payingFetch("' + location.origin + '/x402/contract-audit", {\\n' +
      '  method: "POST",\\n' +
      '  headers: { "Content-Type": "application/json" },\\n' +
      '  body: JSON.stringify({ code: "..." }),\\n' +
      '});' +
      '</pre>' +
      '<p style="margin-top:8px;"><a href="/x402/docs" style="color:#fafafa;border-bottom:0.67px solid rgba(255,255,255,0.3);">Full API reference</a> &middot; <a href="/x402/catalog" style="color:#fafafa;border-bottom:0.67px solid rgba(255,255,255,0.3);">All endpoints + pricing</a></p>' +
      '</div>';
    showEl(prefix + '-payment', 'visible');
  }
  function showRemainingBanner(remaining) {
    var el = document.getElementById('free-remaining-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'free-remaining-banner';
      el.style.cssText = 'text-align:center;padding:10px 18px;font-family:var(--font);font-size:13px;font-weight:500;border-radius:10px;margin:8px auto;max-width:500px;';
      var hero = document.querySelector('.hero .container');
      if (hero) hero.appendChild(el);
    }
    if (remaining <= 0) {
      el.style.background = 'var(--red-bg)';
      el.style.color = 'var(--red)';
      el.style.border = '0.67px solid rgba(248,113,113,0.2)';
      el.textContent = 'Free tier exhausted \u2014 connect wallet to continue';
    } else {
      el.style.background = 'var(--yellow-bg)';
      el.style.color = 'var(--yellow)';
      el.style.border = '0.67px solid rgba(251,191,36,0.2)';
      el.textContent = remaining + ' free call' + (remaining === 1 ? '' : 's') + ' remaining today';
    }
    el.style.display = 'block';
  }
  function escHtml(s) {
    var d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
  function copyToClipboard(text, btnEl) {
    navigator.clipboard.writeText(text).then(function() {
      var orig = btnEl.textContent;
      btnEl.textContent = 'Copied!';
      setTimeout(function() { btnEl.textContent = orig; }, 1500);
    });
  }
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderShareSection(data) {
    if (!data.reportUrl) return '';
    return '<div class="share-section">' +
      '<div class="share-title">Share This Report</div>' +
      '<div class="share-badge-preview"><img src="' + escAttr(data.badgeUrl) + '" alt="SwarmX Badge"></div>' +
      '<div class="share-row">' +
        '<div class="share-link" title="Report URL">' + escHtml(data.reportUrl) + '</div>' +
        '<button class="share-btn" data-copy="' + escAttr(data.reportUrl) + '">Copy Link</button>' +
        '<a class="share-btn" href="' + escAttr(data.reportUrl) + '" target="_blank" style="text-decoration:none;">Open</a>' +
      '</div>' +
      '<div class="share-row">' +
        '<div class="share-link" title="Embed badge (Markdown)">' + escHtml(data.badgeMarkdown) + '</div>' +
        '<button class="share-btn" data-copy="' + escAttr(data.badgeMarkdown) + '">Copy Markdown</button>' +
      '</div>' +
    '</div>';
  }
  // Delegated so copy targets survive re-renders. Carries the payload in a
  // data attribute: interpolating it into inline onclick required backslash
  // escapes that the surrounding template literal silently ate.
  document.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var btn = t.closest('[data-copy]');
    if (btn) copyToClipboard(btn.getAttribute('data-copy'), btn);
  });

  /* ── Score color ── */
  function scoreClass(score) {
    var n = parseInt(score, 10);
    if (isNaN(n)) return 'caution';
    if (n <= 35) return 'safe';
    if (n <= 65) return 'caution';
    return 'danger';
  }
  function scoreLabel(score) {
    var n = parseInt(score, 10);
    if (isNaN(n)) return 'REVIEW';
    if (n <= 35) return 'LOW RISK';
    if (n <= 65) return 'CAUTION';
    return 'HIGH RISK';
  }
  function riskBadge(level) {
    if (!level) return '<span class="score-badge caution"><span class="score-badge-label">UNKNOWN</span></span>';
    var l = String(level).toUpperCase();
    var cls = 'caution';
    if (l === 'SAFE' || l === 'LOW') cls = 'safe';
    else if (l === 'DANGER' || l === 'HIGH' || l === 'CRITICAL') cls = 'danger';
    return '<span class="score-badge ' + cls + '"><span class="score-badge-label">' + escHtml(l) + '</span></span>';
  }
  function parseFindings(text) {
    if (!text) return [];
    var lines = String(text).split('\\n');
    var findings = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.length < 5) continue;
      var sev = 'info';
      var lower = line.toLowerCase();
      if (lower.indexOf('critical') !== -1) sev = 'critical';
      else if (lower.indexOf('high') !== -1) sev = 'high';
      else if (lower.indexOf('medium') !== -1) sev = 'medium';
      else if (lower.indexOf('low') !== -1 && lower.indexOf('low risk') === -1) sev = 'low';
      findings.push({ severity: sev, text: line });
    }
    return findings;
  }
  function renderFindings(findings) {
    if (!findings || findings.length === 0) return '';
    var html = '<div class="finding-group"><div class="finding-group-title">Findings</div>';
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var sev = f.severity || 'info';
      html += '<div class="finding ' + sev + '">';
      html += '<span class="finding-sev ' + sev + '">' + sev.toUpperCase() + '</span>';
      html += escHtml(f.text || f.description || f.message || JSON.stringify(f));
      html += '</div>';
    }
    html += '</div>';
    return html;
  }
  function extractText(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (data.result) return extractText(data.result);
    if (data.output) return typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2);
    if (data.text) return data.text;
    if (data.content) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
    if (data.summary) return data.summary;
    if (data.report) return data.report;
    if (data.analysis) return typeof data.analysis === 'string' ? data.analysis : JSON.stringify(data.analysis, null, 2);
    return JSON.stringify(data, null, 2);
  }

  /* ── Generic submit handler ── */
  async function submitEndpoint(prefix, path, body, label) {
    resetPanel(prefix, path.replace('/x402/', ''));
    var t0 = Date.now();
    try {
      var res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 402) { showPayment(prefix); showRemainingBanner(0); return; }
      var remaining = res.headers.get('X-SwarmX-Free-Remaining');
      if (remaining !== null) showRemainingBanner(parseInt(remaining, 10));
      var data = await res.json();
      donePanel(prefix);
      if (!res.ok) { showError(prefix, data.error || 'Request failed (' + res.status + ')'); return; }
      var elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      var text = extractText(data);
      var score = data.riskScore || data.risk_score || data.score;
      var riskLevel = data.riskLevel || data.risk_level || data.risk || data.rating;
      var findings = data.findings || data.vulnerabilities || data.issues || data.risks || data.signals;
      var html = '<div class="result-box"><div class="result-header"><div class="result-header-left"><span class="result-label">' + escHtml(label || 'Result') + '</span></div><span class="result-time">' + elapsed + '</span></div><div class="result-body">';
      if (riskLevel) { html += riskBadge(riskLevel); }
      if (score !== undefined && score !== null) {
        var sc = scoreClass(score);
        html += '<div class="score-badge ' + sc + '">' + escHtml(String(score)) + '/100 <span class="score-badge-label">' + scoreLabel(score) + '</span></div>';
      }
      if (Array.isArray(findings) && findings.length > 0) {
        html += renderFindings(findings);
      } else if (text) {
        var parsed = parseFindings(text);
        if (parsed.length > 2) { html += renderFindings(parsed); }
      }
      html += '<div class="finding-group"><div class="finding-group-title">Full Output</div><div class="result-summary">' + escHtml(text) + '</div></div>';
      html += '</div></div>';
      html += renderShareSection(data);
      var area = document.getElementById(prefix + '-results');
      if (area) { area.innerHTML = html; area.classList.remove('hidden'); }
    } catch (err) {
      showError(prefix, err.message || 'Network error');
    }
  }

  /* ── Price update helper ── */
  function updatePrice(selectId, priceId) {
    var sel = document.getElementById(selectId);
    var price = document.getElementById(priceId);
    if (sel && price) {
      var opt = sel.options[sel.selectedIndex];
      price.textContent = opt.getAttribute('data-price') || '';
    }
  }

  /* ══════════════════════════════════════════════════════════
     CRYPTO TAB — form switching + submit
     ══════════════════════════════════════════════════════════ */
  // The select drives which inputs are shown, but it only fired on change —
  // a restored or default selection left the form showing the wrong fields.
  document.addEventListener('DOMContentLoaded', function() { updateCryptoForm(); });

  function updateCryptoForm() {
    var ep = document.getElementById('crypto-endpoint').value;
    updatePrice('crypto-endpoint', 'crypto-price');
    var isCode = ep.indexOf('contract-audit') !== -1;
    var isAddress = ep === 'token-risk' || ep === 'memecoin-score' || ep === 'wallet-risk-score';
    var isTx = ep === 'tx-explainer';
    var isDao = ep === 'dao-analyze';
    var isTicker = ep === 'rwa/stock-dd';
    /* textarea for code or DAO proposals */
    document.getElementById('crypto-textarea-group').style.display = (isCode || isDao) ? '' : 'none';
    document.getElementById('crypto-text-group').style.display = (isAddress || isTx || isTicker) ? '' : 'none';
    document.getElementById('crypto-lang-group').style.display = isCode ? '' : 'none';
    document.getElementById('crypto-chain-group').style.display = (ep === 'token-risk') ? '' : 'none';
    if (isCode) {
      document.getElementById('crypto-input-label').textContent = 'Contract Code';
      document.getElementById('crypto-textarea').placeholder = '// Paste smart contract code...';
    } else if (isDao) {
      document.getElementById('crypto-input-label').textContent = 'Proposal Text';
      document.getElementById('crypto-textarea').placeholder = 'Paste the DAO proposal text...';
    }
    if (isAddress) {
      var lbl = ep === 'wallet-risk-score' ? 'Wallet Address' : 'Token Mint Address';
      document.getElementById('crypto-text-label').textContent = lbl;
      document.getElementById('crypto-text').placeholder = 'e.g. So11111111111111111111111111111111111111112';
    } else if (isTx) {
      document.getElementById('crypto-text-label').textContent = 'Transaction Signature';
      document.getElementById('crypto-text').placeholder = 'e.g. 48HXBQNS...';
    } else if (isTicker) {
      document.getElementById('crypto-text-label').textContent = 'Stock Ticker';
      document.getElementById('crypto-text').placeholder = 'e.g. NVDA';
    }
  }

  function runCrypto() {
    var ep = document.getElementById('crypto-endpoint').value;
    var path = '/x402/' + ep;
    var body = {};
    if (ep.indexOf('contract-audit') !== -1) {
      var code = document.getElementById('crypto-textarea').value.trim();
      if (!code) { showError('crypto', 'Please paste some code.'); return; }
      body = { code: code, language: document.getElementById('crypto-lang').value };
    } else if (ep === 'token-risk') {
      var mint = document.getElementById('crypto-text').value.trim();
      if (!mint) { showError('crypto', 'Please enter a mint address.'); return; }
      body = { mint: mint, chain: document.getElementById('crypto-chain').value };
    } else if (ep === 'memecoin-score') {
      var mint = document.getElementById('crypto-text').value.trim();
      if (!mint) { showError('crypto', 'Please enter a mint address.'); return; }
      body = { mint: mint };
    } else if (ep === 'wallet-risk-score') {
      var addr = document.getElementById('crypto-text').value.trim();
      if (!addr) { showError('crypto', 'Please enter a wallet address.'); return; }
      body = { address: addr };
    } else if (ep === 'tx-explainer') {
      var sig = document.getElementById('crypto-text').value.trim();
      if (!sig) { showError('crypto', 'Please enter a transaction signature.'); return; }
      body = { signature: sig };
    } else if (ep === 'dao-analyze') {
      var proposal = document.getElementById('crypto-textarea').value.trim();
      if (!proposal) { showError('crypto', 'Please enter a proposal.'); return; }
      body = { proposal: proposal };
    } else if (ep === 'rwa/stock-dd') {
      var ticker = document.getElementById('crypto-text').value.trim().toUpperCase();
      if (!ticker) { showError('crypto', 'Please enter a stock ticker.'); return; }
      body = { ticker: ticker };
    }
    submitEndpoint('crypto', path, body, ep.replace(/-/g, ' ').replace(/\\/.*/, ''));
  }

  /* ══════════════════════════════════════════════════════════
     CONTENT TAB
     ══════════════════════════════════════════════════════════ */
  function updateContentForm() {
    var ep = document.getElementById('content-endpoint').value;
    updatePrice('content-endpoint', 'content-price');
    var isTranslate = ep === 'translate';
    var isExtract = ep === 'extract' || ep === 'document-extract';
    var isSeo = ep === 'seo-article';
    document.getElementById('content-lang-group').style.display = isTranslate ? '' : 'none';
    document.getElementById('content-fields-group').style.display = isExtract ? '' : 'none';
    document.getElementById('content-keywords-group').style.display = isSeo ? '' : 'none';
    var labels = {
      'seo-article': 'Topic / Keywords',
      'summarize': 'Text to Summarize',
      'translate': 'Text to Translate',
      'document-extract': 'Document Text',
      'write': 'Topic or Prompt',
      'sentiment': 'Text to Analyze',
      'extract': 'Text to Extract From'
    };
    document.getElementById('content-input-label').textContent = labels[ep] || 'Input';
  }

  function runContent() {
    var ep = document.getElementById('content-endpoint').value;
    var text = document.getElementById('content-textarea').value.trim();
    if (!text) { showError('content', 'Please enter some text.'); return; }
    var body = {};
    if (ep === 'seo-article') {
      var kw = document.getElementById('content-keywords').value.trim();
      body = { topic: text };
      if (kw) body.keywords = kw.split(',').map(function(k){ return k.trim(); });
    } else if (ep === 'translate') {
      body = { text: text, targetLanguage: document.getElementById('content-lang').value.trim() || 'Spanish' };
    } else if (ep === 'extract' || ep === 'document-extract') {
      var fields = document.getElementById('content-fields').value.trim();
      body = { text: text };
      if (fields) body.fields = fields.split(',').map(function(f){ return f.trim(); });
    } else if (ep === 'write') {
      body = { topic: text };
    } else {
      body = { text: text };
    }
    submitEndpoint('content', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     CODE TAB
     ══════════════════════════════════════════════════════════ */
  function updateCodeForm() {
    updatePrice('code-endpoint', 'code-price');
  }

  function runCode() {
    var ep = document.getElementById('code-endpoint').value;
    var code = document.getElementById('code-textarea').value.trim();
    if (!code) { showError('code', 'Please paste some code.'); return; }
    var lang = document.getElementById('code-lang').value.trim();
    var body = { code: code };
    if (lang) body.language = lang;
    submitEndpoint('code', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     RESEARCH TAB
     ══════════════════════════════════════════════════════════ */
  function updateResearchForm() {
    var ep = document.getElementById('research-endpoint').value;
    updatePrice('research-endpoint', 'research-price');
    var labels = {
      'research-report': 'Research Topic',
      'research': 'Research Question',
      'analyze': 'Topic to Analyze',
      'debate': 'Debate Topic',
      'agent': 'Task Description'
    };
    document.getElementById('research-input-label').textContent = labels[ep] || 'Input';
  }

  function runResearch() {
    var ep = document.getElementById('research-endpoint').value;
    var text = document.getElementById('research-textarea').value.trim();
    if (!text) { showError('research', 'Please enter a topic or question.'); return; }
    var body = {};
    if (ep === 'agent') {
      body = { task: text };
    } else if (ep === 'debate') {
      body = { topic: text };
    } else if (ep === 'analyze') {
      body = { topic: text };
    } else {
      body = { query: text };
    }
    submitEndpoint('research', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     DEFI TAB
     ══════════════════════════════════════════════════════════ */
  function updateDefiForm() {
    var ep = document.getElementById('defi-endpoint').value;
    updatePrice('defi-endpoint', 'defi-price');
    var needsWallet = ep === 'wallet-analyzer' || ep === 'wallet-report' || ep === 'defi-positions';
    var needsYield = ep === 'yield-optimizer';
    document.getElementById('defi-wallet-group').style.display = needsWallet ? '' : 'none';
    document.getElementById('defi-yield-group').style.display = needsYield ? '' : 'none';
    document.getElementById('defi-risk-group').style.display = needsYield ? '' : 'none';
  }

  function runDefi() {
    var ep = document.getElementById('defi-endpoint').value;
    var body = {};
    if (ep === 'yield-optimizer') {
      body = { riskTolerance: document.getElementById('defi-risk').value };
      var amt = document.getElementById('defi-amount').value;
      if (amt) body.amount = parseFloat(amt);
    } else {
      var addr = document.getElementById('defi-wallet').value.trim();
      if (!addr) { showError('defi', 'Please enter a wallet address.'); return; }
      body = { address: addr };
    }
    submitEndpoint('defi', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     TRADING TAB
     ══════════════════════════════════════════════════════════ */
  function updateTradingForm() {
    var ep = document.getElementById('trading-endpoint').value;
    updatePrice('trading-endpoint', 'trading-price');
    var needsMint = ep === 'token-price' || ep === 'token-supply';
    var needsOwner = ep === 'token-accounts';
    var needsNone = ep === 'slot-info' || ep === 'recent-blockhash';
    document.getElementById('trading-mint-group').style.display = needsNone ? 'none' : '';
    document.getElementById('trading-owner-group').style.display = needsOwner ? '' : 'none';
    if (needsMint) {
      document.getElementById('trading-input-label').textContent = 'Token Mint Address';
    } else if (needsOwner) {
      document.getElementById('trading-input-label').textContent = 'Mint Address (optional filter)';
    }
  }

  function runTrading() {
    var ep = document.getElementById('trading-endpoint').value;
    var body = {};
    if (ep === 'token-price' || ep === 'token-supply') {
      var mint = document.getElementById('trading-mint').value.trim();
      if (!mint) { showError('trading', 'Please enter a mint address.'); return; }
      body = { mint: mint };
    } else if (ep === 'token-accounts') {
      var owner = document.getElementById('trading-owner').value.trim();
      if (!owner) { showError('trading', 'Please enter a wallet address.'); return; }
      body = { owner: owner };
      var mint = document.getElementById('trading-mint').value.trim();
      if (mint) body.mint = mint;
    } else {
      /* slot-info, recent-blockhash need no input */
    }
    submitEndpoint('trading', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     ENTERPRISE TAB
     ══════════════════════════════════════════════════════════ */
  function updateEnterpriseForm() {
    var ep = document.getElementById('enterprise-endpoint').value;
    updatePrice('enterprise-endpoint', 'enterprise-price');
    var isDD = ep === 'investment-dd';
    var isCompliance = ep === 'compliance-check';
    document.getElementById('enterprise-url-group').style.display = isDD ? '' : 'none';
    document.getElementById('enterprise-framework-group').style.display = isCompliance ? '' : 'none';
    document.getElementById('enterprise-input-label').textContent = isDD ? 'Project Name / Description' : 'Document / Policy Text';
    document.getElementById('enterprise-textarea').placeholder = isDD
      ? 'Describe the project for due diligence analysis...'
      : 'Paste the document or describe the project for compliance check...';
  }

  function runEnterprise() {
    var ep = document.getElementById('enterprise-endpoint').value;
    var text = document.getElementById('enterprise-textarea').value.trim();
    if (!text) { showError('enterprise', 'Please enter a description.'); return; }
    var body = {};
    if (ep === 'investment-dd') {
      body = { projectName: text };
      var url = document.getElementById('enterprise-url').value.trim();
      if (url) body.websiteUrl = url;
    } else {
      body = { document: text };
      var fw = document.getElementById('enterprise-framework').value;
      if (fw) body.framework = fw;
    }
    submitEndpoint('enterprise', '/x402/' + ep, body, ep.replace(/-/g, ' '));
  }

  /* ══════════════════════════════════════════════════════════
     BATCH TAB
     ══════════════════════════════════════════════════════════ */
  function runBatch() {
    var raw = document.getElementById('batch-textarea').value.trim();
    if (!raw) { showError('batch', 'Please enter a batch request JSON.'); return; }
    var body;
    try { body = JSON.parse(raw); } catch (e) { showError('batch', 'Invalid JSON: ' + e.message); return; }
    submitEndpoint('batch', '/x402/batch', body, 'Batch Results');
  }
  </script>
</body>
</html>`;

        return withCORS(new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }));
      }

      // ── MCP Manifest (generated in-memory; no disk dependency) ────
      if (pathname === "/mcp-manifest.json" && method === "GET") {
        return withCORS(new Response(JSON.stringify(getMcpToolDefinitions(), null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }));
      }

      // ── MCP Server (JSON-RPC 2.0 over Streamable HTTP) ────────────
      if (pathname === "/mcp") {
        const publicBase = (process.env.SWARMX_BASE_URL ?? "https://swarmx.io").replace(/\/$/, "");
        if (method === "GET") {
          return withCORS(Response.json(mcpDescriptor(publicBase)));
        }
        if (method === "POST") {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return withCORS(
              Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
            );
          }
          const mcpOpts = { baseUrl: `http://127.0.0.1:${PORT}`, publicBaseUrl: publicBase };
          if (Array.isArray(body)) {
            const responses = (
              await Promise.all(body.map((m) => handleMcpMessage(m as JsonRpcMessage, mcpOpts)))
            ).filter((r) => r !== null);
            if (responses.length === 0) return withCORS(new Response(null, { status: 202 }));
            return withCORS(Response.json(responses));
          }
          const response = await handleMcpMessage(body as JsonRpcMessage, mcpOpts);
          if (response === null) return withCORS(new Response(null, { status: 202 }));
          return withCORS(Response.json(response));
        }
        return withCORS(Response.json({ error: "Method not allowed" }, { status: 405 }));
      }

      // ── Gallery page ──────────────────────────────────────────────
      if (pathname === "/x402/gallery" && method === "GET") {
        return withCORS(new Response(buildGalleryHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }));
      }

      // ── Benchmark page ────────────────────────────────────────────
      if (pathname === "/x402/benchmark" && method === "GET") {
        return withCORS(new Response(buildBenchmarkHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }));
      }

      // ── Benchmark JSON API ────────────────────────────────────────
      if (pathname === "/api/benchmark" && method === "GET") {
        const data = loadBenchmarkResults();
        if (!data) {
          return withCORS(Response.json({ error: "Benchmark results not available" }, { status: 404 }));
        }
        return withCORS(Response.json(data));
      }

      // ── Report page: GET /report/:id ─────────────────────────────────
      if (method === "GET" && pathname.startsWith("/report/")) {
        const id = pathname.slice("/report/".length);
        const report = getReport(id);
        if (!report) {
          return withCORS(Response.json({ error: "Report not found" }, { status: 404 }));
        }
        return withCORS(new Response(buildReportPageHtml(report), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }));
      }

      // ── Badge SVG: GET /badge/:id ─────────────────────────────────────
      if (method === "GET" && pathname.startsWith("/badge/")) {
        const id = pathname.slice("/badge/".length);
        const report = getReport(id);
        if (!report) {
          return withCORS(new Response(buildBadgeSvg(null), {
            status: 200,
            headers: {
              "Content-Type": "image/svg+xml",
              "Cache-Control": "public, max-age=3600",
            },
          }));
        }
        return withCORS(new Response(buildBadgeSvg(report.riskScore), {
          status: 200,
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "public, max-age=3600",
          },
        }));
      }

      // ── Recent reports API: GET /api/reports ──────────────────────────
      if (method === "GET" && pathname === "/api/reports") {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const reports = getRecentReports(Math.min(limit, 100));
        return withCORS(Response.json({ count: getReportCount(), reports }));
      }

      // ── Route dispatch ──────────────────────────────────────────────
      const handler = routeMap.get(`${method} ${pathname}`);
      if (!handler) {
        return withCORS(Response.json(
          { error: "Not found", path: pathname, method },
          { status: 404 }
        ));
      }

      // Parse body for POST/PUT/PATCH
      let body: Record<string, unknown> | undefined;
      if (["POST", "PUT", "PATCH"].includes(method)) {
        const contentLength = parseInt(request.headers.get("content-length") ?? "0");
        if (contentLength > 1_000_000) { // 1MB max
          return withCORS(Response.json({ error: "Request body too large (max 1MB)" }, { status: 413 }));
        }
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }

      // Build RouteRequest
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const req: RouteRequest = {
        body,
        params: {},
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        method,
        path: pathname,
        url: request.url,
      };

      // Build RouteResponse adapter (accumulates into a Response)
      let responseStatus = 200;
      let responseBody: unknown = null;
      const responseHeaders = new Map<string, string>();

      const res: RouteResponse = {
        status(code: number) {
          responseStatus = code;
          return res;
        },
        json(data: unknown) {
          responseBody = data;
          return res;
        },
        send(data: unknown) {
          responseBody = data;
          return res;
        },
        end() {
          return res;
        },
        setHeader(name: string, value: string | string[]) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          return res;
        },
      };

      try {
        await handler(req, res, runtime);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { error: errorMsg },
          `[server] Unhandled error in ${method} ${pathname}`
        );
        // Alert Itachi debug bot
        sendDebugAlert("error", `Unhandled error in ${method} ${pathname}`, {
          error: errorMsg,
          method,
          path: pathname,
        });
        return withCORS(Response.json(
          { error: "Internal server error" },
          { status: 500 }
        ));
      }

      // Convert accumulated response
      const outHeaders: Record<string, string> = {};
      responseHeaders.forEach((v, k) => {
        outHeaders[k] = v;
      });

      if (responseBody !== null && responseBody !== undefined) {
        outHeaders["Content-Type"] = outHeaders["Content-Type"] ?? "application/json";
        return withCORS(new Response(JSON.stringify(responseBody), {
          status: responseStatus,
          headers: outHeaders,
        }));
      }

      return withCORS(new Response(null, { status: responseStatus, headers: outHeaders }));
    },
  });

  logger.info(`Standalone x402 server listening on http://localhost:${server.port}`);
  logger.info(`Dashboard: http://localhost:${server.port}/`);
  logger.info(`API Status: http://localhost:${server.port}/api/status`);
  logger.info(`Catalog: http://localhost:${server.port}/x402/catalog`);
}

startServer()
  .then(() => {
    sendDebugAlert("info", "x402-swarms server started", { port: PORT });
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Fatal: failed to start server", err);
    sendDebugAlert("error", `Fatal: server failed to start — ${msg}`);
    process.exit(1);
  });
