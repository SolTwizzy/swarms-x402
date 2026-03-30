# SwarmX Platform Architecture

Visual architecture of the SwarmX platform -- how requests flow from client to response, how payments work, and how LLM routing is decided.

## Request Flow

```mermaid
graph TB
    Client["Client<br/>(Human / AI Agent / SDK)"] -->|"HTTP Request"| Gateway["x402 Payment Gate"]

    Gateway -->|"Free Tier<br/>5 calls/day per IP"| Handler["Route Handler"]
    Gateway -->|"No Payment + Free Exhausted"| Reject["HTTP 402<br/>Payment Required"]
    Gateway -->|"USDC Payment Header"| Verify["Verify + Settle"]

    Verify -->|"Valid"| Handler
    Verify -->|"Invalid"| Reject402["HTTP 402<br/>Verification Failed"]

    Verify -->|"On settlement"| Dexter["Dexter Facilitator<br/>x402.dexter.cash"]
    Dexter -->|"Confirm on-chain"| Handler

    Handler -->|"Single Agent<br/>(agent, summarize,<br/>translate, extract,<br/>sentiment)"| OpenAI["Direct OpenAI<br/>~$0.001 LLM cost"]

    Handler -->|"Multi Agent<br/>(research, analyze,<br/>code-review, write,<br/>debate)"| Swarms["Swarms Cloud API<br/>api.swarms.world"]

    Handler -->|"On-chain Data<br/>(wallet-analyzer,<br/>token-holders,<br/>tx-history, etc.)"| Helius["Helius RPC<br/>mainnet.helius-rpc.com"]

    Handler -->|"Price Data<br/>(token-price)"| Jupiter["Jupiter Price API<br/>api.jup.ag"]

    Swarms -->|"2-6 Agents<br/>Orchestrated"| Result["Structured Result"]
    OpenAI --> Result
    Helius --> Result
    Jupiter --> Result

    Result -->|"Record payment"| Revenue["Revenue Tracker<br/>X402ServerService"]
    Result -->|"JSON Response"| Client

    style Gateway fill:#f9a825,stroke:#f57f17,color:#000
    style Reject fill:#ef5350,stroke:#c62828,color:#fff
    style Reject402 fill:#ef5350,stroke:#c62828,color:#fff
    style OpenAI fill:#10a37f,stroke:#0d8c6c,color:#fff
    style Swarms fill:#7c4dff,stroke:#6200ea,color:#fff
    style Dexter fill:#1565c0,stroke:#0d47a1,color:#fff
    style Revenue fill:#2e7d32,stroke:#1b5e20,color:#fff
```

## Payment Gate Detail

```mermaid
flowchart TD
    Request["Incoming Request"] --> CheckHeader{"payment-signature<br/>header present?"}

    CheckHeader -->|"Yes"| VerifyPay["Verify payment<br/>via Dexter facilitator"]
    VerifyPay -->|"Valid"| Settle["Settle on-chain"]
    Settle -->|"Success"| RecordRev["Record revenue<br/>+ proceed"]
    Settle -->|"Failed"| Return402a["402: Settlement failed"]
    VerifyPay -->|"Invalid"| Return402b["402: Verification failed"]

    CheckHeader -->|"No"| CheckFree{"Free tier<br/>enabled?"}
    CheckFree -->|"No"| BuildReq["Build 402 requirements"]
    CheckFree -->|"Yes"| CheckIP{"IP + cookie<br/>under 5/day?"}
    CheckIP -->|"Yes"| SetCookie["Set swarmx_usage cookie<br/>+ X-SwarmX-Free-Remaining<br/>header"] --> Proceed["Proceed (free)"]
    CheckIP -->|"No"| BuildReq
    BuildReq --> Return402c["402: Payment required<br/>+ PAYMENT-REQUIRED header"]

    style Return402a fill:#ef5350,color:#fff
    style Return402b fill:#ef5350,color:#fff
    style Return402c fill:#ef5350,color:#fff
    style Proceed fill:#4caf50,color:#fff
    style RecordRev fill:#4caf50,color:#fff
```

## LLM Routing Strategy

```mermaid
flowchart LR
    Request["Request"] --> Decision{"Task type?"}

    Decision -->|"Single-agent<br/>endpoints"| DirectLLM["Direct OpenAI Call<br/>via src/utils/llm.ts"]
    Decision -->|"Multi-agent<br/>endpoints"| SwarmsAPI["Swarms Cloud API<br/>via SwarmsService"]
    Decision -->|"Data<br/>endpoints"| OnChain["Helius RPC / Jupiter<br/>No LLM needed"]

    DirectLLM --> Model["gpt-4o-mini<br/>~$0.001/call"]
    SwarmsAPI --> Orchestrate["2-6 agents<br/>~$0.01-0.10/call"]

    subgraph "Single-Agent Endpoints ($0.01-$0.02)"
        SA1["/x402/agent"]
        SA2["/x402/summarize"]
        SA3["/x402/translate"]
        SA4["/x402/extract"]
        SA5["/x402/sentiment"]
    end

    subgraph "Multi-Agent Endpoints ($0.03-$0.25)"
        MA1["/x402/research — 3 agents"]
        MA2["/x402/analyze — 4 agents"]
        MA3["/x402/code-review — 3 agents"]
        MA4["/x402/write — 3 agents"]
        MA5["/x402/debate — 3 agents"]
        MA6["/x402/contract-audit — 4-6 agents"]
        MA7["/x402/token-risk — 3 agents"]
        MA8["/x402/dao-analyze — 4 agents"]
    end

    subgraph "Data Endpoints ($0.001-$0.03)"
        DA1["/x402/wallet-analyzer"]
        DA2["/x402/token-holders"]
        DA3["/x402/token-price"]
        DA4["/x402/tx-history"]
        DA5["/x402/slot-info"]
    end

    DirectLLM -.->|"Fallback if no<br/>OPENAI_API_KEY"| SwarmsAPI

    style DirectLLM fill:#10a37f,color:#fff
    style SwarmsAPI fill:#7c4dff,color:#fff
    style OnChain fill:#ff6f00,color:#fff
```

## Swarm Architecture Patterns

SwarmX uses four orchestration patterns depending on the endpoint:

```mermaid
graph TB
    subgraph "SequentialWorkflow"
        direction LR
        S1["Researcher"] --> S2["FactChecker"] --> S3["Writer"]
    end

    subgraph "ConcurrentWorkflow"
        direction TB
        C0["Task"] --> C1["SecurityAuditor"]
        C0 --> C2["EconomicAttacker"]
        C0 --> C3["GasOptimizer"]
        C0 --> C4["AuditReporter"]
        C1 & C2 & C3 & C4 --> CM["Merge Results"]
    end

    subgraph "MixtureOfAgents"
        direction TB
        M0["Task"] --> M1["TechnicalExpert"]
        M0 --> M2["EconomicExpert"]
        M0 --> M3["RiskExpert"]
        M1 & M2 & M3 --> M4["Synthesizer"]
    end

    subgraph "MajorityVoting"
        direction TB
        V0["Proposition"] --> V1["Proponent"]
        V0 --> V2["Opponent"]
        V1 & V2 --> V3["Judge<br/>(verdict + confidence)"]
    end
```

| Pattern | Used By | How It Works |
|---------|---------|--------------|
| SequentialWorkflow | research, write, token-risk | Agents run in order; each builds on the previous agent's output |
| ConcurrentWorkflow | code-review, contract-audit | Agents run in parallel; results are merged |
| MixtureOfAgents | analyze, dao-analyze | Domain experts run in parallel, then a synthesizer combines |
| MajorityVoting | debate | Pro/con agents argue, a judge delivers the verdict |

## Revenue Flow

```mermaid
sequenceDiagram
    participant Client
    participant SwarmX
    participant Dexter as Dexter Facilitator
    participant Chain as Blockchain (Solana/Base)

    Client->>SwarmX: POST /x402/research {"query": "..."}
    SwarmX-->>Client: 402 Payment Required + requirements
    Note over Client: Dexter SDK signs USDC transfer
    Client->>SwarmX: POST /x402/research + payment-signature header
    SwarmX->>Dexter: Verify payment signature
    Dexter->>Chain: Confirm USDC transfer
    Chain-->>Dexter: Transaction confirmed
    Dexter-->>SwarmX: Payment valid + tx hash
    Note over SwarmX: Record revenue, run swarm
    SwarmX->>SwarmX: Execute 3-agent pipeline
    SwarmX-->>Client: 200 OK {"result": "...", "payment": {"transaction": "..."}}
```

## Deployment Architecture

```mermaid
graph TB
    subgraph "Production (Railway)"
        Server["Bun HTTP Server<br/>server.ts"]
        Server --> Routes["28 Route Handlers"]
        Routes --> Gate["x402Gate Middleware"]
    end

    subgraph "External Services"
        DexterFac["Dexter Facilitator<br/>x402.dexter.cash"]
        SwarmsCloud["Swarms Cloud API<br/>api.swarms.world"]
        OpenAIAPI["OpenAI API"]
        HeliusRPC["Helius RPC<br/>mainnet.helius-rpc.com"]
        JupiterAPI["Jupiter Price API<br/>api.jup.ag"]
    end

    subgraph "Discovery"
        DexterSDK["Dexter SDK<br/>searchAPIs()"]
        DexterMCP["OpenDexter MCP<br/>open.dexter.cash/mcp"]
    end

    Gate --> DexterFac
    Routes --> SwarmsCloud
    Routes --> OpenAIAPI
    Routes --> HeliusRPC
    Routes --> JupiterAPI

    DexterSDK -.->|"Discovers"| Server
    DexterMCP -.->|"Discovers"| Server

    style Server fill:#1565c0,color:#fff
    style Gate fill:#f9a825,color:#000
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `X402_RECEIVE_ADDRESS` | Yes (sell-side) | Wallet address to receive USDC payments |
| `X402_NETWORK_ID` | No | Default: `base-mainnet`. Supported: `solana-mainnet`, `base-mainnet`, `ethereum-mainnet`, `polygon-mainnet`, `arbitrum-mainnet` |
| `SWARMS_API_KEY` | Yes (multi-agent) | Swarms cloud API key for multi-agent orchestration |
| `OPENAI_API_KEY` | Yes (single-agent) | Direct OpenAI calls for single-agent endpoints |
| `HELIUS_API_KEY` | Yes (data endpoints) | Helius RPC access for on-chain data |
| `SOLANA_PRIVATE_KEY` | Yes (buy-side) | Wallet key for making x402 payments (client-side) |
| `EVM_PRIVATE_KEY` | Alt (buy-side) | EVM wallet key for Base/Polygon/Arbitrum payments |
| `X402_BUDGET_USD` | No | Total budget cap (default: `10.00`) |
| `X402_MAX_AUTO_PAY_USD` | No | Max per-request payment (default: `0.10`) |
| `X402_ACCESS_PASS_TIER` | No | Access pass tier: `24h`, `7d`, or `30d` |
