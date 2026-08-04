import { getDb, ensureDbSchema } from "@/db";
import { plans } from "@/db/schema";
import { createBlankPlan } from "@/lib/core";
import { hashToken, jsonData, jsonError, randomToken } from "@/lib/server";

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => ({}))) as { title?: string };
    const title = payload.title?.trim().slice(0, 80) || "新建团本排轴";
    const document = createBlankPlan(title);
    const id = crypto.randomUUID();
    const shareSlug = randomToken(16);
    const editToken = randomToken(32);
    const now = Date.now();
    await ensureDbSchema();
    await getDb().insert(plans).values({
      id,
      shareSlug,
      editKeyHash: await hashToken(editToken),
      title,
      encounterName: document.encounter.name,
      difficulty: document.encounter.difficulty,
      documentJson: JSON.stringify(document),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return jsonData({ id, shareSlug, editToken, version: 1, document }, { status: 201 });
  } catch (error) {
    return jsonError("CREATE_PLAN_FAILED", error instanceof Error ? error.message : "创建计划失败", 500);
  }
}
