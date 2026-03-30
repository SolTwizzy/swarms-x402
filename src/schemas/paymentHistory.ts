import { pgTable, varchar, text, real, integer, timestamp, index } from "drizzle-orm/pg-core";

export const x402PaymentHistory = pgTable(
  "x402_payment_history",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    endpoint: text("endpoint").notNull(),
    domain: text("domain").notNull(),
    method: text("method").default("GET"),
    amountUsd: real("amount_usd").notNull(),
    txHash: text("tx_hash").notNull(),
    network: text("network"),
    payer: text("payer"),
    status: text("status").notNull().default("confirmed"),
    responseStatus: integer("response_status"),
    responseTimeMs: integer("response_time_ms"),
    qualityScore: real("quality_score"),
    qualityReason: text("quality_reason"),
    responsePreview: text("response_preview"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_x402_ph_agent_domain").on(table.agentId, table.domain),
    index("idx_x402_ph_agent_created").on(table.agentId, table.createdAt),
    index("idx_x402_ph_domain_quality").on(table.domain, table.qualityScore),
  ]
);
