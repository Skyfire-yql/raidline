import { MAX_TIMELINE_MS, TIMELINE_SNAP_MS, type MemberSelector, type MechanicOccurrence, type RaidPlanDocument, type SkillAssignment, type TacticalDirective, type TimelineAnchor } from "./schema";

export interface PlanDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  objectId?: string;
  path?: string;
}

export type ResolvedTime =
  | { ok: true; atMs: number }
  | { ok: false; error: PlanDiagnostic };

export function snapTimelineTime(ms: number) {
  return Math.min(MAX_TIMELINE_MS, Math.max(0, Math.round(ms / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS));
}

function mechanicPointOffset(plan: RaidPlanDocument, occurrence: MechanicOccurrence, point: "cast-start" | "impact" | "end") {
  const definition = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId);
  if (!definition) return null;
  if (point === "cast-start") return 0;
  const impactOffset = occurrence.timing?.castTimeMs ?? definition.castTimeMs ?? 0;
  const duration = occurrence.timing?.durationMs ?? definition.durationMs ?? 0;
  return point === "impact" ? impactOffset : impactOffset + duration;
}

function resolveAnchorInternal(plan: RaidPlanDocument, anchor: TimelineAnchor, visiting: Set<string>): ResolvedTime {
  if (anchor.kind === "pull") return { ok: true, atMs: anchor.offsetMs };
  if (anchor.kind === "phase") {
    const phase = plan.timeline.phases.find((item) => item.id === anchor.phaseId);
    if (!phase) return { ok: false, error: { code: "MISSING_PHASE", severity: "error", message: "时间锚点引用了不存在的阶段", objectId: anchor.phaseId } };
    const atMs = phase.estimatedStartMs + anchor.offsetMs;
    if (atMs < 0 || atMs > MAX_TIMELINE_MS) return { ok: false, error: { code: "ANCHOR_OUT_OF_RANGE", severity: "error", message: "阶段相对时间超出有效范围", objectId: phase.id } };
    return { ok: true, atMs };
  }
  const id = anchor.mechanicOccurrenceId;
  if (visiting.has(id)) return { ok: false, error: { code: "ANCHOR_CYCLE", severity: "error", message: "机制时间锚点形成了循环引用", objectId: id } };
  const occurrence = plan.timeline.mechanics.find((item) => item.id === id);
  if (!occurrence) return { ok: false, error: { code: "MISSING_MECHANIC", severity: "error", message: "时间锚点引用了不存在的机制实例", objectId: id } };
  const pointOffset = mechanicPointOffset(plan, occurrence, anchor.point);
  if (pointOffset == null) return { ok: false, error: { code: "MISSING_MECHANIC_DEFINITION", severity: "error", message: "机制实例引用的定义不存在", objectId: occurrence.id } };
  const nextVisiting = new Set(visiting).add(id);
  const start = resolveAnchorInternal(plan, occurrence.anchor, nextVisiting);
  if (!start.ok) return start;
  const atMs = start.atMs + pointOffset + anchor.offsetMs;
  if (atMs < 0 || atMs > MAX_TIMELINE_MS) return { ok: false, error: { code: "ANCHOR_OUT_OF_RANGE", severity: "error", message: "机制相对时间超出有效范围", objectId: id } };
  return { ok: true, atMs };
}

export function resolveTimelineAnchor(plan: RaidPlanDocument, anchor: TimelineAnchor): ResolvedTime {
  return resolveAnchorInternal(plan, anchor, new Set());
}

export function resolveMechanicPoint(plan: RaidPlanDocument, occurrenceId: string, point: "cast-start" | "impact" | "end" = "cast-start"): ResolvedTime {
  const occurrence = plan.timeline.mechanics.find((item) => item.id === occurrenceId);
  if (!occurrence) return { ok: false, error: { code: "MISSING_MECHANIC", severity: "error", message: "机制实例不存在", objectId: occurrenceId } };
  const offset = mechanicPointOffset(plan, occurrence, point);
  if (offset == null) return { ok: false, error: { code: "MISSING_MECHANIC_DEFINITION", severity: "error", message: "机制实例引用的定义不存在", objectId: occurrenceId } };
  const start = resolveAnchorInternal(plan, occurrence.anchor, new Set([occurrenceId]));
  return start.ok ? { ok: true, atMs: start.atMs + offset } : start;
}

export function resolveDirectiveTime(plan: RaidPlanDocument, directive: TacticalDirective): ResolvedTime | null {
  const scope = directive.scope;
  if (scope.kind === "plan") return null;
  if (scope.kind === "phase") {
    const phase = plan.timeline.phases.find((item) => item.id === scope.phaseId);
    return phase
      ? { ok: true, atMs: phase.estimatedStartMs }
      : { ok: false, error: { code: "MISSING_PHASE", severity: "error", message: "战术指令引用了不存在的阶段", objectId: directive.id } };
  }
  return resolveTimelineAnchor(plan, scope.anchor);
}

export function moveAnchorTo(plan: RaidPlanDocument, anchor: TimelineAnchor, atMs: number): TimelineAnchor {
  const snapped = snapTimelineTime(atMs);
  if (anchor.kind === "pull") return { kind: "pull", offsetMs: snapped };
  if (anchor.kind === "phase") {
    const phase = plan.timeline.phases.find((item) => item.id === anchor.phaseId);
    return phase ? { ...anchor, offsetMs: Math.round((snapped - phase.estimatedStartMs) / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS } : anchor;
  }
  const base = resolveMechanicPoint(plan, anchor.mechanicOccurrenceId, anchor.point);
  return base.ok ? { ...anchor, offsetMs: Math.round((snapped - base.atMs) / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS } : anchor;
}

export function resolveMemberIds(plan: RaidPlanDocument, selector: MemberSelector) {
  const members = plan.roster.members;
  if (selector.kind === "all") return members.map((item) => item.id);
  if (selector.kind === "groups") return members.filter((item) => item.groupIds.some((id) => selector.groupIds.includes(id))).map((item) => item.id);
  if (selector.kind === "roles") return members.filter((item) => item.role != null && selector.roles.includes(item.role)).map((item) => item.id);
  if (selector.kind === "subgroups") return members.filter((item) => item.subgroup != null && selector.subgroups.includes(item.subgroup)).map((item) => item.id);
  return members.filter((item) => selector.memberIds.includes(item.id)).map((item) => item.id);
}

export function resolveSkillTargets(plan: RaidPlanDocument, assignment: SkillAssignment) {
  if (assignment.targets.kind !== "mechanic-targets") return resolveMemberIds(plan, assignment.targets);
  const anchor = assignment.anchor;
  if (anchor.kind !== "mechanic") return [];
  const occurrence = plan.timeline.mechanics.find((item) => item.id === anchor.mechanicOccurrenceId);
  if (!occurrence) return [];
  const definition = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId);
  return definition ? resolveMemberIds(plan, occurrence.targets ?? definition.defaultTargets) : [];
}

function duplicateIds(plan: RaidPlanDocument) {
  const all = [
    ...plan.sources.map((item) => item.id),
    ...plan.definitions.mechanics.map((item) => item.id),
    ...plan.definitions.skills.map((item) => item.id),
    ...plan.roster.groups.map((item) => item.id),
    ...plan.roster.members.map((item) => item.id),
    ...plan.timeline.phases.map((item) => item.id),
    ...plan.timeline.mechanics.map((item) => item.id),
    ...plan.timeline.directives.map((item) => item.id),
    ...plan.timeline.skillAssignments.map((item) => item.id),
  ];
  const seen = new Set<string>();
  return all.filter((id) => seen.has(id) || !seen.add(id));
}

function selectorReferenceDiagnostics(plan: RaidPlanDocument, selector: MemberSelector, objectId: string): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const groupIds = new Set(plan.roster.groups.map((item) => item.id));
  const memberIds = new Set(plan.roster.members.map((item) => item.id));
  if (selector.kind === "groups") for (const id of selector.groupIds) if (!groupIds.has(id)) diagnostics.push({ code: "MISSING_GROUP", severity: "error", message: "目标选择引用了不存在的策略组", objectId });
  if (selector.kind === "members") for (const id of selector.memberIds) if (!memberIds.has(id)) diagnostics.push({ code: "MISSING_MEMBER", severity: "error", message: "目标选择引用了不存在的成员", objectId });
  return diagnostics;
}

export function validatePlanSemantics(plan: RaidPlanDocument): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  for (const id of duplicateIds(plan)) diagnostics.push({ code: "DUPLICATE_ID", severity: "error", message: "计划内存在重复的实体 ID", objectId: id });

  const sourceIds = new Set(plan.sources.map((item) => item.id));
  const mechanicDefinitionIds = new Set(plan.definitions.mechanics.map((item) => item.id));
  const groupIds = new Set(plan.roster.groups.map((item) => item.id));
  const memberIds = new Set(plan.roster.members.map((item) => item.id));
  const phaseIds = new Set(plan.timeline.phases.map((item) => item.id));
  const mechanicIds = new Set(plan.timeline.mechanics.map((item) => item.id));
  const originObjects = [
    ...plan.definitions.mechanics,
    ...plan.definitions.skills,
    ...plan.roster.members,
    ...plan.timeline.phases,
    ...plan.timeline.mechanics,
    ...plan.timeline.directives,
    ...plan.timeline.skillAssignments,
  ];
  for (const item of originObjects) if (item.origin && !sourceIds.has(item.origin.sourceId)) diagnostics.push({ code: "MISSING_SOURCE", severity: "warning", message: "对象的来源记录已不可用", objectId: item.id });
  if (plan.templateSourceId && !sourceIds.has(plan.templateSourceId)) diagnostics.push({ code: "MISSING_TEMPLATE_SOURCE", severity: "warning", message: "计划使用的预设来源已不可用", objectId: plan.templateSourceId });

  const ordinals = new Set<number>();
  const phases = [...plan.timeline.phases].sort((a, b) => a.ordinal - b.ordinal);
  for (const phase of phases) {
    if (ordinals.has(phase.ordinal)) diagnostics.push({ code: "DUPLICATE_PHASE_ORDINAL", severity: "error", message: "阶段序号必须唯一", objectId: phase.id });
    ordinals.add(phase.ordinal);
  }
  if (phases[0]?.ordinal !== 1 || phases[0]?.estimatedStartMs !== 0) diagnostics.push({ code: "INVALID_FIRST_PHASE", severity: "error", message: "第一个阶段必须为序号 1 且从 00:00 开始", objectId: phases[0]?.id });
  for (let index = 1; index < phases.length; index += 1) if (phases[index].estimatedStartMs < phases[index - 1].estimatedStartMs) diagnostics.push({ code: "PHASE_ORDER", severity: "error", message: "阶段预计时间不能早于前一阶段", objectId: phases[index].id });

  for (const member of plan.roster.members) {
    for (const groupId of member.groupIds) if (!groupIds.has(groupId)) diagnostics.push({ code: "MISSING_GROUP", severity: "error", message: "成员引用了不存在的策略组", objectId: member.id });
  }

  const loadoutKeys = new Set<string>();
  for (const selection of plan.roster.memberSkills) {
    const key = `${selection.memberId}:${selection.skillDefinitionId}`;
    if (loadoutKeys.has(key)) diagnostics.push({ code: "DUPLICATE_MEMBER_SKILL", severity: "error", message: "同一成员和技能只能选择一个变体", objectId: selection.memberId });
    loadoutKeys.add(key);
    const skill = plan.definitions.skills.find((item) => item.id === selection.skillDefinitionId);
    if (!memberIds.has(selection.memberId)) diagnostics.push({ code: "MISSING_MEMBER", severity: "error", message: "成员技能选择引用了不存在的成员", objectId: selection.memberId });
    if (!skill) diagnostics.push({ code: "MISSING_SKILL_DEFINITION", severity: "error", message: "成员技能选择引用了不存在的技能", objectId: selection.skillDefinitionId });
    else if (selection.variantId && !skill.variants.some((item) => item.id === selection.variantId)) diagnostics.push({ code: "MISSING_SKILL_VARIANT", severity: "error", message: "成员技能选择引用了不存在的变体", objectId: selection.skillDefinitionId });
  }

  for (const occurrence of plan.timeline.mechanics) {
    if (!mechanicDefinitionIds.has(occurrence.definitionId)) diagnostics.push({ code: "MISSING_MECHANIC_DEFINITION", severity: "error", message: "机制实例引用了不存在的定义", objectId: occurrence.id });
    if (occurrence.targets) diagnostics.push(...selectorReferenceDiagnostics(plan, occurrence.targets, occurrence.id));
    const resolved = resolveTimelineAnchor(plan, occurrence.anchor);
    if (!resolved.ok) diagnostics.push({ ...resolved.error, objectId: occurrence.id });
  }

  for (const directive of plan.timeline.directives) {
    if (directive.kind === "note" && directive.timelinePresentation && (directive.scope.kind !== "timed" || !directive.durationMs)) diagnostics.push({ code: "INVALID_BACKGROUND_WINDOW", severity: "error", message: "团队增益背景需要精确时间与正持续时长", objectId: directive.id });
    if (!directive.text.trim()) diagnostics.push({ code: "EMPTY_DIRECTIVE", severity: directive.kind === "task" ? "error" : "warning", message: directive.kind === "task" ? "战术任务不能为空" : "说明内容为空", objectId: directive.id });
    if (directive.scope.kind === "phase" && !phaseIds.has(directive.scope.phaseId)) diagnostics.push({ code: "MISSING_PHASE", severity: "error", message: "战术指令引用了不存在的阶段", objectId: directive.id });
    if (directive.scope.kind === "timed") {
      const resolved = resolveTimelineAnchor(plan, directive.scope.anchor);
      if (!resolved.ok) diagnostics.push({ ...resolved.error, objectId: directive.id });
      if (directive.kind === "task" && directive.reminder && resolved.ok && resolved.atMs - directive.reminder.leadMs < 0) diagnostics.push({ code: "REMINDER_BEFORE_PULL", severity: "error", message: "提醒时间不能早于开怪", objectId: directive.id });
    }
    if (directive.kind === "task") {
      diagnostics.push(...selectorReferenceDiagnostics(plan, directive.assignees, directive.id));
      if (resolveMemberIds(plan, directive.assignees).length === 0) diagnostics.push({ code: "EMPTY_ASSIGNEES", severity: "error", message: "战术任务至少需要一名可解析的执行者", objectId: directive.id });
    }
  }

  for (const assignment of plan.timeline.skillAssignments) {
    const member = plan.roster.members.find((item) => item.id === assignment.memberId);
    const skill = plan.definitions.skills.find((item) => item.id === assignment.skillDefinitionId);
    if (!member) diagnostics.push({ code: "MISSING_MEMBER", severity: "error", message: "技能安排引用了不存在的成员", objectId: assignment.id });
    if (!skill) diagnostics.push({ code: "MISSING_SKILL_DEFINITION", severity: "error", message: "技能安排引用了不存在的技能", objectId: assignment.id });
    if (skill && assignment.variantId && !skill.variants.some(variant => variant.id === assignment.variantId)) diagnostics.push({ code: "MISSING_SKILL_VARIANT", severity: "error", message: "技能安排引用了不存在的施放变体", objectId: assignment.id });
    if (assignment.targets.kind === "mechanic-targets") {
      if (assignment.anchor.kind !== "mechanic" || !mechanicIds.has(assignment.anchor.mechanicOccurrenceId)) diagnostics.push({ code: "INVALID_INHERITED_TARGETS", severity: "error", message: "继承机制目标的技能必须锚定到有效机制", objectId: assignment.id });
    } else diagnostics.push(...selectorReferenceDiagnostics(plan, assignment.targets, assignment.id));
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    if (!resolved.ok) diagnostics.push({ ...resolved.error, objectId: assignment.id });
    if (member && skill && (member.classSlug !== skill.classSlug || member.specSlug && skill.specSlugs.length > 0 && !skill.specSlugs.includes(member.specSlug))) diagnostics.push({ code: "SKILL_MEMBER_MISMATCH", severity: "warning", message: `${skill.name} 与 ${member.name} 的职业或专精不匹配`, objectId: assignment.id });
  }
  return diagnostics;
}

export function hasBlockingDiagnostics(diagnostics: PlanDiagnostic[]) {
  return diagnostics.some((item) => item.severity === "error");
}
