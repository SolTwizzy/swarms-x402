/**
 * SwarmX Agent Link worker — reference implementation of the agent side.
 *
 * Pairs with a human's browser on swarmx.io (Moltbook-style magic link),
 * then polls for jobs the human queues from the Markets UI, pays each paid
 * endpoint with THIS agent's wallet via x402 (Meridian EIP-3009 on Base),
 * and posts the result back so it renders in the browser.
 *
 * Usage:
 *   bun scripts/agent-link-worker.ts [baseUrl] [agentName]
 *     baseUrl   default https://swarmx.io (use http://localhost:3000 for dev)
 *     agentName default "claude-code"
 *
 * Env:
 *   X402_TEST_BUYER_EVM_KEY  0x… 32-byte private key holding USDC on Base
 *   SWARMX_AGENT_TOKEN       optional: resume an existing link session
 *
 * Any MCP-capable agent can do the same via the MCP tools on <base>/mcp:
 * swarmx_link_start → swarmx_poll_requests → swarmx_complete_request.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface ExactAccept {
  scheme: string;
  network: string;
  asset: Hex;
  payTo: Hex;
  maxAmountRequired: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

interface LinkJob {
  job_id: string;
  endpoint: string;
  method: "GET" | "POST";
  body: Record<string, unknown>;
  price_usd: string;
  description: string;
}

const CHAIN_IDS: Record<string, number> = { base: 8453, arbitrum: 42161 };

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadDotEnv();

const baseUrl = (process.argv[2] ?? "https://swarmx.io").replace(/\/$/, "");
const agentName = process.argv[3] ?? "claude-code";
const privateKey = process.env.X402_TEST_BUYER_EVM_KEY as Hex | undefined;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error("Set X402_TEST_BUYER_EVM_KEY to a 32-byte 0x private key");
}
const account = privateKeyToAccount(privateKey);

/** Pay one paid endpoint via x402: probe → 402 → EIP-3009 sign → retry. */
async function payEndpoint(job: LinkJob): Promise<Record<string, unknown>> {
  // Probe with no body: discovery-probe path guarantees a 402 challenge and
  // never consumes free tier, so the agent always pays deterministically.
  const probe = await fetch(job.endpoint, { method: job.method });
  if (probe.status !== 402) {
    throw new Error(`Expected 402 challenge, got ${probe.status}`);
  }
  const challenge = (await probe.json()) as { accepts?: ExactAccept[] };
  const accept = challenge.accepts?.find(
    (entry) => entry.scheme === "exact" && CHAIN_IDS[entry.network] !== undefined
  );
  if (!accept) {
    throw new Error("402 challenge advertises no EVM (base/arbitrum) rail");
  }

  const chainId = CHAIN_IDS[accept.network]!;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: account.address,
    to: accept.payTo,
    value: BigInt(accept.maxAmountRequired),
    validAfter: now - 600n,
    validBefore: now + BigInt(accept.maxTimeoutSeconds ?? 300),
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData({
    domain: {
      name: accept.extra?.name ?? "USD Coin",
      version: accept.extra?.version ?? "2",
      chainId,
      verifyingContract: accept.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const paymentHeader = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: accept.network,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    })
  ).toString("base64");

  const paid = await fetch(job.endpoint, {
    method: job.method,
    headers: { "Content-Type": "application/json", "x-payment": paymentHeader },
    body: job.method === "POST" ? JSON.stringify(job.body) : undefined,
  });
  const result = (await paid.json()) as Record<string, unknown>;
  if (!paid.ok) {
    throw new Error(
      `Paid call failed (${paid.status}): ${JSON.stringify(result).slice(0, 300)}`
    );
  }
  return result;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

// ── Main loop ────────────────────────────────────────────────────────────────

let agentToken = process.env.SWARMX_AGENT_TOKEN ?? "";

if (!agentToken) {
  const started = await postJson("/api/agent-link/start", { agent_name: agentName });
  if (typeof started.agent_token !== "string") {
    throw new Error(`link start failed: ${JSON.stringify(started)}`);
  }
  agentToken = started.agent_token;
  console.log("── SwarmX Agent Link ──────────────────────────────");
  console.log(`agent:      ${agentName} (wallet ${account.address})`);
  console.log(`claim_url:  ${started.claim_url}`);
  console.log(`agent_token: ${agentToken}`);
  console.log("Open the claim_url in your browser, then queue a paid run from Markets.");
  console.log("───────────────────────────────────────────────────");
} else {
  console.log(`Resuming session with provided SWARMX_AGENT_TOKEN (wallet ${account.address})`);
}

const seen = new Set<string>();

for (;;) {
  try {
    const polled = await postJson("/api/agent-link/poll", { agent_token: agentToken });
    if (polled.error) throw new Error(String(polled.error));
    const jobs = (polled.jobs as LinkJob[] | undefined) ?? [];
    for (const job of jobs) {
      if (seen.has(job.job_id)) continue;
      seen.add(job.job_id);
      console.log(`\n▶ job ${job.job_id}: ${job.method} ${job.endpoint} ($${job.price_usd})`);
      try {
        const result = await payEndpoint(job);
        const payment = result.payment as Record<string, unknown> | undefined;
        console.log(
          `✓ paid + completed — tx ${payment?.transaction ?? "n/a"} on ${payment?.network ?? "?"}`
        );
        await postJson("/api/agent-link/complete", {
          agent_token: agentToken,
          job_id: job.job_id,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`✗ job failed: ${message}`);
        await postJson("/api/agent-link/complete", {
          agent_token: agentToken,
          job_id: job.job_id,
          error: message,
        });
      }
    }
  } catch (err) {
    console.error(`poll error: ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
