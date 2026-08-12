import { parsePlanDocument, type MemberSelector, type MechanicDefinitionSnapshot, type MechanicOccurrence, type PlayerSkillDefinitionSnapshot, type RaidPlanDocument, type SkillTargetSelector } from "./types";
import type { ExportDiagnostic, ExportRequest, ExportResult } from "./types";
import { hasBlockingDiagnostics, resolveDirectiveTime, resolveMemberIds, resolveMechanicPoint, resolveSkillTargets, resolveTimelineAnchor, snapTimelineTime, validatePlanSemantics } from "./domain/timeline";
import { resolveSkillForMember, skillBusyEndMs, skillEffectStartMs } from "./skills";

export { MAX_TIMELINE_MS, TIMELINE_SNAP_MS, assertPlanDocument, parsePlanDocument } from "./domain/schema";
export { buildTimelineScene } from "./domain/view-model";
export { hasBlockingDiagnostics, moveAnchorTo, resolveDirectiveTime, resolveMemberIds, resolveMechanicPoint, resolveSkillTargets, resolveTimelineAnchor, validatePlanSemantics } from "./domain/timeline";
export type { PlanDiagnostic } from "./domain/timeline";

export const ALL_TARGETS: MemberSelector = { kind: "all" };
export const INHERIT_TARGETS: SkillTargetSelector = { kind: "mechanic-targets" };

export function makeId() {
  return crypto.randomUUID();
}

export function createBlankPlan(title = "新建团本排轴", initialPhaseId = makeId()): RaidPlanDocument {
  return parsePlanDocument({
    schemaVersion: 1,
    metadata: { title },
    encounter: { id: makeId(), name: "未指定首领", gameVersion: "retail" },
    sources: [],
    definitions: { mechanics: [], skills: [] },
    roster: { groups: [], members: [], memberSkills: [] },
    timeline: {
      phases: [{ id: initialPhaseId, name: "P1", ordinal: 1, estimatedStartMs: 0 }],
      mechanics: [],
      directives: [],
      skillAssignments: [],
    },
  });
}

export function formatTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function parseTime(value: string) {
  const match = value.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) return null;
  return snapTimelineTime((Number(match[1]) * 60 + Number(match[2])) * 1000);
}

export function snapTime(ms: number) {
  return snapTimelineTime(ms);
}

function mechanicDefinition(plan: RaidPlanDocument, occurrenceOrId: MechanicOccurrence | string) {
  const occurrence = typeof occurrenceOrId === "string" ? plan.timeline.mechanics.find((item) => item.id === occurrenceOrId) : occurrenceOrId;
  return occurrence ? plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId) : undefined;
}

function isDefensiveCooldown(skill: PlayerSkillDefinitionSnapshot) {
  return skill.effects.some((effect) => effect.type === "damageReduction" || effect.type === "absorb" || effect.type === "immunity" || effect.type === "maxHealth");
}

export function defaultAssignmentAnchor(plan: RaidPlanDocument, skill: PlayerSkillDefinitionSnapshot, mechanic: MechanicOccurrence) {
  const impact = resolveMechanicPoint(plan, mechanic.id, "impact");
  const definition = mechanicDefinition(plan, mechanic);
  const periodic = definition?.damage.periodicAmount != null;
  const lead = isDefensiveCooldown(skill) && !periodic ? 3000 : 0;
  const desired = Math.max(0, (impact.ok ? impact.atMs : 0) - lead - (skill.castType === "cast" ? skill.castTimeMs ?? 0 : 0));
  const base = resolveMechanicPoint(plan, mechanic.id, "impact");
  return base.ok
    ? { kind: "mechanic" as const, mechanicOccurrenceId: mechanic.id, point: "impact" as const, offsetMs: Math.round((desired - base.atMs) / 1000) * 1000 }
    : { kind: "pull" as const, offsetMs: snapTime(desired) };
}

export interface ConflictWarning {
  assignmentId: string;
  type: "ownership" | "target" | "coverage" | "cooldown" | "cast" | "gcd" | "anchor";
  message: string;
}

export function detectConflicts(plan: RaidPlanDocument): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  const timed = plan.timeline.skillAssignments.flatMap((assignment) => {
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    if (!resolved.ok) {
      warnings.push({ assignmentId: assignment.id, type: "anchor", message: resolved.error.message });
      return [];
    }
    return [{ assignment, atMs: resolved.atMs }];
  }).sort((left, right) => left.atMs - right.atMs);

  for (const { assignment, atMs } of timed) {
    const member = plan.roster.members.find((item) => item.id === assignment.memberId);
    const skill = resolveSkillForMember(plan, assignment.memberId, assignment.skillDefinitionId);
    if (!member || !skill) continue;
    if (member.classSlug !== skill.classSlug || member.specSlug && skill.specSlugs.length > 0 && !skill.specSlugs.includes(member.specSlug)) warnings.push({ assignmentId: assignment.id, type: "ownership", message: `${member.name} 的职业或专精无法使用 ${skill.name}` });
    const targetIds = skill.scope === "personal" ? [member.id] : resolveSkillTargets(plan, assignment);
    if (skill.maxTargets != null && targetIds.length > skill.maxTargets) warnings.push({ assignmentId: assignment.id, type: "target", message: `${skill.name} 目标数 ${targetIds.length} 超过上限 ${skill.maxTargets}` });
    if (assignment.anchor.kind === "mechanic" && isDefensiveCooldown(skill)) {
      const impact = resolveMechanicPoint(plan, assignment.anchor.mechanicOccurrenceId, "impact");
      const end = resolveMechanicPoint(plan, assignment.anchor.mechanicOccurrenceId, "end");
      if (impact.ok && end.ok && skill.durationMs != null) {
        const effectStart = skillEffectStartMs(atMs, skill);
        if (effectStart > impact.atMs || effectStart + skill.durationMs < end.atMs) warnings.push({ assignmentId: assignment.id, type: "coverage", message: `${skill.name} 未完整覆盖关联机制` });
      }
    }
  }

  const byMemberAndSkill = new Map<string, typeof timed>();
  const byMember = new Map<string, typeof timed>();
  for (const item of timed) {
    const assignment = item.assignment;
    const key = `${assignment.memberId}:${assignment.skillDefinitionId}`;
    byMemberAndSkill.set(key, [...(byMemberAndSkill.get(key) ?? []), item]);
    byMember.set(assignment.memberId, [...(byMember.get(assignment.memberId) ?? []), item]);
  }
  for (const assignments of byMemberAndSkill.values()) {
    const first = assignments[0];
    const skill = first && resolveSkillForMember(plan, first.assignment.memberId, first.assignment.skillDefinitionId);
    if (!skill?.cooldownMs || skill.cooldownMs <= 0) continue;
    let charges = skill.maxCharges;
    const rechargeAt: number[] = [];
    for (const item of assignments) {
      while (rechargeAt.length > 0 && rechargeAt[0] <= item.atMs) {
        rechargeAt.shift();
        charges = Math.min(skill.maxCharges, charges + 1);
      }
      if (charges <= 0) warnings.push({ assignmentId: item.assignment.id, type: "cooldown", message: `${skill.name} 的充能尚未恢复` });
      else {
        charges -= 1;
        const start = rechargeAt.at(-1) ?? item.atMs;
        rechargeAt.push(start + skill.cooldownMs);
      }
    }
  }
  for (const assignments of byMember.values()) {
    for (let index = 1; index < assignments.length; index += 1) {
      const previous = assignments[index - 1];
      const current = assignments[index];
      const previousSkill = resolveSkillForMember(plan, previous.assignment.memberId, previous.assignment.skillDefinitionId);
      const currentSkill = resolveSkillForMember(plan, current.assignment.memberId, current.assignment.skillDefinitionId);
      if (!previousSkill || !currentSkill) continue;
      if (current.atMs < skillBusyEndMs(previous.atMs, previousSkill)) warnings.push({ assignmentId: current.assignment.id, type: "cast", message: "同一成员的施法或引导区间重叠" });
      if (previousSkill.triggersGcd && currentSkill.triggersGcd && current.atMs - previous.atMs < 1500) warnings.push({ assignmentId: current.assignment.id, type: "gcd", message: "两项占用 GCD 的技能相隔不足 1.5 秒" });
    }
  }
  return warnings;
}

function selectorLabel(plan: RaidPlanDocument, selector: MemberSelector) {
  const names = resolveMemberIds(plan, selector).map((id) => plan.roster.members.find((item) => item.id === id)?.name).filter(Boolean);
  return names.join("、") || "未分配";
}

export function exportPlan(request: ExportRequest): ExportResult {
  const plan = parsePlanDocument(request.document);
  const semantic = validatePlanSemantics(plan);
  const diagnostics: ExportDiagnostic[] = semantic.map((item) => ({ code: item.code, severity: item.severity, message: item.message, ...(item.objectId ? { objectId: item.objectId } : {}) }));
  const omittedObjectIds: string[] = [];
  if (hasBlockingDiagnostics(semantic)) return { target: request.target, text: "", diagnostics, omittedObjectIds: semantic.filter((item) => item.severity === "error" && item.objectId).map((item) => item.objectId!) };

  const lines = [`{time:00:00} ${plan.metadata.title} · ${plan.encounter.name}`];
  for (const note of plan.timeline.directives.filter((item) => item.kind === "note" && item.scope.kind === "plan")) lines.push(`# ${note.text}`);
  const sectionDirectives = plan.timeline.directives.filter((item) => item.scope.kind === "phase");
  for (const phase of [...plan.timeline.phases].sort((a, b) => a.ordinal - b.ordinal)) {
    const items = sectionDirectives.filter((item) => item.scope.kind === "phase" && item.scope.phaseId === phase.id);
    lines.push("", `# ${phase.name}（预计 ${formatTime(phase.estimatedStartMs)}）`);
    for (const item of items) {
      if (item.kind === "task") {
        lines.push(`${selectorLabel(plan, item.assignees)} — ${item.text}`);
        diagnostics.push({ code: "PHASE_TASK_AS_SECTION", severity: "warning", message: `${phase.name} 的阶段任务已导出为阶段说明`, objectId: item.id });
      } else lines.push(item.text);
    }
  }

  const timedRows: Array<{ atMs: number; id: string; text: string }> = [];
  for (const directive of plan.timeline.directives) {
    if (directive.scope.kind !== "timed") continue;
    const resolved = resolveDirectiveTime(plan, directive);
    if (!resolved?.ok) {
      omittedObjectIds.push(directive.id);
      continue;
    }
    timedRows.push({ atMs: resolved.atMs, id: directive.id, text: directive.kind === "task" ? `${selectorLabel(plan, directive.assignees)} — ${directive.text}` : directive.text });
  }
  for (const assignment of plan.timeline.skillAssignments) {
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    const member = plan.roster.members.find((item) => item.id === assignment.memberId);
    const skill = resolveSkillForMember(plan, assignment.memberId, assignment.skillDefinitionId);
    if (!resolved.ok || !member || !skill) {
      omittedObjectIds.push(assignment.id);
      continue;
    }
    const suffix = assignment.note.trim() ? `  # ${assignment.note.trim()}` : "";
    timedRows.push({ atMs: resolved.atMs, id: assignment.id, text: `${member.name} — ${skill.name}${suffix}` });
  }
  for (const row of timedRows.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))) lines.push(`{time:${formatTime(row.atMs)}} ${row.text}`);
  return { target: request.target, text: lines.join("\n"), diagnostics, omittedObjectIds };
}

export function createMechanicDefinition(name = "新机制"): MechanicDefinitionSnapshot {
  return {
    id: makeId(),
    name,
    description: "",
    gameVersion: "retail",
    abilityGameIds: [],
    castTimeMs: 0,
    durationMs: 0,
    timelinePresentation: { parts: [{ kind: "marker", at: "cast-start", tone: "judgment", text: name }] },
    damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false },
    defaultTargets: { kind: "all" },
    severity: "warning",
    color: "#cf3e3e",
    dataStatus: "custom",
    limitations: [],
  };
}
