import { PLAYER_SKILLS } from "../player-skill-library";
import type { PlayerSkillDefinition } from "./schema";
import { resolveSkillForAssignment, skillTimelineDurationMs } from "../skills";
import { compareRosterRoles } from "../cooldowns";
import type { MechanicTimelinePoint, RaidPlanDocument, RosterSlot, TacticalDirective } from "./schema";
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
  backgroundWindow?: boolean;
}

export type TimelineSceneMechanicPart =
  | {
      index: number;
      kind: "interval";
      tone: "context" | "warning" | "active";
      text: string;
      startMs: number;
      endMs: number;
    }
  | {
      index: number;
      kind: "marker";
      tone: "point" | "judgment";
      text: string;
      atMs: number;
    };

export interface TimelineSceneMechanic {
  id: string;
  definitionId: string;
  typeName: string;
  name: string;
  displayLabel?: string;
  description: string;
  atMs: number;
  impactMs: number;
  endMs: number;
  castTimeMs: number;
  durationMs: number;
  color: string;
  presentationParts: TimelineSceneMechanicPart[];
}

export interface TimelineSceneAssignment {
  id: string;
  memberId: string;
  skillDefinitionId: string;
  name: string;
  atMs: number;
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

export function buildTimelineScene(plan: RaidPlanDocument, library: readonly PlayerSkillDefinition[] = PLAYER_SKILLS): TimelineScene {
  const phases = plan.timeline.phases.map((phase) => ({ id: phase.id, name: phase.name, atMs: phase.estimatedStartMs }));
  const directives = plan.timeline.directives.flatMap<TimelineSceneDirective>((directive) => {
    if (directive.scope.kind === "plan") return [{ id: directive.id, kind: directive.kind, text: `全局 · ${directive.text}`, atMs: 0, durationMs: directiveDuration(directive) }];
    const resolved = resolveDirectiveTime(plan, directive);
    return resolved?.ok ? [{ id: directive.id, kind: directive.kind, text: directive.text, atMs: resolved.atMs, durationMs: directiveDuration(directive), ...(directive.kind === "note" && directive.timelinePresentation === "team-buff-window" ? { backgroundWindow: true } : {}) }] : [];
  });
  const mechanics = plan.timeline.mechanics.flatMap<TimelineSceneMechanic>((occurrence) => {
    const definition = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId);
    const start = resolveMechanicPoint(plan, occurrence.id, "cast-start");
    const impact = resolveMechanicPoint(plan, occurrence.id, "impact");
    const end = resolveMechanicPoint(plan, occurrence.id, "end");
    if (!definition || !start.ok || !impact.ok || !end.ok) return [];
    const pointTimes: Record<MechanicTimelinePoint, number> = { "cast-start": start.atMs, impact: impact.atMs, end: end.atMs };
    const presentationParts = definition.timelinePresentation.parts.map<TimelineSceneMechanicPart>((part, index) => {
      const text = index === 0 && occurrence.displayLabel ? `${part.text} ${occurrence.displayLabel}` : part.text;
      return part.kind === "interval"
        ? { index, kind: part.kind, tone: part.tone, text, startMs: pointTimes[part.from], endMs: pointTimes[part.to] }
        : { index, kind: part.kind, tone: part.tone, text, atMs: pointTimes[part.at] };
    });
    return [{
      id: occurrence.id,
      definitionId: occurrence.definitionId,
      typeName: definition.name,
      name: definition.name,
      displayLabel: occurrence.displayLabel,
      description: definition.description,
      atMs: start.atMs,
      impactMs: impact.atMs,
      endMs: end.atMs,
      castTimeMs: occurrence.timing?.castTimeMs ?? definition.castTimeMs ?? 0,
      durationMs: occurrence.timing?.durationMs ?? definition.durationMs ?? 0,
      color: definition.color,
      presentationParts,
    }];
  });
  const assignments = plan.timeline.skillAssignments.flatMap<TimelineSceneAssignment>((assignment) => {
    const resolved = resolveTimelineAnchor(plan, assignment.anchor);
    const skill = resolveSkillForAssignment(assignment, library);
    if (!resolved.ok || !skill) return [];
    const name = skill.name;
    return [{
      id: assignment.id,
      memberId: assignment.memberId,
      skillDefinitionId: assignment.skillDefinitionId,
      name,
      atMs: resolved.atMs,
      durationMs: assignment.observedDurationMs ?? skillTimelineDurationMs(skill),
      color: skill.color,
    }];
  });
  const ends = [
    ...phases.map((item) => item.atMs),
    ...directives.map((item) => item.atMs + item.durationMs),
    ...mechanics.map((item) => item.endMs),
    ...assignments.map((item) => item.atMs + item.durationMs),
  ];
  const contentEnd = Math.max(0, ...ends);
  const rounded = Math.ceil((contentEnd + 30_000) / 30_000) * 30_000;
  const durationMs = Math.min(MAX_TIMELINE_MS, Math.max(120_000, Math.ceil(rounded / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS));
  return { durationMs, phases, directives, mechanics, members: [...plan.roster.members].sort(compareRosterRoles), assignments, diagnostics: validatePlanSemantics(plan, library) };
}
