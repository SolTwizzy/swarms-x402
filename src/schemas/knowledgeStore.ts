import { pgTable, text, integer, real, timestamp, jsonb, index, serial } from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the pgvector-backed knowledge store.
 *
 * The `embedding` column stores a JSON-serialised float[] string.
 * Vector operations (cosine distance) use raw SQL with a cast to
 * pgvector's `vector` type since Drizzle doesn't ship native
 * pgvector column support in all versions.
 */
export const x402Knowledge = pgTable(
  "x402_knowledge",
  {
    id: serial("id").primaryKey(),
    entryId: text("entry_id").notNull().unique(),
    type: text("type").notNull(), // KnowledgeType
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    score: integer("score"),
    source: text("source").notNull(),
    metadata: jsonb("metadata"),
    embedding: text("embedding"), // JSON array string, cast to vector for search
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_knowledge_subject").on(table.subject),
    index("idx_knowledge_type").on(table.type),
    index("idx_knowledge_source").on(table.source),
    index("idx_knowledge_entry_id").on(table.entryId),
    index("idx_knowledge_created").on(table.createdAt),
  ],
);
