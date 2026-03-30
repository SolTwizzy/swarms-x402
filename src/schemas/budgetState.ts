import { pgTable, varchar, real, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const x402BudgetState = pgTable(
  "x402_budget_state",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    dailySpentUsd: real("daily_spent_usd").default(0).notNull(),
    dailyResetAt: timestamp("daily_reset_at", { withTimezone: true }),
    weeklySpentUsd: real("weekly_spent_usd").default(0).notNull(),
    weeklyResetAt: timestamp("weekly_reset_at", { withTimezone: true }),
    monthlySpentUsd: real("monthly_spent_usd").default(0).notNull(),
    monthlyResetAt: timestamp("monthly_reset_at", { withTimezone: true }),
    lifetimeSpentUsd: real("lifetime_spent_usd").default(0).notNull(),
    lifetimePayments: integer("lifetime_payments").default(0).notNull(),
    dailyBudgetUsd: real("daily_budget_usd"),
    weeklyBudgetUsd: real("weekly_budget_usd"),
    monthlyBudgetUsd: real("monthly_budget_usd"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_x402_bs_agent").on(table.agentId),
  ]
);
