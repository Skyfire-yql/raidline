import { eq } from "drizzle-orm";
import { ensureDbSchema, getDb } from "@/db";
import { plans } from "@/db/schema";
import type { RaidPlanDocument, StoredPlan } from "./types";
import { normalizePlanDocument } from "./core";

export function jsonData<T>(data: T, init?: ResponseInit) {
  return Response.json({ data }, init);
}

export function jsonError(code: string, message: string, status = 400, details?: unknown) {
  return Response.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function readBearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function findPlan(id: string) {
  await ensureDbSchema();
  const db = getDb();
  const [row] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  return row;
}

export async function authorizePlan(request: Request, id: string) {
  const token = readBearerToken(request);
  if (!token || token.length > 200) return { ok: false as const, reason: "缺少编辑密钥" };
  const row = await findPlan(id);
  if (!row) return { ok: false as const, reason: "计划不存在" };
  const candidate = await hashToken(token);
  if (!safeEqual(candidate, row.editKeyHash)) return { ok: false as const, reason: "编辑密钥无效" };
  return { ok: true as const, row, token };
}

export function toStoredPlan(row: typeof plans.$inferSelect): StoredPlan {
  return {
    id: row.id,
    shareSlug: row.shareSlug,
    title: row.title,
    version: row.version,
    document: normalizePlanDocument(JSON.parse(row.documentJson)) as RaidPlanDocument,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
