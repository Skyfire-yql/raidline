import { z } from "zod";
import {
  type WclActorReference,
  type WclClient,
  type WclEventDataType,
  type WclEventRequest,
  type WclFightEventBundle,
  type WclFightNpcReference,
} from "./wcl-client";
import {
  convertCombatLogSnapshotToDraft,
  createPlanFromImportDraft,
} from "./wcl-conversion";
import {
  acceptSnapshotForConversion,
  preparePublishedWclConversion,
  type WclFightConversionMetadata,
} from "./wcl-contract";
import type { WclImportPreview } from "./wcl-import";
import {
  encounterConversionProfiles,
  playerSkillExtractionProfiles,
} from "./wcl-profile-registry";
import { wclDifficulty, type WclReportLink } from "./wcl-report";
import type {
  CombatLogSnapshot,
  EncounterConversionProfile,
  EventCollectionRule,
  ObservedActor,
  ObservedEvent,
  PlayerSkillExtractionProfile,
} from "./types";

const GAME_VERSION_KEY = "retail-12.1";
const WCL_RETAIL_GAME_VERSION = 1;
const ENCOUNTER_PROFILE_VERSION = 3;
const PLAYER_PROFILE_VERSION = 1;

const RawEventSchema = z.object({
  timestamp: z.number().finite(),
  type: z.string().min(1).max(80),
  abilityGameID: z.number().int().positive().optional(),
  sourceID: z.number().int().optional(),
  targetID: z.number().int().optional(),
  amount: z.number().finite().optional(),
  duration: z.number().finite().optional(),
  stack: z.number().int().optional(),
}).passthrough();

type CollectionDataType = EventCollectionRule["dataType"];
type ActorHostility = "friendly" | "enemy";

interface ActorRecord {
  actor: ObservedActor;
  hostility?: ActorHostility;
}

const providerDataTypes: Record<CollectionDataType, WclEventDataType> = {
  buffs: "Buffs",
  casts: "Casts",
  damage: "DamageDone",
  deaths: "Deaths",
  debuffs: "Debuffs",
  dispels: "Dispels",
  healing: "Healing",
  interrupts: "Interrupts",
};

export class WclGameVersionNotConfiguredError extends Error {
  readonly code = "GAME_VERSION_NOT_CONFIGURED";

  constructor() {
    super("当前 WCL 游戏版本没有可用的转换规则");
    this.name = "WclGameVersionNotConfiguredError";
  }
}

function rawEventDataType(type: string): CollectionDataType | null {
  if (type === "begincast" || type === "cast") return "casts";
  if (["applybuff", "applybuffstack", "refreshbuff", "removebuff", "removebuffstack"].includes(type)) return "buffs";
  if (["applydebuff", "applydebuffstack", "refreshdebuff", "removedebuff", "removedebuffstack"].includes(type)) return "debuffs";
  if (type === "damage") return "damage";
  if (type === "heal") return "healing";
  if (type === "interrupt") return "interrupts";
  if (type === "dispel") return "dispels";
  if (type === "death") return "deaths";
  return null;
}

function normalizedEventType(type: string): ObservedEvent["type"] | null {
  if (type === "begincast") return "cast-start";
  if (type === "cast") return "cast-success";
  if (["applybuff", "applybuffstack", "refreshbuff", "applydebuff", "applydebuffstack", "refreshdebuff"].includes(type)) return "aura-applied";
  if (["removebuff", "removebuffstack", "removedebuff", "removedebuffstack"].includes(type)) return "aura-removed";
  if (type === "damage") return "damage";
  if (type === "heal") return "healing";
  if (type === "interrupt") return "interrupt";
  if (type === "dispel") return "dispel";
  if (type === "death") return "death";
  return null;
}

export function eventRequestsForProfiles(
  encounterProfile: EncounterConversionProfile,
  playerProfile: PlayerSkillExtractionProfile,
) {
  const rules = [...encounterProfile.collectionRules, ...playerProfile.collectionRules].filter((rule) => rule.enabled);
  const requests: WclEventRequest[] = [];
  for (const dataType of Object.keys(providerDataTypes) as CollectionDataType[]) {
    const matching = rules.filter((rule) => rule.dataType === dataType);
    if (!matching.length) continue;
    // WCL event-table hostility is view-dependent (for example, Debuffs is target-facing),
    // while Raidline collection rules describe the source actor. Read both provider views,
    // then apply exact source hostility after actor metadata has been anonymized.
    requests.push(
      { dataType: providerDataTypes[dataType], hostilityType: "Friendlies" },
      { dataType: providerDataTypes[dataType], hostilityType: "Enemies" },
    );
  }
  return requests;
}

function positiveGameId(value: number | null | undefined) {
  return value != null && Number.isInteger(value) && value > 0 ? value : undefined;
}

function inferredActorType(reference: WclActorReference): ObservedActor["type"] {
  if (reference.petOwner) return "pet";
  if (reference.type?.toLowerCase() === "player") return "player";
  if (reference.type) return "npc";
  return "other";
}

function anonymizedActor(reference: WclActorReference, type: ObservedActor["type"]): ObservedActor {
  const gameId = positiveGameId(reference.gameID);
  const actorKey = `${type}:${reference.id}`;
  const name = type === "player"
    ? `玩家 ${reference.id}`
    : type === "pet"
      ? `宠物 ${reference.id}`
      : type === "npc"
        ? `NPC ${gameId ?? reference.id}`
        : `单位 ${reference.id}`;
  return {
    actorKey,
    reportActorId: reference.id,
    ...(gameId ? { gameId } : {}),
    type,
    name,
  };
}

function actorIndex(
  bundle: WclFightEventBundle,
  expectedEnemyNpcGameIds: ReadonlySet<number>,
  expectedEnemyNpcActorIds: ReadonlySet<number>,
) {
  const master = new Map(bundle.masterData.actors.filter((actor) => actor.id > 0).map((actor) => [actor.id, actor]));
  const records = new Map<number, ActorRecord>();
  const ensure = (id: number, type: ObservedActor["type"], hostility?: ActorHostility, npc?: WclFightNpcReference) => {
    const source = master.get(id) ?? {
      id,
      gameID: npc?.gameID ?? null,
      type: null,
      subType: null,
      petOwner: npc?.petOwner ?? null,
    };
    const reference = {
      ...source,
      gameID: npc?.gameID ?? source.gameID,
      petOwner: npc?.petOwner ?? source.petOwner,
    };
    const actor = anonymizedActor(reference, type);
    records.set(id, { actor, hostility });
  };

  for (const id of bundle.fight.friendlyPlayers) ensure(id, "player", "friendly");
  for (const id of bundle.fight.enemyPlayers) ensure(id, "player", "enemy");
  for (const npc of bundle.fight.friendlyNPCs) ensure(npc.id, "other", "friendly", npc);
  for (const npc of bundle.fight.enemyNPCs) ensure(npc.id, "npc", "enemy", npc);
  for (const pet of bundle.fight.friendlyPets) ensure(pet.id, "pet", "friendly", pet);
  for (const pet of bundle.fight.enemyPets) ensure(pet.id, "pet", "enemy", pet);
  for (const reference of bundle.masterData.actors) {
    if (reference.id < 1) continue;
    if (records.has(reference.id)) continue;
    const type = inferredActorType(reference);
    const gameId = positiveGameId(reference.gameID);
    records.set(reference.id, {
      actor: anonymizedActor(reference, type),
      ...(type === "npc" && (
        expectedEnemyNpcActorIds.has(reference.id)
        || Boolean(gameId && expectedEnemyNpcGameIds.has(gameId))
      ) ? { hostility: "enemy" as const } : {}),
    });
  }

  for (const [id, record] of records) {
    const ownerId = master.get(id)?.petOwner;
    const owner = ownerId ? records.get(ownerId)?.actor : undefined;
    if (owner) record.actor.ownerActorKey = owner.actorKey;
  }
  return records;
}

function collectionMatches(
  rawType: string,
  eventType: ObservedEvent["type"],
  abilityGameId: number | undefined,
  source: ActorRecord | undefined,
  rules: EventCollectionRule[],
) {
  const dataType = rawEventDataType(rawType);
  if (!dataType) return false;
  return rules.some((rule) => (
    rule.enabled
    && rule.dataType === dataType
    && (!rule.eventTypes || rule.eventTypes.includes(eventType))
    && (rule.hostility === "any" || source?.hostility === rule.hostility)
    && (!rule.abilityGameIds || abilityGameId != null && rule.abilityGameIds.includes(abilityGameId))
  ));
}

function profileEnemyNpcActorIds(bundle: WclFightEventBundle, rules: EventCollectionRule[]) {
  const master = new Map(bundle.masterData.actors.map((actor) => [actor.id, actor]));
  const enemyRules = rules.filter((rule) => rule.enabled && rule.hostility === "enemy");
  const actorIds = new Set<number>();
  for (const series of bundle.series) {
    for (const value of series.events) {
      const parsed = RawEventSchema.safeParse(value);
      if (!parsed.success) continue;
      const raw = parsed.data;
      if (!raw.sourceID || raw.sourceID < 1) continue;
      const reference = master.get(raw.sourceID);
      if (!reference || inferredActorType(reference) !== "npc") continue;
      const eventType = normalizedEventType(raw.type);
      if (!eventType) continue;
      if (collectionMatches(raw.type, eventType, raw.abilityGameID, { actor: anonymizedActor(reference, "npc"), hostility: "enemy" }, enemyRules)) {
        actorIds.add(raw.sourceID);
      }
    }
  }
  return actorIds;
}

function finiteNonnegative(value: number | undefined) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeEvents(
  bundle: WclFightEventBundle,
  rules: EventCollectionRule[],
  actors: Map<number, ActorRecord>,
) {
  const events: ObservedEvent[] = [];
  const referencedActors = new Set<string>();
  let sequence = 0;
  for (const series of bundle.series) {
    for (const value of series.events) {
      sequence += 1;
      const parsed = RawEventSchema.safeParse(value);
      if (!parsed.success) continue;
      const raw = parsed.data;
      const type = normalizedEventType(raw.type);
      if (!type) continue;
      const source = raw.sourceID && raw.sourceID > 0 ? actors.get(raw.sourceID) : undefined;
      if (!collectionMatches(raw.type, type, raw.abilityGameID, source, rules)) continue;
      const atMs = Math.round(raw.timestamp - bundle.fight.startTime);
      if (atMs < 0 || atMs > bundle.fight.endTime - bundle.fight.startTime) continue;
      const target = raw.targetID && raw.targetID > 0 ? actors.get(raw.targetID) : undefined;
      const amount = finiteNonnegative(raw.amount);
      const duration = finiteNonnegative(raw.duration);
      const event: ObservedEvent = {
        eventKey: `wcl:${bundle.fight.id}:${sequence}`,
        atMs,
        type,
        ...(raw.abilityGameID ? { abilityGameId: raw.abilityGameID } : {}),
        ...(source ? { sourceActorKey: source.actor.actorKey } : {}),
        ...(target ? { targetActorKey: target.actor.actorKey } : {}),
        ...(amount != null ? { amount } : {}),
        ...(duration != null ? { durationMs: Math.round(duration) } : {}),
        ...(raw.stack != null && raw.stack >= 0 ? { stack: raw.stack } : {}),
      };
      events.push(event);
      if (event.sourceActorKey) referencedActors.add(event.sourceActorKey);
      if (event.targetActorKey) referencedActors.add(event.targetActorKey);
    }
  }
  events.sort((left, right) => left.atMs - right.atMs || left.eventKey.localeCompare(right.eventKey));
  return { events, referencedActors };
}

function normalizedPhases(bundle: WclFightEventBundle) {
  const occurrences = new Map<number, number>();
  return [...bundle.fight.phaseTransitions].sort((left, right) => left.startTime - right.startTime).map((phase) => {
    const atMs = Math.round(phase.startTime - bundle.fight.startTime);
    if (atMs < 0 || atMs > bundle.fight.endTime - bundle.fight.startTime) {
      throw new Error("WCL 官方阶段时间超出所选战斗范围");
    }
    const occurrenceIndex = (occurrences.get(phase.id) ?? 0) + 1;
    occurrences.set(phase.id, occurrenceIndex);
    return { id: crypto.randomUUID(), semanticPhaseId: phase.id, occurrenceIndex, atMs };
  });
}

async function snapshotHash(snapshot: Omit<CombatLogSnapshot, "contentHash">) {
  const canonical = JSON.stringify({
    source: snapshot.source,
    encounter: snapshot.encounter,
    actors: snapshot.actors,
    phases: snapshot.phases,
    events: snapshot.events,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizeWclFightBundle(
  bundle: WclFightEventBundle,
  metadata: WclFightConversionMetadata,
  encounterProfile: EncounterConversionProfile,
  playerProfile: PlayerSkillExtractionProfile,
) {
  const collectionRules = [...encounterProfile.collectionRules, ...playerProfile.collectionRules];
  const expectedEnemyNpcGameIds = new Set(encounterProfile.conversionRules
    .filter((rule) => rule.enabled)
    .flatMap((rule) => rule.match.sourceNpcGameIds ?? []));
  const actors = actorIndex(bundle, expectedEnemyNpcGameIds, profileEnemyNpcActorIds(bundle, collectionRules));
  const normalized = normalizeEvents(bundle, collectionRules, actors);
  const retainedActorKeys = new Set(normalized.referencedActors);
  for (const record of actors.values()) {
    if (retainedActorKeys.has(record.actor.actorKey) && record.actor.ownerActorKey) {
      retainedActorKeys.add(record.actor.ownerActorKey);
    }
  }
  const retainedActors = [...actors.values()].map((record) => record.actor)
    .filter((actor) => retainedActorKeys.has(actor.actorKey))
    .sort((left, right) => left.reportActorId - right.reportActorId);
  const withoutHash: Omit<CombatLogSnapshot, "contentHash"> = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    provider: "wcl",
    normalizerVersion: "raidline-wcl-api-v1",
    importedAt: Date.now(),
    source: {
      reportCode: metadata.reportCode,
      fightId: metadata.fightId,
      reportRevision: metadata.reportRevision,
      reportStartEpochMs: metadata.reportStartEpochMs,
      fightStartReportMs: metadata.fightStartReportMs,
      fightEndReportMs: metadata.fightEndReportMs,
      gameVersionKey: metadata.gameVersion,
      logVersion: bundle.masterData.logVersion,
      ...(bundle.masterData.gameVersion != null ? { gameVersion: bundle.masterData.gameVersion } : {}),
      ...(bundle.masterData.lang ? { language: bundle.masterData.lang } : {}),
    },
    encounter: {
      encounterId: metadata.encounterId,
      ...(metadata.zoneId ? { zoneId: metadata.zoneId } : {}),
      name: metadata.encounterName,
      kill: bundle.fight.kill,
      durationMs: metadata.fightEndReportMs - metadata.fightStartReportMs,
    },
    actors: retainedActors,
    phases: normalizedPhases(bundle),
    events: normalized.events,
  };
  return acceptSnapshotForConversion(metadata, { ...withoutHash, contentHash: await snapshotHash(withoutHash) });
}

export async function createWclImportPreview(
  client: WclClient,
  link: WclReportLink,
  fightId: number,
): Promise<WclImportPreview> {
  const probe = await client.probeReport({ ...link, fight: fightId });
  const fight = probe.fights.find((candidate) => candidate.id === fightId);
  if (!fight) throw new Error("所选 WCL 战斗不存在");

  const preparedForRequests = preparePublishedWclConversion({
    schemaVersion: 1,
    reportCode: link.reportCode,
    fightId,
    encounterId: fight.encounterId,
    encounterName: fight.encounterName,
    difficulty: fight.difficulty,
    gameVersion: GAME_VERSION_KEY,
    reportRevision: probe.report.revision,
    reportStartEpochMs: probe.report.startEpochMs,
    fightStartReportMs: fight.startReportMs,
    fightEndReportMs: fight.endReportMs,
    ...(probe.report.zone ? { zoneId: probe.report.zone.id } : {}),
  }, encounterConversionProfiles, ENCOUNTER_PROFILE_VERSION, playerSkillExtractionProfiles, PLAYER_PROFILE_VERSION);

  const requests = eventRequestsForProfiles(preparedForRequests.encounterProfile, preparedForRequests.playerSkillProfile);
  const bundle = await client.readFightEvents(link.reportCode, fightId, requests);
  if (bundle.masterData.gameVersion !== WCL_RETAIL_GAME_VERSION) throw new WclGameVersionNotConfiguredError();
  if (
    bundle.fight.encounterID !== fight.encounterId
    || bundle.fight.startTime !== fight.startReportMs
    || bundle.fight.endTime !== fight.endReportMs
    || bundle.report.revision !== probe.report.revision
  ) throw new Error("WCL 报告在读取事件期间发生变化，请重新读取报告");

  const metadata: WclFightConversionMetadata = {
    schemaVersion: 1,
    reportCode: link.reportCode,
    fightId,
    encounterId: bundle.fight.encounterID,
    encounterName: bundle.fight.name,
    difficulty: wclDifficulty(bundle.fight.difficulty),
    gameVersion: GAME_VERSION_KEY,
    reportRevision: bundle.report.revision,
    reportStartEpochMs: bundle.report.startTime,
    fightStartReportMs: bundle.fight.startTime,
    fightEndReportMs: bundle.fight.endTime,
    ...(bundle.report.zoneId ? { zoneId: bundle.report.zoneId } : {}),
  };
  const prepared = preparePublishedWclConversion(
    metadata,
    encounterConversionProfiles,
    ENCOUNTER_PROFILE_VERSION,
    playerSkillExtractionProfiles,
    PLAYER_PROFILE_VERSION,
  );
  const snapshot = await normalizeWclFightBundle(bundle, metadata, prepared.encounterProfile, prepared.playerSkillProfile);
  const draft = convertCombatLogSnapshotToDraft(snapshot, prepared.encounterProfile);
  const plan = createPlanFromImportDraft(snapshot, draft, {
    title: `${metadata.encounterName} · WCL fight ${fightId}`,
  });

  return {
    reportCode: metadata.reportCode,
    fightId,
    encounterId: metadata.encounterId,
    encounterName: metadata.encounterName,
    difficulty: "mythic",
    durationMs: metadata.fightEndReportMs - metadata.fightStartReportMs,
    gameVersion: metadata.gameVersion,
    encounterProfile: {
      id: prepared.encounterProfile.id,
      profileVersion: prepared.encounterProfile.profileVersion,
    },
    fetchedEventCount: bundle.fetchedEventCount,
    retainedEventCount: snapshot.events.length,
    discardedEventCount: bundle.fetchedEventCount - snapshot.events.length,
    pageCount: bundle.pageCount,
    warningCount: draft.warnings.length,
    unresolvedEventCount: draft.unresolvedEvents.length,
    mechanics: draft.mechanicCandidates.map((candidate) => ({
      candidateId: candidate.id,
      definitionId: candidate.definition.id,
      name: candidate.definition.name,
      startMs: candidate.observed.startMs,
      impactMs: candidate.observed.impactMs,
      endMs: candidate.observed.endMs,
      ...(candidate.observed.displayLabel ? { displayLabel: candidate.observed.displayLabel } : {}),
    })),
    plan,
  };
}
