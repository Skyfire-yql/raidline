import { DEFAULT_COOLDOWNS } from "./cooldowns.ts";
import type { RaidAssignment, RaidPlanDocument } from "./types.ts";

export const PLAN_LIMITS = {
  roster: 40,
  phases: 40,
  mechanics: 1500,
  cooldowns: 250,
  assignments: 3000,
  bytes: 1_000_000,
} as const;

export function makeId(prefix = "id") {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${random}`;
}

export function createBlankPlan(title = "新建团本排轴"): RaidPlanDocument {
  return {
    schemaVersion: 1,
    encounter: {
      name: title,
      difficulty: "史诗",
      durationMs: 480_000,
    },
    roster: [],
    phases: [{ id: makeId("phase"), name: "P1", atMs: 0 }],
    mechanics: [],
    cooldowns: DEFAULT_COOLDOWNS.map((item) => ({ ...item })),
    assignments: [],
    settings: {
      snapMs: 1000,
      zoom: 1,
      showMinorMechanics: true,
    },
  };
}

export function formatTime(ms: number) {
  const safe = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function parseTime(value: string) {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) return Number(normalized) * 1000;
  const match = normalized.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

export function snapTime(ms: number, snapMs: number) {
  const snap = Math.max(100, snapMs || 1000);
  return Math.max(0, Math.round(ms / snap) * snap);
}

export interface ConflictWarning {
  assignmentId: string;
  type: "cooldown" | "overlap" | "bounds" | "missing";
  message: string;
}

export function detectConflicts(plan: RaidPlanDocument): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  const cooldowns = new Map(plan.cooldowns.map((item) => [item.id, item]));
  const members = new Map(plan.roster.map((item) => [item.id, item]));
  const ordered = [...plan.assignments].sort((a, b) => a.atMs - b.atMs);

  for (const assignment of ordered) {
    const member = members.get(assignment.memberId);
    const cooldown = cooldowns.get(assignment.cooldownId);
    if (!member || !cooldown) {
      warnings.push({ assignmentId: assignment.id, type: "missing", message: "分配引用了已删除的成员或技能" });
      continue;
    }
    if (assignment.atMs < 0 || assignment.atMs > plan.encounter.durationMs) {
      warnings.push({ assignmentId: assignment.id, type: "bounds", message: `${member.name} 的 ${cooldown.name} 超出战斗时间` });
    }
  }

  const byMemberAndSpell = new Map<string, RaidAssignment[]>();
  const byMember = new Map<string, RaidAssignment[]>();
  for (const assignment of ordered) {
    const spellKey = `${assignment.memberId}:${assignment.cooldownId}`;
    byMemberAndSpell.set(spellKey, [...(byMemberAndSpell.get(spellKey) ?? []), assignment]);
    byMember.set(assignment.memberId, [...(byMember.get(assignment.memberId) ?? []), assignment]);
  }

  for (const assignments of byMemberAndSpell.values()) {
    for (let index = 1; index < assignments.length; index += 1) {
      const current = assignments[index];
      const previous = assignments[index - 1];
      const cooldown = cooldowns.get(current.cooldownId);
      if (cooldown && current.atMs - previous.atMs < cooldown.cooldownMs) {
        warnings.push({ assignmentId: current.id, type: "cooldown", message: `${cooldown.name} 尚未冷却完成` });
      }
    }
  }

  for (const assignments of byMember.values()) {
    for (let index = 1; index < assignments.length; index += 1) {
      const current = assignments[index];
      const previous = assignments[index - 1];
      if (current.atMs - previous.atMs < 1500 && current.cooldownId !== previous.cooldownId) {
        const member = members.get(current.memberId);
        warnings.push({ assignmentId: current.id, type: "overlap", message: `${member?.name ?? "成员"} 在 1.5 秒内有多项任务` });
      }
    }
  }

  return warnings;
}

export function exportMrtNote(plan: RaidPlanDocument) {
  const members = new Map(plan.roster.map((item) => [item.id, item]));
  const cooldowns = new Map(plan.cooldowns.map((item) => [item.id, item]));
  const mechanics = new Map(plan.mechanics.map((item) => [item.id, item]));
  const lines = [
    `{time:00:00} ${plan.encounter.name} · ${plan.encounter.difficulty}`,
    "",
  ];

  for (const assignment of [...plan.assignments].sort((a, b) => a.atMs - b.atMs)) {
    const member = members.get(assignment.memberId);
    const cooldown = cooldowns.get(assignment.cooldownId);
    if (!member || !cooldown) continue;
    const mechanic = assignment.mechanicId ? mechanics.get(assignment.mechanicId) : undefined;
    const suffix = [mechanic?.name, assignment.note].filter(Boolean).join(" · ");
    lines.push(`{time:${formatTime(assignment.atMs)}} ${member.name} — ${cooldown.name}${suffix ? `  # ${suffix}` : ""}`);
  }

  return lines.join("\n");
}

export function assertPlanDocument(value: unknown): asserts value is RaidPlanDocument {
  if (!value || typeof value !== "object") throw new Error("计划内容不是有效对象");
  const plan = value as Partial<RaidPlanDocument>;
  if (plan.schemaVersion !== 1) throw new Error("不支持的计划版本");
  if (!plan.encounter || typeof plan.encounter.name !== "string" || !Number.isFinite(plan.encounter.durationMs)) {
    throw new Error("战斗信息不完整");
  }
  const arrays: Array<[keyof RaidPlanDocument, number]> = [
    ["roster", PLAN_LIMITS.roster],
    ["phases", PLAN_LIMITS.phases],
    ["mechanics", PLAN_LIMITS.mechanics],
    ["cooldowns", PLAN_LIMITS.cooldowns],
    ["assignments", PLAN_LIMITS.assignments],
  ];
  for (const [key, limit] of arrays) {
    if (!Array.isArray(plan[key])) throw new Error(`计划缺少 ${key}`);
    if ((plan[key] as unknown[]).length > limit) throw new Error(`${key} 超出数量限制`);
  }
  if (plan.encounter.durationMs < 10_000 || plan.encounter.durationMs > 7_200_000) {
    throw new Error("战斗时长需在 10 秒到 120 分钟之间");
  }
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > PLAN_LIMITS.bytes) {
    throw new Error("计划内容超过 1 MB 限制");
  }
}
