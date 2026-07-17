/**
 * SwarmX Agent Link — one-shot pay pass (for managed agents without a daemon).
 *
 * Unlike agent-link-worker.ts (a long-lived poll loop), this does exactly ONE
 * poll pass: fetch pending jobs, pay each with this agent's wallet via x402,
 * post the results back, and print the paid results as JSON on stdout.
 * A chat agent (OpenClaw, Hermes, Claude...) can call this from its exec tool
 * between conversation turns and read the verdict straight from stdout.
 *
 * Usage:
 *   bun scripts/agent-link-pay-once.ts <baseUrl> <agent_token>
 *
 * Env: X402_TEST_BUYER_EVM_KEY (0x… key holding USDC on Base; .env is loaded)
 * Exit codes: 0 ok (including "no jobs"), 1 config/error.
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

const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  "eip155:8453": 8453,
  arbitrum: 42161,
  "eip155:42161": 42161,
};

function loadDotEnv(): void {
  const path = resolve(import.meta.dir, "..", ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadDotEnv();

const baseUrl = (process.argv[2] ?? "https://swarmx.io").replace(/\/$/, "");
const agentToken = process.argv[3] ?? "";
const privateKey = process.env.X402_TEST_BUYER_EVM_KEY as Hex | undefined;

if (!agentToken) {
  console.error("Usage: bun scripts/agent-link-pay-once.ts <baseUrl> <agent_token>");
  process.exit(1);
}
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error("Set X402_TEST_BUYER_EVM_KEY to a 32-byte 0x private key");
  process.exit(1);
}
const account = privateKeyToAccount(privateKey);

async function payEndpoint(job: LinkJob): Promise<Record<string, unknown>> {
  const probe = await fetch(job.endpoint, { method: job.method });
  if (probe.status !== 402) {
    throw new Error(`Expected 402 challenge, got ${probe.status}`);
  }
  const challenge = (await probe.json()) as { accepts?: ExactAccept[] };
  const accept = challenge.accepts?.find(
    (entry) => entry.scheme === "exact" && CHAIN_IDS[entry.network] !== undefined
  );
  if (!accept) throw new Error("402 challenge advertises no EVM (base/arbitrum) rail");

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
    throw new Error(`Paid call failed (${paid.status}): ${JSON.stringify(result).slice(0, 300)}`);
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

const polled = await postJson("/api/agent-link/poll", { agent_token: agentToken });
if (polled.error) {
  console.error(`poll error: ${String(polled.error)}`);
  process.exit(1);
}
const jobs = (polled.jobs as LinkJob[] | undefined) ?? [];
const outputs: Record<string, unknown>[] = [];

for (const job of jobs) {
  try {
    const result = await payEndpoint(job);
    await postJson("/api/agent-link/complete", {
      agent_token: agentToken,
      job_id: job.job_id,
      result,
    });
    outputs.push({
      job_id: job.job_id,
      endpoint: job.endpoint,
      price_usd: job.price_usd,
      payment: result.payment ?? null,
      result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postJson("/api/agent-link/complete", {
      agent_token: agentToken,
      job_id: job.job_id,
      error: message,
    });
    outputs.push({ job_id: job.job_id, endpoint: job.endpoint, error: message });
  }
}

console.log(JSON.stringify({ jobs: jobs.length, paid: outputs }, null, 2));
