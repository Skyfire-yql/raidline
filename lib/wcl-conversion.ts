import { defaultSkillTargets } from "./skills";
import {
  MAX_TIMELINE_MS,
  TIMELINE_SNAP_MS,
  parseCombatLogSnapshot,
  parseConversionProfile,
  parsePlanDocument,
  parsePlanImportDraft,
  parsePlayerSkillExtractionProfile,
  type EncounterConversionProfile,
  type EventConversionRule,
  type ObservedActor,
  type ObservedEvent,
  type PlanImportDraft,
  type RaidPlanDocument,
} from "./types";

export interface EncounterProfileSelector {
  encounterId: number;
  gameVersion: string;
  profileVersion: number;
}

export interface PlayerSkillProfileSelector {
  gameVersion: string;
  profileVersion: number;
}

export class EncounterProfileNotConfiguredError extends Error {
  readonly code = "ENCOUNTER_NOT_CONFIGURED";

  constructor(readonly selector: EncounterProfileSelector) {
    super("尚未配置该遭遇的已发布转换规则");
    this.name = "EncounterProfileNotConfiguredError";
  }
}

export class PlayerSkillProfileNotConfiguredError extends Error {
  readonly code = "PLAYER_SKILL_PROFILE_NOT_CONFIGURED";

  constructor(readonly selector: PlayerSkillProfileSelector) {
    super("尚未配置该游戏版本的已发布玩家技能提取规则");
    this.name = "PlayerSkillProfileNotConfiguredError";
  }
}

export function selectPublishedEncounterProfile(values: unknown[], selector: EncounterProfileSelector) {
  const matches = values.map(parseConversionProfile).filter((profile) => (
    profile.status === "published"
    && profile.encounterId === selector.encounterId
    && profile.gameVersion === selector.gameVersion
    && profile.profileVersion === selector.profileVersion
  ));
  if (matches.length !== 1) throw new EncounterProfileNotConfiguredError(selector);
  return matches[0];
}

export function selectPublishedPlayerSkillProfile(values: unknown[], selector: PlayerSkillProfileSelector) {
  const matches = values.map(parsePlayerSkillExtractionProfile).filter((profile) => (
    profile.status === "published"
    && profile.gameVersion === selector.gameVersion
    && profile.profileVersion === selector.profileVersion
  ));
  if (matches.length !== 1) throw new PlayerSkillProfileNotConfiguredError(selector);
  return matches[0];
}

interface ConversionPoint {
  atMs: number;
  sourceEventKeys: string[];
  conversionRuleIds: string[];
  displayLabel?: string;
}

interface DefinitionPoints {
  "cast-start": ConversionPoint[];
  impact: ConversionPoint[];
  end: ConversionPoint[];
}

function actorFor(event: ObservedEvent, actors: Map<string, ObservedActor>) {
  return event.sourceActorKey ? actors.get(event.sourceActorKey) : undefined;
}

function matchesRule(event: ObservedEvent, rule: EventConversionRule, actors: Map<string, ObservedActor>) {
  if (!rule.match.eventTypes.includes(event.type)) return false;
  if (event.abilityGameId == null || !rule.match.abilityGameIds.includes(event.abilityGameId)) return false;
  const actor = actorFor(event, actors);
  if (rule.match.sourceActorType && actor?.type !== rule.match.sourceActorType) return false;
  if (rule.match.sourceNpcGameIds && (!actor?.gameId || !rule.match.sourceNpcGameIds.includes(actor.gameId))) return false;
  return true;
}

function groupKey(event: ObservedEvent, groupBy: NonNullable<EventConversionRule["deduplication"]>["groupBy"]) {
  return groupBy.map((part) => {
    if (part === "source") return `source:${event.sourceActorKey ?? "none"}`;
    if (part === "target") return `target:${event.targetActorKey ?? "none"}`;
    return `ability:${event.abilityGameId ?? "none"}`;
  }).join("|");
}

function displayLabel(rule: EventConversionRule, events: ObservedEvent[]) {
  if (rule.convertTo.kind !== "mechanic" || rule.convertTo.display?.kind !== "stack") return undefined;
  const value = events.find((event) => event.stack != null)?.stack ?? rule.convertTo.display.missingValue;
  return value == null ? undefined : `${rule.convertTo.display.prefix}${value}`;
}

function conversionPoints(events: ObservedEvent[], rule: EventConversionRule): ConversionPoint[] {
  const sorted = [...events].sort((left, right) => left.atMs - right.atMs || left.eventKey.localeCompare(right.eventKey));
  if (!rule.deduplication) return sorted.map((event) => ({
    atMs: event.atMs,
    sourceEventKeys: [event.eventKey],
    conversionRuleIds: [rule.id],
    ...(displayLabel(rule, [event]) ? { displayLabel: displayLabel(rule, [event]) } : {}),
  }));

  const groups = new Map<string, ObservedEvent[][]>();
  for (const event of sorted) {
    const key = groupKey(event, rule.deduplication.groupBy);
    const waves = groups.get(key) ?? [];
    const wave = waves.at(-1);
    if (!wave || event.atMs - wave.at(-1)!.atMs > rule.deduplication.windowMs) waves.push([event]);
    else wave.push(event);
    groups.set(key, waves);
  }
  return [...groups.values()].flat().map((wave) => ({
    atMs: wave[0].atMs,
    sourceEventKeys: wave.map((event) => event.eventKey),
    conversionRuleIds: [rule.id],
    ...(displayLabel(rule, wave) ? { displayLabel: displayLabel(rule, wave) } : {}),
  })).sort((left, right) => left.atMs - right.atMs || left.sourceEventKeys[0].localeCompare(right.sourceEventKeys[0]));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function pointWithinOccurrence(points: ConversionPoint[], minimum: number, maximum: number) {
  return points.filter((point) => point.atMs >= minimum && point.atMs < maximum);
}

function inferredDuration(value: number | null) {
  return value ?? 0;
}

function observedEventMatchesDataType(event: ObservedEvent, dataType: EncounterConversionProfile["collectionRules"][number]["dataType"]) {
  if (dataType === "casts") return event.type === "cast-start" || event.type === "cast-success";
  if (dataType === "buffs" || dataType === "debuffs") return event.type === "aura-applied" || event.type === "aura-removed";
  if (dataType === "damage") return event.type === "damage";
  if (dataType === "healing") return event.type === "healing" || event.type === "absorb";
  if (dataType === "interrupts") return event.type === "interrupt";
  if (dataType === "dispels") return event.type === "dispel";
  return dataType === "deaths" && (event.type === "death" || event.type === "resurrection");
}

function intendedForTimeline(event: ObservedEvent, profile: EncounterConversionProfile) {
  return profile.collectionRules.some((rule) => (
    rule.enabled
    && rule.uses.includes("timeline")
    && observedEventMatchesDataType(event, rule.dataType)
    && (!rule.eventTypes || rule.eventTypes.includes(event.type))
    && (!rule.abilityGameIds || event.abilityGameId != null && rule.abilityGameIds.includes(event.abilityGameId))
  ));
}

export function convertCombatLogSnapshotToDraft(snapshotValue: unknown, profileValue: unknown): PlanImportDraft {
  const snapshot = parseCombatLogSnapshot(snapshotValue);
  const profile = parseConversionProfile(profileValue);
  if (profile.status !== "published") throw new EncounterProfileNotConfiguredError({ encounterId: profile.encounterId, gameVersion: profile.gameVersion, profileVersion: profile.profileVersion });
  if (snapshot.encounter.encounterId !== profile.encounterId || snapshot.source.gameVersionKey !== profile.gameVersion) {
    throw new EncounterProfileNotConfiguredError({ encounterId: snapshot.encounter.encounterId, gameVersion: snapshot.source.gameVersionKey, profileVersion: profile.profileVersion });
  }

  const actors = new Map(snapshot.actors.map((actor) => [actor.actorKey, actor]));
  const pointsByDefinition = new Map<string, DefinitionPoints>();
  const matchedEventKeys = new Set<string>();
  const enabledRules = profile.conversionRules.filter((rule) => rule.enabled);

  for (const rule of enabledRules) {
    const matched = snapshot.events.filter((event) => matchesRule(event, rule, actors));
    for (const event of matched) matchedEventKeys.add(event.eventKey);
    if (rule.convertTo.kind !== "mechanic") continue;
    const points = pointsByDefinition.get(rule.convertTo.definitionId) ?? { "cast-start": [], impact: [], end: [] };
    points[rule.convertTo.timingPoint].push(...conversionPoints(matched, rule));
    pointsByDefinition.set(rule.convertTo.definitionId, points);
  }

  const warnings: PlanImportDraft["warnings"] = [];
  const mechanicCandidates: PlanImportDraft["mechanicCandidates"] = [];
  const definitions = new Map(profile.mechanicDefinitions.map((definition) => [definition.id, definition]));

  for (const [definitionId, points] of pointsByDefinition) {
    const definition = definitions.get(definitionId)!;
    points["cast-start"].sort((left, right) => left.atMs - right.atMs);
    points.impact.sort((left, right) => left.atMs - right.atMs);
    points.end.sort((left, right) => left.atMs - right.atMs);
    for (let index = 0; index < points["cast-start"].length; index += 1) {
      const start = points["cast-start"][index];
      const nextStartMs = points["cast-start"][index + 1]?.atMs ?? Number.POSITIVE_INFINITY;
      const impactMatches = pointWithinOccurrence(points.impact, start.atMs, nextStartMs);
      const impact = impactMatches[0];
      const impactMs = impact?.atMs ?? start.atMs + inferredDuration(definition.castTimeMs);
      const endMatches = pointWithinOccurrence(points.end, impactMs, nextStartMs);
      const end = endMatches[0];
      const endMs = end?.atMs ?? impactMs + inferredDuration(definition.durationMs);
      if (impactMatches.length > 1) warnings.push({ code: "AMBIGUOUS_IMPACT", message: `${definition.name} 在同一轮匹配到多个判定点`, objectId: definition.id });
      if (endMatches.length > 1) warnings.push({ code: "AMBIGUOUS_END", message: `${definition.name} 在同一轮匹配到多个结束点`, objectId: definition.id });
      const sourceEventKeys = unique([start, impact, end].flatMap((point) => point?.sourceEventKeys ?? []));
      const conversionRuleIds = unique([start, impact, end].flatMap((point) => point?.conversionRuleIds ?? []));
      const label = start.displayLabel ?? impact?.displayLabel ?? end?.displayLabel;
      mechanicCandidates.push({
        id: crypto.randomUUID(),
        sourceEventKeys,
        conversionRuleIds,
        definition: structuredClone(definition),
        observed: {
          startMs: start.atMs,
          impactMs,
          endMs,
          ...(label ? { displayLabel: label } : {}),
        },
      });
    }
    if (!points["cast-start"].length && (points.impact.length || points.end.length)) {
      warnings.push({ code: "MISSING_MECHANIC_START", message: `${definition.name} 缺少可配对的开始事件`, objectId: definition.id });
    }
  }

  mechanicCandidates.sort((left, right) => left.observed.startMs - right.observed.startMs || left.definition.name.localeCompare(right.definition.name));
  const unresolvedEvents = snapshot.events.filter((event) => (
    intendedForTimeline(event, profile)
    && !matchedEventKeys.has(event.eventKey)
  )).map((event) => ({ eventKey: event.eventKey, reason: "事件被标记为时间轴用途，但没有匹配已发布转换规则" }));

  return parsePlanImportDraft({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    snapshotId: snapshot.id,
    conversionProfileId: profile.id,
    conversionProfileVersion: profile.profileVersion,
    rosterCandidates: [],
    phaseCandidates: [],
    mechanicCandidates,
    skillAssignmentCandidates: [],
    unresolvedEvents,
    warnings,
  });
}

function floorPlanTime(atMs: number) {
  return Math.min(MAX_TIMELINE_MS, Math.max(0, Math.floor(atMs / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS));
}

export interface CreatePlanFromImportDraftOptions {
  title?: string;
  importedAt?: number;
  candidateIds?: string[];
}

export function createPlanFromImportDraft(snapshotValue: unknown, draftValue: unknown, options: CreatePlanFromImportDraftOptions = {}): RaidPlanDocument {
  const snapshot = parseCombatLogSnapshot(snapshotValue);
  const draft = parsePlanImportDraft(draftValue);
  if (draft.snapshotId !== snapshot.id) throw new Error("导入草稿与战斗快照不一致");
  const selectedIds = options.candidateIds ? new Set(options.candidateIds) : null;
  const candidates = draft.mechanicCandidates.filter((candidate) => !selectedIds || selectedIds.has(candidate.id));
  const sourceId = crypto.randomUUID();
  const importedAt = options.importedAt ?? Date.now();
  const mechanicDefinitions = [...new Map(candidates.map((candidate) => [candidate.definition.id, candidate.definition])).values()].map((definition) => ({
    ...structuredClone(definition),
    origin: { sourceId },
  }));
  const mechanicOccurrences = candidates.map((candidate) => {
    const startMs = floorPlanTime(candidate.observed.startMs);
    const impactMs = Math.max(startMs, floorPlanTime(candidate.observed.impactMs));
    const endMs = Math.max(impactMs, floorPlanTime(candidate.observed.endMs));
    return {
      id: candidate.id,
      definitionId: candidate.definition.id,
      anchor: { kind: "pull" as const, offsetMs: startMs },
      timing: { castTimeMs: impactMs - startMs, durationMs: endMs - impactMs },
      ...(candidate.observed.displayLabel ? { displayLabel: candidate.observed.displayLabel } : {}),
      ...(candidate.targets ? { targets: structuredClone(candidate.targets) } : {}),
      ...(candidate.runtimeTrigger ? { runtimeTrigger: structuredClone(candidate.runtimeTrigger) } : {}),
      origin: {
        sourceId,
        sourceEventKeys: candidate.sourceEventKeys,
        conversionRuleIds: candidate.conversionRuleIds,
      },
    };
  });
  const phases = snapshot.phases.length ? snapshot.phases.map((phase, index) => ({
    id: phase.id, name: `P${phase.semanticPhaseId}${phase.occurrenceIndex > 1 ? ` · ${phase.occurrenceIndex}` : ""}`, ordinal: index + 1,
    estimatedStartMs: floorPlanTime(phase.atMs), origin: { sourceId },
  })) : [{ id: crypto.randomUUID(), name: "P1", ordinal: 1, estimatedStartMs: 0, origin: { sourceId } }];
  if (phases[0].estimatedStartMs > 0) phases.unshift({ id: crypto.randomUUID(), name: "P1", ordinal: 0, estimatedStartMs: 0, origin: { sourceId } });
  phases.forEach((phase, index) => { phase.ordinal = index + 1; });
  const assignments = draft.skillAssignmentCandidates.map(candidate => {
    const assignment = structuredClone(candidate.assignment);
    // Recipient evidence confirms a cast; a new plan uses the current all/self targeting workflow.
    assignment.targets = defaultSkillTargets(candidate.definition, assignment.memberId);
    if (assignment.anchor.kind !== "pull") throw new Error("WCL 技能候选必须提供开怪后观测时间，不能猜测外部锚点");
    const atMs = assignment.anchor.offsetMs;
    const phase = phases.filter(item => item.estimatedStartMs <= atMs).at(-1)!;
    if (phase.ordinal > 1) assignment.anchor = { kind: "phase", phaseId: phase.id, offsetMs: atMs - phase.estimatedStartMs };
    assignment.origin = { sourceId, sourceEventKeys: candidate.sourceEventKeys, conversionRuleIds: candidate.conversionRuleIds };
    return assignment;
  });
  const skillDefinitions = [...new Map(draft.skillAssignmentCandidates.map(candidate => [candidate.definition.id, candidate.definition])).values()].map(definition => ({ ...structuredClone(definition), origin: { sourceId } }));
  const memberSkills = [...new Map(assignments.map(assignment => [`${assignment.memberId}:${assignment.skillDefinitionId}`, { memberId: assignment.memberId, skillDefinitionId: assignment.skillDefinitionId, variantId: null }])).values()];
  return parsePlanDocument({
    schemaVersion: 1,
    metadata: { title: options.title ?? `${snapshot.encounter.name} · fight ${snapshot.source.fightId}` },
    encounter: {
      id: crypto.randomUUID(),
      name: snapshot.encounter.name,
      gameVersion: snapshot.source.gameVersionKey,
      externalIds: {
        wclEncounterId: snapshot.encounter.encounterId,
        ...(snapshot.encounter.zoneId ? { wclZoneId: snapshot.encounter.zoneId } : {}),
        ...(snapshot.encounter.journalId ? { blizzardJournalId: snapshot.encounter.journalId } : {}),
      },
    },
    sources: [{
      id: sourceId,
      kind: "combat-log",
      provider: "wcl",
      snapshotId: snapshot.id,
      reportCode: snapshot.source.reportCode,
      fightId: snapshot.source.fightId,
      importedAt,
      normalizedDataHash: snapshot.contentHash,
      conversionProfiles: [{ kind: "encounter", id: draft.conversionProfileId, profileVersion: draft.conversionProfileVersion }, ...(draft.playerSkillProfile ? [{ kind: "player-skill", ...draft.playerSkillProfile }] : [])],
    }],
    definitions: { mechanics: mechanicDefinitions, skills: skillDefinitions },
    roster: { groups: [], members: draft.rosterCandidates.map(candidate => structuredClone(candidate.slot)), memberSkills },
    timeline: {
      phases,
      mechanics: mechanicOccurrences,
      directives: (draft.noteCandidates ?? []).map(candidate => ({ ...structuredClone(candidate.note), origin: { sourceId, sourceEventKeys: candidate.sourceEventKeys, conversionRuleIds: candidate.conversionRuleIds } })),
      skillAssignments: assignments,
    },
  });
}
