import { PLAYER_SKILLS } from "./player-skill-library";
import { parsePlanDocument, type MemberSelector, type PlayerSkillDefinition, type RaidPlanDocument } from "./types";
import type { ExportDiagnostic, ExportRequest, ExportResult } from "./types";
import { hasBlockingDiagnostics, resolveDirectiveTime, resolveMemberIds, resolveTimelineAnchor, snapTimelineTime, validatePlanSemantics } from "./domain/timeline";
import { resolveSkillForAssignment } from "./skills";

export { MAX_TIMELINE_MS, TIMELINE_SNAP_MS, assertPlanDocument, parsePlanDocument } from "./domain/schema";
export { buildTimelineScene } from "./domain/view-model";
export { hasBlockingDiagnostics, moveAnchorTo, resolveDirectiveTime, resolveMemberIds, resolveMechanicPoint, resolveSkillTargets, resolveTimelineAnchor, validatePlanSemantics } from "./domain/timeline";
export type { PlanDiagnostic } from "./domain/timeline";

export const ALL_TARGETS: MemberSelector = { kind: "all" };

export function makeId() {
  return crypto.randomUUID();
}

export function createBlankPlan(title = "新建团本排轴", initialPhaseId = makeId()): RaidPlanDocument {
  return parsePlanDocument({
    schemaVersion: 1,
    metadata: { title },
    encounter: { id: makeId(), name: "未指定首领", gameVersion: "retail" },
    sources: [],
    definitions: { mechanics: [] },
    roster: { members: [] },
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

export interface ConflictWarning {
  assignmentId: string;
  type: "cooldown";
  message: string;
}

export function detectConflicts(plan: RaidPlanDocument, library: readonly PlayerSkillDefinition[] = PLAYER_SKILLS): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  const timed = plan.timeline.skillAssignments.flatMap((assignment) => {
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    if (!resolved.ok) {
      return [];
    }
    return [{ assignment, atMs: resolved.atMs }];
  }).sort((left, right) => left.atMs - right.atMs);

  const byMemberAndSkill = new Map<string, typeof timed>();
  for (const item of timed) {
    const assignment = item.assignment;
    const key = `${assignment.memberId}:${assignment.skillDefinitionId}`;
    byMemberAndSkill.set(key, [...(byMemberAndSkill.get(key) ?? []), item]);
  }
  for (const assignments of byMemberAndSkill.values()) {
    const first = assignments[0];
    const skill = first && resolveSkillForAssignment(first.assignment, library);
    if (!skill?.cooldownMs || skill.cooldownMs <= 0) continue;
    let charges = skill.maxCharges;
    const rechargeAt: number[] = [];
    for (const item of assignments) {
      while (rechargeAt.length > 0 && rechargeAt[0] <= item.atMs) {
        rechargeAt.shift();
        charges = Math.min(skill.maxCharges, charges + 1);
      }
      if (charges <= 0) warnings.push({ assignmentId: item.assignment.id, type: "cooldown", message: `${skill.name} 冷却未恢复（按最短 ${skill.cooldownMs / 1000} 秒、${skill.maxCharges} 层充能计算）` });
      else {
        charges -= 1;
        const start = rechargeAt.at(-1) ?? item.atMs;
        rechargeAt.push(start + skill.cooldownMs);
      }
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
  const semantic = validatePlanSemantics(plan, request.skillLibrary);
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
    const skill = resolveSkillForAssignment(assignment, request.skillLibrary);
    if (!resolved.ok || !member || !skill) {
      omittedObjectIds.push(assignment.id);
      continue;
    }
    const note = assignment.note.trim();
    const suffix = note ? `  # ${note}` : "";
    timedRows.push({ atMs: resolved.atMs, id: assignment.id, text: `${member.name} — ${skill.name}${suffix}` });
  }
  for (const row of timedRows.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))) lines.push(`{time:${formatTime(row.atMs)}} ${row.text}`);
  return { target: request.target, text: lines.join("\n"), diagnostics, omittedObjectIds };
}


export function deleteRosterMember(plan: RaidPlanDocument, memberId: string) {
  plan.roster.members = plan.roster.members.filter(item => item.id !== memberId);
  plan.timeline.skillAssignments = plan.timeline.skillAssignments.filter(item => item.memberId !== memberId);
  const removeTarget = (selector: MemberSelector) => {
    if (selector.kind === "members") selector.memberIds = selector.memberIds.filter(id => id !== memberId);
  };
  for (const item of plan.timeline.skillAssignments) removeTarget(item.targets);
  for (const item of plan.timeline.directives) if (item.kind === "task") removeTarget(item.assignees);
}
