import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    shareSlug: text("share_slug").notNull(),
    editKeyHash: text("edit_key_hash").notNull(),
    title: text("title").notNull(),
    encounterName: text("encounter_name").notNull(),
    difficulty: text("difficulty").notNull(),
    sourceProvider: text("source_provider"),
    sourceRef: text("source_ref"),
    documentJson: text("document_json").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_plans_share_slug").on(table.shareSlug),
    index("idx_plans_updated_at").on(table.updatedAt),
  ],
);

export const wclCache = sqliteTable(
  "wcl_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    payloadJson: text("payload_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_wcl_cache_expires_at").on(table.expiresAt)],
);
