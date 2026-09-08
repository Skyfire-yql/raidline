import { WOW_CLASS_COLORS, WOW_CLASS_LABELS, WOW_CLASS_SPECS, specializationFor, compareRosterRoles } from "./cooldowns";
import { resolveObservedSkill } from "./skills";
import { parseCombatLogSnapshot, parsePlayerSkillExtractionProfile, type ObservedActor, type PlanImportDraft, type PlayerSkillDefinition, type PlayerSkillExtractionProfile, type RosterSlot } from "./types";

type PlayerCandidates = Pick<PlanImportDraft, "rosterCandidates" | "skillAssignmentCandidates" | "warnings" | "noteCandidates">;

function anonymousSuffix(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : anonymousSuffix(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
}

function floorTime(value: number) { return Math.max(0, Math.floor(value / 1000) * 1000); }

/** Pure conversion: names from an input snapshot are deliberately never consulted. */
export function extractPlayerSkillCandidates(snapshotValue: unknown, profileValue: unknown, definitions: readonly PlayerSkillDefinition[]): PlayerCandidates {
  const snapshot = parseCombatLogSnapshot(snapshotValue);
  const profile = parsePlayerSkillExtractionProfile(profileValue);
  if (profile.status !== "published" || profile.gameVersion !== snapshot.source.gameVersionKey) throw new Error("玩家技能规则与战斗版本不匹配");
  validatePlayerSkillProfileReferences(profile, definitions);
  const actors = new Map(snapshot.actors.map(actor => [actor.actorKey, actor]));
  const counters = new Map<string, number>();
  const warnings: PlayerCandidates["warnings"] = [];
  const rosterCandidates = snapshot.actors.filter(actor => actor.type === "player").sort((a, b) => a.reportActorId - b.reportActorId).map(actor => {
    const classSlug = actor.classSlug && WOW_CLASS_LABELS[actor.classSlug] ? actor.classSlug : null;
    const spec = classSlug && actor.specSlug ? specializationFor(classSlug, actor.specSlug) : undefined;
    const roles = new Set((classSlug ? WOW_CLASS_SPECS[classSlug] : [])?.map(item => item.role));
    const key = classSlug ?? "unknown";
    const count = counters.get(key) ?? 0;
    counters.set(key, count + 1);
    const slot: RosterSlot = { id: crypto.randomUUID(), name: `${classSlug ? WOW_CLASS_LABELS[classSlug] : "成员"}${anonymousSuffix(count)}`, classSlug, specSlug: spec?.slug ?? null, role: spec?.role ?? (roles.size === 1 ? [...roles][0] : null), color: classSlug ? WOW_CLASS_COLORS[classSlug] : "#888888" };
    if (!spec) warnings.push({ code: "PLAYER_SPECIALIZATION_UNKNOWN", objectId: slot.id, message: `${slot.name} 的专精未能可靠识别；仅处理职业通用技能，不猜测专精或天赋。` });
    return { id: slot.id, actorKey: actor.actorKey, slot, sourceEventKeys: [], conversionRuleIds: [] };
  }).sort((a, b) => compareRosterRoles(a.slot, b.slot));
  const roster = new Map(rosterCandidates.map(candidate => [candidate.actorKey, candidate.slot]));
  const events = [...snapshot.events].sort((a, b) => a.atMs - b.atMs || a.eventKey.localeCompare(b.eventKey));
  const owner = (key: string | undefined): ObservedActor | undefined => {
    const source = key ? actors.get(key) : undefined;
    if (source?.type === "player") return source;
    return source?.ownerActorKey ? actors.get(source.ownerActorKey) : undefined;
  };
  const skillAssignmentCandidates: PlayerCandidates["skillAssignmentCandidates"] = [];
  const consumed = new Set<string>();
  const lastConfirmedCast = new Map<string, number>();
  const warningKeys = new Set<string>();
  const warn = (code: string, objectId: string, message: string) => {
    const key = `${code}:${objectId}`;
    if (!warningKeys.has(key)) warnings.push({ code, objectId, message });
    warningKeys.add(key);
  };

  for (const cast of events.filter(event => event.type === "cast-success")) {
    const caster = owner(cast.sourceActorKey);
    const slot = caster ? roster.get(caster.actorKey) : undefined;
    if (!caster || !slot) continue;
    const matches = profile.extractionRules.filter(rule => {
      if (!rule.enabled || rule.verification.status === "pending") return false;
      const source = cast.sourceActorKey ? actors.get(cast.sourceActorKey) : undefined;
      const definition = definitions.find(item => item.id === rule.definitionId)!;
      return source?.type === rule.match.sourceActorType && cast.abilityGameId != null && rule.match.abilityGameIds.includes(cast.abilityGameId)
        && rule.match.eventTypes.includes(cast.type) && definition.classSlug === slot.classSlug
        && (definition.specSlugs.length === 0 || Boolean(slot.specSlug && definition.specSlugs.includes(slot.specSlug)));
    });
    if (matches.length > 1) {
      warn("PLAYER_SKILL_AMBIGUOUS", slot.id, `${slot.name} 的一次施放匹配多条互斥规则，未自动导入。`);
      continue;
    }
    const rule = matches[0];
    if (!rule) continue;
    const definition = definitions.find(item => item.id === rule.definitionId)!;
    const skill = resolveObservedSkill(definition, cast.abilityGameId!);
    const duplicateKey = `${caster.actorKey}:${rule.definitionId}:${cast.atMs}`;
    if (consumed.has(duplicateKey)) continue;
    consumed.add(duplicateKey);
    const previousLife = events.filter(event => event.atMs <= cast.atMs && (event.type === "death" || event.type === "resurrection") && (event.targetActorKey ?? event.sourceActorKey) === caster.actorKey).at(-1);
    if (previousLife?.type === "death") {
      warn("PLAYER_SKILL_AFTER_DEATH", slot.id, `${slot.name} 的 ${skill.name} 出现在死亡后且没有复活证据，未导入。`);
      continue;
    }
    const confirmation = "kind" in rule.confirmation ? undefined : rule.confirmation;
    const evidence = confirmation ? events.filter(event => {
      if (event.atMs < cast.atMs - 100 || event.atMs > cast.atMs + confirmation.windowMs) return false;
      if (!confirmation.eventTypes.some(type => type === event.type) || !event.abilityGameId || !confirmation.abilityGameIds.includes(event.abilityGameId)) return false;
      if (event.type === "absorb" && !(event.amount != null && event.amount > 0)) return false;
      if (owner(event.sourceActorKey)?.actorKey !== caster.actorKey) return false;
      if (confirmation.target === "self") return event.targetActorKey === caster.actorKey;
      if (confirmation.target === "cast-target") return Boolean(cast.targetActorKey && event.targetActorKey === cast.targetActorKey);
      return Boolean(event.targetActorKey && roster.has(event.targetActorKey));
    }) : [];
    if (confirmation && new Set(evidence.map(event => event.targetActorKey)).size < confirmation.minimumTargets) {
      warn("PLAYER_SKILL_EFFECT_UNCONFIRMED", slot.id, `${slot.name} 的 ${skill.name} 有施放记录，但缺少对应生效证据；未生成安排。`);
      continue;
    }
    const familyKey = `${caster.actorKey}:${rule.definitionId}`;
    const previousCastMs = lastConfirmedCast.get(familyKey);
    if (previousCastMs != null && cast.atMs - previousCastMs <= (rule.deduplication?.windowMs ?? 0)) continue;
    const castStart = skill.castType === "cast" || skill.castType === "channel"
      ? events.filter(event => event.type === "cast-start" && event.sourceActorKey === cast.sourceActorKey && event.abilityGameId === cast.abilityGameId && event.atMs <= cast.atMs && event.atMs > (previousCastMs ?? -1) && cast.atMs - event.atMs <= (skill.castTimeMs ?? 0) + 2000).at(-1)
      : undefined;
    if (skill.castType === "cast" && !castStart) {
      warn("PLAYER_SKILL_START_UNCONFIRMED", slot.id, `${slot.name} 的 ${skill.name} 缺少成功施法对应的开始记录，未生成安排。`);
      continue;
    }
    const startMs = castStart?.atMs ?? cast.atMs;
    const nextCast = events.find(event => event.type === "cast-success" && event.atMs > cast.atMs + 200 && owner(event.sourceActorKey)?.actorKey === caster.actorKey && event.abilityGameId != null && rule.match.abilityGameIds.includes(event.abilityGameId));
    // Pair each initial aura with its first removal. Later passive reapplications are
    // separate effects, even when no new active cast was logged.
    const initialAuras = [...new Map(evidence.filter(event => event.type === "aura-applied").reverse().map(event => [`${event.abilityGameId}:${event.targetActorKey}`, event])).values()];
    const endEvents = initialAuras.flatMap(effect => {
      const removal = events.find(event => event.type === "aura-removed" && event.atMs >= effect.atMs && event.atMs < (nextCast?.atMs ?? snapshot.encounter.durationMs + 1)
        && event.abilityGameId === effect.abilityGameId && event.targetActorKey === effect.targetActorKey && owner(event.sourceActorKey)?.actorKey === caster.actorKey);
      return removal ? [removal] : [];
    });
    const effectStartMs = skill.castType === "cast" ? cast.atMs : startMs;
    const actualEnd = endEvents.length ? Math.max(...endEvents.map(event => event.atMs)) : undefined;
    const baseEnd = effectStartMs + (skill.durationMs ?? 0);
    const endMs = Math.min(snapshot.encounter.durationMs, actualEnd ?? baseEnd);
    const targets = skill.scope === "personal" ? [slot.id] : [...new Set(evidence.map(event => event.targetActorKey ? roster.get(event.targetActorKey)?.id : undefined).filter((value): value is string => Boolean(value)))];
    // A self aura can confirm a group cooldown, but cannot identify everyone benefiting from it.
    const targetSelection = skill.scope === "team" && (!confirmation || confirmation.target === "self") ? { kind: "all" as const } : { kind: "members" as const, memberIds: targets };
    const candidateId = crypto.randomUUID();
    lastConfirmedCast.set(familyKey, cast.atMs);
    skillAssignmentCandidates.push({
      id: candidateId,
      sourceEventKeys: [...new Set([cast.eventKey, ...(castStart ? [castStart.eventKey] : []), ...evidence.slice(0, 20).map(event => event.eventKey), ...endEvents.slice(0, 20).map(event => event.eventKey)])],
      conversionRuleIds: [rule.id],
      observed: { startMs, impactMs: effectStartMs, endMs: Math.max(effectStartMs, endMs) },
      assignment: { id: candidateId, memberId: slot.id, skillDefinitionId: definition.id, anchor: { kind: "pull", offsetMs: floorTime(startMs) }, targets: targetSelection, note: "",
        observedDurationMs: Math.max(0, floorTime(endMs) - floorTime(startMs)) },
    });
  }
  const noteCandidates: NonNullable<PlayerCandidates["noteCandidates"]> = [];
  for (const rule of profile.backgroundWindowRules ?? []) {
    if (!rule.enabled || rule.verification.status === "pending") continue;
    const intervals: Array<{ start: number; end: number; target: string; keys: string[] }> = [];
    for (const effect of events.filter(event => event.type === "aura-applied" && event.abilityGameId != null && rule.abilityGameIds.includes(event.abilityGameId) && event.targetActorKey != null && roster.has(event.targetActorKey))) {
      const removal = events.find(event => event.type === "aura-removed" && event.atMs >= effect.atMs && event.atMs <= effect.atMs + rule.maximumDurationMs && event.abilityGameId === effect.abilityGameId && event.sourceActorKey === effect.sourceActorKey && event.targetActorKey === effect.targetActorKey);
      if (!removal) { warn("TEAM_BUFF_END_UNCONFIRMED", rule.id, "嗜血类光环缺少对应结束记录，未猜测背景持续区间。"); continue; }
      if (removal.atMs > effect.atMs) intervals.push({ start: effect.atMs, end: removal.atMs, target: effect.targetActorKey!, keys: [effect.eventKey, removal.eventKey] });
    }
    // Count distinct recipients, not aura records. A lone personal proc or
    // extension must not paint the entire raid timeline as a group buff.
    const edges = new Map<number, Array<{ index: number; active: boolean }>>();
    intervals.forEach((interval, index) => {
      edges.set(interval.start, [...(edges.get(interval.start) ?? []), { index, active: true }]);
      edges.set(interval.end, [...(edges.get(interval.end) ?? []), { index, active: false }]);
    });
    const active = new Set<number>();
    const spans: Array<{ start: number; end: number; keys: string[] }> = [];
    const times = [...edges.keys()].sort((a, b) => a - b);
    for (let index = 0; index < times.length - 1; index++) {
      const start = times[index], end = times[index + 1];
      for (const edge of edges.get(start)!) { if (edge.active) active.add(edge.index); else active.delete(edge.index); }
      const covered = [...active].map(item => intervals[item]);
      if (new Set(covered.map(item => item.target)).size < rule.minimumTargets) continue;
      const keys = covered.flatMap(item => item.keys);
      const prior = spans.at(-1);
      if (prior?.end === start) { prior.end = end; prior.keys = [...new Set([...prior.keys, ...keys])].slice(0, 40); }
      else spans.push({ start, end, keys: [...new Set(keys)].slice(0, 40) });
    }
    for (const span of spans) {
      if (floorTime(span.end) <= floorTime(span.start)) continue;
      const id = crypto.randomUUID();
      noteCandidates.push({ id, sourceEventKeys: [...new Set(span.keys)].slice(0, 40), conversionRuleIds: [rule.id], note: {
        id, kind: "note", text: "嗜血", scope: { kind: "timed", anchor: { kind: "pull", offsetMs: floorTime(span.start) } }, durationMs: floorTime(span.end) - floorTime(span.start), timelinePresentation: "team-buff-window",
      } });
    }
  }
  return { rosterCandidates, skillAssignmentCandidates, noteCandidates, warnings };
}

export function validatePlayerSkillProfileReferences(profile: PlayerSkillExtractionProfile, definitions: readonly PlayerSkillDefinition[]) {
  for (const rule of profile.backgroundWindowRules ?? []) if (rule.enabled && rule.verification.status === "pending") throw new Error("待核验团队背景规则不得启用");
  for (const rule of profile.extractionRules) {
    const definition = definitions.find(item => item.id === rule.definitionId);
    if (!definition || definition.gameVersion !== profile.gameVersion) throw new Error("玩家技能规则引用了不存在或版本不匹配的全局定义");
    if (rule.enabled && rule.verification.status === "pending") throw new Error("待核验玩家技能规则不得启用");
    if (rule.enabled && (rule.timingPoint !== "cast-start" || rule.match.eventTypes.some(type => type !== "cast-success"))) throw new Error("玩家技能必须以成功的主动施放为候选，不能直接导入开始读条或被动光环");
  }
}
