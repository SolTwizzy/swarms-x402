# APIs.guru / OpenAPI Directory Submission

**URL:** https://apis.guru/add-api/

## Prerequisite: OpenAPI Spec Required

APIs.guru requires a **stable URL to a machine-readable API definition** (OpenAPI/Swagger format). We do not currently have an OpenAPI spec.

### To complete this submission:

1. Generate an OpenAPI 3.x spec for the SwarmX API (all 47 endpoints)
2. Host it at a stable URL, e.g.:
   - `https://swarmx.io/openapi.json`
   - or in the GitHub repo at `docs/openapi.yaml`
3. Submit via the web form at https://apis.guru/add-api/

### Form Fields

| Field | Value |
|-------|-------|
| **API Definition URL** | `https://swarmx.io/openapi.json` (once created) |
| **Definition Format** | OpenAPI/Swagger |
| **API Source** | Official (by API owner) |
| **API Name** | SwarmX |
| **Category** | Machine Learning |
| **API Logo URL** | (need to create and host a square SVG/PNG logo) |

---

## API Overview (for description)

SwarmX provides 47 HTTP endpoints for AI agent tasks powered by x402 micropayments and Swarms multi-agent orchestration. Endpoints cover contract audits, token diligence, DeFi risk scoring, fact-checking, code audits, research reports, compliance analysis, and more. Pay per call with USDC ($0.001-$5) via the x402 protocol.

---

## TODO

- [ ] Generate OpenAPI 3.x spec from route definitions
- [ ] Add `/openapi.json` endpoint to the server
- [ ] Submit via https://apis.guru/add-api/
