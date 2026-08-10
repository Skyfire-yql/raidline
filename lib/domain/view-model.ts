import { resolveSkillForMember, skillEffectStartMs } from "../skills";
import type { RaidPlanDocument, RosterSlot, TacticalDirective } from "./schema";
import { MAX_TIMELINE_MS, TIMELINE_SNAP_MS } from "./schema";
import { resolveDirectiveTime, resolveMechanicPoint, resolveTimelineAnchor, validatePlanSemantics, type PlanDiagnostic } from "./timeline";

export interface TimelineScenePhase {
  id: string;
  name: string;
  atMs: number;
}

export interface TimelineSceneDirective {
  id: string;
  kind: "task" | "note";
  text: string;
  atMs: number;
  durationMs: number;
}

export interface TimelineSceneMechanic {
  id: string;
  definitionId: string;
  name: string;
  description: string;
  atMs: number;
  impactMs: number;
  endMs: number;
  castTimeMs: number;
  durationMs: number;
  color: string;
}

export interface TimelineSceneAssignment {
  id: string;
  memberId: string;
  skillDefinitionId: string;
  name: string;
  atMs: number;
  castType: "unknown" | "instant" | "cast" | "channel";
  castTimeMs: number;
  effectStartMs: number;
  durationMs: number;
  color: string;
}

export interface TimelineScene {
  durationMs: number;
  phases: TimelineScenePhase[];
  directives: TimelineSceneDirective[];
  mechanics: TimelineSceneMechanic[];
  members: RosterSlot[];
  assignments: TimelineSceneAssignment[];
  diagnostics: PlanDiagnostic[];
}

function directiveDuration(directive: TacticalDirective) {
  return directive.durationMs ?? 0;
}

export function buildTimelineScene(plan: RaidPlanDocument): TimelineScene {
  const phases = plan.timeline.phases.map((phase) => ({ id: phase.id, name: phase.name, atMs: phase.estimatedStartMs }));
  const directives = plan.timeline.directives.flatMap<TimelineSceneDirective>((directive) => {
    if (directive.scope.kind === "plan") return [{ id: directive.id, kind: directive.kind, text: `全局 · ${directive.text}`, atMs: 0, durationMs: directiveDuration(directive) }];
    const resolved = resolveDirectiveTime(plan, directive);
    return resolved?.ok ? [{ id: directive.id, kind: directive.kind, text: directive.text, atMs: resolved.atMs, durationMs: directiveDuration(directive) }] : [];
  });
  const mechanics = plan.timeline.mechanics.flatMap<TimelineSceneMechanic>((occurrence) => {
    const definition = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId);
    const start = resolveMechanicPoint(plan, occurrence.id, "cast-start");
    const impact = resolveMechanicPoint(plan, occurrence.id, "impact");
    const end = resolveMechanicPoint(plan, occurrence.id, "end");
    if (!definition || !start.ok || !impact.ok || !end.ok) return [];
    return [{
      id: occurrence.id,
      definitionId: occurrence.definitionId,
      name: definition.name,
      description: definition.description,
      atMs: start.atMs,
      impactMs: impact.atMs,
      endMs: end.atMs,
      castTimeMs: definition.castTimeMs ?? 0,
      durationMs: definition.durationMs ?? 0,
      color: definition.color,
    }];
  });
  const assignments = plan.timeline.skillAssignments.flatMap<TimelineSceneAssignment>((assignment) => {
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    const skill = resolveSkillForMember(plan, assignment.memberId, assignment.skillDefinitionId);
    if (!resolved.ok || !skill) return [];
    const name = skill.selectedVariant ? `${skill.name} · ${skill.selectedVariant.name}` : skill.name;
    return [{
      id: assignment.id,
      memberId: assignment.memberId,
      skillDefinitionId: assignment.skillDefinitionId,
      name,
      atMs: resolved.atMs,
      castType: skill.castType,
      castTimeMs: skill.castTimeMs ?? 0,
      effectStartMs: skillEffectStartMs(resolved.atMs, skill),
      durationMs: skill.durationMs ?? 0,
      color: skill.color,
    }];
  });
  const ends = [
    ...phases.map((item) => item.atMs),
    ...directives.map((item) => item.atMs + item.durationMs),
    ...mechanics.map((item) => item.endMs),
    ...assignments.map((item) => Math.max(item.atMs + item.castTimeMs, item.effectStartMs + item.durationMs)),
  ];
  const contentEnd = Math.max(0, ...ends);
  const rounded = Math.ceil((contentEnd + 30_000) / 30_000) * 30_000;
  const durationMs = Math.min(MAX_TIMELINE_MS, Math.max(120_000, Math.ceil(rounded / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS));
  return { durationMs, phases, directives, mechanics, members: plan.roster.members, assignments, diagnostics: validatePlanSemantics(plan) };
}
