import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { plans } from "@/db/schema";
import { assertPlanDocument, makeId } from "@/lib/core";
import { authorizePlan, jsonData, jsonError, toStoredPlan } from "@/lib/server";
import type { RaidMechanic, RaidPlanDocument } from "@/lib/types";
import { analyzeWclFight, WclError } from "@/lib/wcl";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const auth = await authorizePlan(request, id);
    if (!auth.ok) return jsonError("UNAUTHORIZED", auth.reason, auth.reason === "计划不存在" ? 404 : 401);
    const payload = (await request.json()) as {
      reportCode?: string;
      fightId?: number;
      selectedAbilityIds?: number[];
      includeObservedCooldowns?: boolean;
      baseVersion?: number;
    };
    if (!payload.reportCode || !Number.isInteger(payload.fightId)) {
      return jsonError("INVALID_WCL_FIGHT", "请选择有效的 WCL 战斗场次", 400);
    }
    const analysis = await analyzeWclFight(payload.reportCode, Number(payload.fightId));
    if (!Array.isArray(payload.selectedAbilityIds)) return jsonData({ analysis });
    if (!Number.isInteger(payload.baseVersion)) return jsonError("INVALID_VERSION", "缺少有效的基础版本号", 400);

    const selected = new Set(payload.selectedAbilityIds.map(Number));
    const mechanics: RaidMechanic[] = analysis.abilityGroups
      .filter((group) => selected.has(group.spellId))
      .flatMap((group) => group.timestamps.map((atMs, index) => ({
        id: `wcl-mechanic-${group.spellId}-${Math.round(atMs)}-${index}`,
        name: group.name,
        atMs,
        spellId: group.spellId,
        severity: "warning" as const,
        source: "wcl" as const,
        note: "",
      })));
    const current = JSON.parse(auth.row.documentJson) as RaidPlanDocument;
    const cooldownMap = new Map(current.cooldowns.map((cooldown) => [cooldown.id, cooldown]));
    for (const cooldown of analysis.detectedCooldowns) cooldownMap.set(cooldown.id, cooldown);
    const next: RaidPlanDocument = {
      ...current,
      encounter: {
        name: analysis.fight.name,
        difficulty: analysis.fight.difficultyLabel,
        durationMs: Math.max(10_000, analysis.fight.durationMs),
        source: {
          provider: "wcl",
          reportCode: analysis.reportCode,
          fightId: analysis.fight.id,
          reportRevision: analysis.reportRevision,
          importedAt: Date.now(),
        },
      },
      roster: analysis.roster,
      phases: analysis.phases,
      mechanics: mechanics.sort((a, b) => a.atMs - b.atMs),
      cooldowns: Array.from(cooldownMap.values()),
      assignments: payload.includeObservedCooldowns ? analysis.suggestedAssignments.map((item) => ({ ...item, id: makeId("assignment") })) : [],
    };
    assertPlanDocument(next);
    const now = Date.now();
    const [updated] = await getDb().update(plans).set({
      title: next.encounter.name,
      encounterName: next.encounter.name,
      difficulty: next.encounter.difficulty,
      sourceProvider: "wcl",
      sourceRef: `${analysis.reportCode}:${analysis.fight.id}`,
      documentJson: JSON.stringify(next),
      version: Number(payload.baseVersion) + 1,
      updatedAt: now,
    }).where(and(eq(plans.id, id), eq(plans.version, Number(payload.baseVersion)))).returning();
    if (!updated) return jsonError("VERSION_CONFLICT", "导入期间服务器上已有更新，请重新加载后再试", 409);
    return jsonData(toStoredPlan(updated));
  } catch (error) {
    if (error instanceof WclError) return jsonError(error.code, error.message, error.status);
    return jsonError("WCL_IMPORT_FAILED", error instanceof Error ? error.message : "导入 WCL 战报失败", 500);
  }
}
