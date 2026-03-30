import { pgTable, varchar, text, real, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const x402EndpointScores = pgTable(
  "x402_endpoint_scores",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    domain: text("domain").notNull(),
    totalCalls: integer("total_calls").default(0).notNull(),
    totalSpentUsd: real("total_spent_usd").default(0).notNull(),
    avgQualityScore: real("avg_quality_score"),
    avgResponseTimeMs: real("avg_response_time_ms"),
    errorCount: integer("error_count").default(0).notNull(),
    lastCallAt: timestamp("last_call_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_x402_es_agent_domain").on(table.agentId, table.domain),
    index("idx_x402_es_agent_quality").on(table.agentId, table.avgQualityScore),
  ]
);
