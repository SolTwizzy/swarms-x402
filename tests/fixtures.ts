import type { DiscoveredAPI } from "@dexterai/x402/client";

export const MOCK_APIS: DiscoveredAPI[] = [
  {
    name: "Exa Search",
    url: "https://api.exa.ai/search",
    method: "POST",
    price: "$0.05",
    priceUsdc: 0.05,
    network: "eip155:8453",
    description: "AI-powered web search",
    category: "ai",
    qualityScore: 85,
    verified: true,
    totalCalls: 1200,
    totalVolume: "$60.00",
    seller: "Exa AI",
    sellerReputation: 92,
    authRequired: false,
    lastActive: "2026-03-18T12:00:00Z",
  },
  {
    name: "Chainlink Oracle",
    url: "https://oracle.x402bazaar.io/prices",
    method: "GET",
    price: "$0.001",
    priceUsdc: 0.001,
    network: "eip155:8453",
    description: "Real-time DeFi price feeds",
    category: "defi",
    qualityScore: 95,
    verified: true,
    totalCalls: 50000,
    totalVolume: "$50.00",
    seller: "Chainlink",
    sellerReputation: 99,
    authRequired: false,
    lastActive: "2026-03-19T00:00:00Z",
  },
];

export const MOCK_LEDGER = [
  { amount: 0.05, domain: "api.exa.ai", network: "eip155:8453", timestamp: Date.now() - 60000 },
  { amount: 0.02, domain: "data.example.com", network: "eip155:8453", timestamp: Date.now() - 30000 },
  { amount: 0.01, domain: "oracle.io", network: "eip155:137", timestamp: Date.now() - 10000 },
];

export const DEFAULT_TEST_SETTINGS: Record<string, string> = {
  EVM_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  X402_NETWORK_ID: "base-sepolia",
  X402_MAX_AUTO_PAY_USD: "0.10",
  X402_BUDGET_USD: "10.00",
  X402_RECEIVE_ADDRESS: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
};
