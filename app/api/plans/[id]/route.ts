import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plans } from "@/db/schema";
import { assertPlanDocument } from "@/lib/core";
import { authorizePlan, jsonData, jsonError, toStoredPlan } from "@/lib/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const auth = await authorizePlan(request, id);
    if (!auth.ok) return jsonError("UNAUTHORIZED", auth.reason, auth.reason === "计划不存在" ? 404 : 401);
    return jsonData(toStoredPlan(auth.row));
  } catch (error) {
    return jsonError("READ_PLAN_FAILED", error instanceof Error ? error.message : "读取计划失败", 500);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const auth = await authorizePlan(request, id);
    if (!auth.ok) return jsonError("UNAUTHORIZED", auth.reason, auth.reason === "计划不存在" ? 404 : 401);
    const payload = (await request.json()) as { baseVersion?: number; document?: unknown };
    if (!Number.isInteger(payload.baseVersion)) return jsonError("INVALID_VERSION", "缺少有效的基础版本号", 400);
    assertPlanDocument(payload.document);
    const document = payload.document;
    const now = Date.now();
    const source = document.encounter.source;
    const [updated] = await getDb()
      .update(plans)
      .set({
        title: document.encounter.name.trim().slice(0, 80) || "未命名排轴",
        encounterName: document.encounter.name.trim().slice(0, 80) || "未命名首领",
        difficulty: document.encounter.difficulty.trim().slice(0, 30) || "未设置",
        sourceProvider: source?.provider ?? null,
        sourceRef: source ? `${source.reportCode}:${source.fightId}` : null,
        documentJson: JSON.stringify(document),
        version: Number(payload.baseVersion) + 1,
        updatedAt: now,
      })
      .where(and(eq(plans.id, id), eq(plans.version, Number(payload.baseVersion))))
      .returning();
    if (!updated) {
      const latest = await authorizePlan(request, id);
      return jsonError("VERSION_CONFLICT", "服务器上已有更新", 409, latest.ok ? toStoredPlan(latest.row) : undefined);
    }
    return jsonData(toStoredPlan(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存计划失败";
    return jsonError("SAVE_PLAN_FAILED", message, /超出|缺少|不支持|无效|时长/.test(message) ? 422 : 500);
  }
}
