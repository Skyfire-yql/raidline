import { eq } from "drizzle-orm";
import { ensureDbSchema, getDb } from "@/db";
import { plans } from "@/db/schema";
import { jsonData, jsonError, toStoredPlan } from "@/lib/server";

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { slug } = await context.params;
    if (!/^[A-Za-z0-9_-]{12,40}$/.test(slug)) return jsonError("NOT_FOUND", "分享链接无效", 404);
    await ensureDbSchema();
    const [row] = await getDb().select().from(plans).where(eq(plans.shareSlug, slug)).limit(1);
    if (!row) return jsonError("NOT_FOUND", "分享计划不存在", 404);
    return jsonData(toStoredPlan(row));
  } catch (error) {
    return jsonError("READ_SHARED_PLAN_FAILED", error instanceof Error ? error.message : "读取分享计划失败", 500);
  }
}
