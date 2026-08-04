import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let schemaReady: Promise<void> | undefined;

export function getRawDb() {
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error("D1 数据库尚未绑定");
  }
  return bindings.DB;
}

export async function ensureDbSchema() {
  if (!schemaReady) {
    const d1 = getRawDb();
    schemaReady = d1
      .batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY NOT NULL,
          share_slug TEXT NOT NULL,
          edit_key_hash TEXT NOT NULL,
          title TEXT NOT NULL,
          encounter_name TEXT NOT NULL,
          difficulty TEXT NOT NULL,
          source_provider TEXT,
          source_ref TEXT,
          document_json TEXT NOT NULL,
          version INTEGER DEFAULT 1 NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_share_slug ON plans (share_slug)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_plans_updated_at ON plans (updated_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS wcl_cache (
          cache_key TEXT PRIMARY KEY NOT NULL,
          payload_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_wcl_cache_expires_at ON wcl_cache (expires_at)"),
        d1.prepare("PRAGMA optimize"),
      ])
      .then(() => undefined);
  }
  await schemaReady;
}

export function getDb() {
  return drizzle(getRawDb(), { schema });
}
