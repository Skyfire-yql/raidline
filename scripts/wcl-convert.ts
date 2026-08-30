/// <reference types="node" />

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  type CombatLogSnapshot,
  type EventCollectionRule,
  type ObservedActor,
  type ObservedEvent,
} from "../lib/types.ts";
import {
  convertCombatLogSnapshotToDraft,
  createPlanFromImportDraft,
} from "../lib/wcl-conversion.ts";
import type { WclCompatActor, WclCompatFight, WclCompatReport, WclRawEvent } from "../lib/wcl-event-review.ts";
import { acceptSnapshotForConversion, assertMythicFight, preparePublishedWclConversion, WclFightConversionMetadataSchema } from "../lib/wcl-contract.ts";
import { wclDifficulty } from "../lib/wcl-report.ts";

const REPORT_CODE = /^[0-9A-Za-z]{16}$/;
const DEFAULT_INPUT_ROOT = "work/wcl";
const DEFAULT_METADATA = "data/fixtures/vashnik-live-fight-64-metadata-v1.json";
const DEFAULT_ENCOUNTER_PROFILE = "data/fixtures/vashnik-encounter-conversion-profile.json";
const DEFAULT_PLAYER_PROFILE = "data/fixtures/player-skill-extraction-profile-v1.json";

interface StoredPage {
  index: number;
  file: string;
  eventCount: number;
}

interface DownloadState {
  schemaVersion: 1;
  reportCode: string;
  fights: Array<{
    fightId: number;
    startReportMs: number;
    endReportMs: number;
    complete: boolean;
    eventCount: number;
    pages: StoredPage[];
  }>;
}

interface Options {
  metadataPath: string;
  profileVersion: number;
  playerProfileVersion: number;
  inputRoot: string;
  encounterProfilePath: string;
  playerProfilePath: string;
  outputDir?: string;
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write([
    "用法：pnpm wcl:convert -- --metadata <已确认的fight元数据JSON>",
    "",
    "可选参数：",
    `  --metadata <JSON>                 fight 元数据（默认 ${DEFAULT_METADATA}）`,
    "  --profile-version <整数>         Encounter profile 版本（默认 3）",
    "  --player-profile-version <整数>  全局玩家提取 profile 版本（默认 1）",
    `  --input-root <目录>               完整事件缓存根目录（默认 ${DEFAULT_INPUT_ROOT}）`,
    `  --encounter-profile <JSON>        本地数据库记录 fixture（默认 ${DEFAULT_ENCOUNTER_PROFILE}）`,
    `  --player-profile <JSON>           全局玩家规则 fixture（默认 ${DEFAULT_PLAYER_PROFILE}）`,
    "  --output <目录>                   清洗、草稿、计划与摘要输出目录",
  ].join("\n"));
  process.exit(1);
}

function positiveInteger(value: string | undefined, label: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) usage(`${label} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) usage(`${label} 必须是正整数`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) usage(`无法识别参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} 缺少值`);
    values.set(argument, value);
    index += 1;
  }
  const inputRoot = resolve(values.get("--input-root") ?? DEFAULT_INPUT_ROOT);
  return {
    metadataPath: resolve(values.get("--metadata") ?? DEFAULT_METADATA),
    profileVersion: positiveInteger(values.get("--profile-version"), "--profile-version", 3),
    playerProfileVersion: positiveInteger(values.get("--player-profile-version"), "--player-profile-version", 1),
    inputRoot,
    encounterProfilePath: resolve(values.get("--encounter-profile") ?? DEFAULT_ENCOUNTER_PROFILE),
    playerProfilePath: resolve(values.get("--player-profile") ?? DEFAULT_PLAYER_PROFILE),
    ...(values.get("--output") ? { outputDir: resolve(values.get("--output")!) } : {}),
  };
}

async function readGzipJson<T>(path: string) {
  return JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as T;
}

async function atomicWrite(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function writeJson(path: string, value: unknown) {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

type CollectionDataType = EventCollectionRule["dataType"];

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

interface ActorRecord {
  actor: ObservedActor;
  hostility: "friendly" | "enemy";
}

function actorType(actor: WclCompatActor, affiliation: ActorRecord["hostility"], pet: boolean): ObservedActor["type"] {
  if (pet) return "pet";
  if (affiliation === "enemy") return "npc";
  return actor.type?.toLowerCase() === "player" || actor.subType?.toLowerCase() === "player" ? "player" : "other";
}

function actorIndex(report: WclCompatReport) {
  const values = new Map<number, ActorRecord>();
  const add = (actors: WclCompatActor[] | undefined, hostility: ActorRecord["hostility"], pet: boolean) => {
    for (const source of actors ?? []) {
      if (!Number.isInteger(source.id) || source.id < 1 || values.has(source.id)) continue;
      const type = actorType(source, hostility, pet);
      const actorKey = `${type}:${source.id}`;
      values.set(source.id, {
        hostility,
        actor: {
          actorKey,
          reportActorId: source.id,
          ...(source.guid && source.guid > 0 ? { gameId: source.guid } : {}),
          type,
          name: type === "player" ? `玩家 ${source.id}` : type === "pet" ? `宠物 ${source.id}` : `NPC ${source.guid ?? source.id}`,
          ...(source.petOwner && source.petOwner > 0 ? { ownerActorKey: `player:${source.petOwner}` } : {}),
        },
      });
    }
  };
  add(report.friendlies, "friendly", false);
  add(report.friendlyPets, "friendly", true);
  add(report.enemies, "enemy", false);
  add(report.enemyPets, "enemy", true);
  for (const actor of report.masterData?.actors ?? []) {
    if (values.has(actor.id)) continue;
    const hostile = actor.type?.toLowerCase() === "player" ? "friendly" : "enemy";
    add([actor], hostile, Boolean(actor.petOwner));
  }
  return values;
}

function collectionMatches(event: WclRawEvent, source: ActorRecord | undefined, rules: EventCollectionRule[]) {
  const dataType = rawEventDataType(event.type);
  const eventType = normalizedEventType(event.type);
  if (!dataType) return false;
  const abilityGameId = event.ability?.guid;
  return rules.some((rule) => {
    if (!rule.enabled || rule.dataType !== dataType) return false;
    if (rule.eventTypes && (!eventType || !rule.eventTypes.includes(eventType))) return false;
    if (rule.hostility !== "any" && source?.hostility !== rule.hostility) return false;
    return !rule.abilityGameIds || abilityGameId != null && rule.abilityGameIds.includes(abilityGameId);
  });
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeEvent(event: WclRawEvent, sequence: number, fight: WclCompatFight, actors: Map<number, ActorRecord>): ObservedEvent | null {
  const type = normalizedEventType(event.type);
  if (!type) return null;
  const atMs = Math.round(event.timestamp - fight.start_time);
  if (atMs < 0 || atMs > fight.end_time - fight.start_time) return null;
  const source = event.sourceID && event.sourceID > 0 ? actors.get(event.sourceID)?.actor : undefined;
  const target = event.targetID && event.targetID > 0 ? actors.get(event.targetID)?.actor : undefined;
  return {
    eventKey: `wcl:${fight.id}:${sequence}`,
    atMs,
    type,
    ...(event.ability?.guid && event.ability.guid > 0 ? { abilityGameId: event.ability.guid } : {}),
    ...(source ? { sourceActorKey: source.actorKey } : {}),
    ...(target ? { targetActorKey: target.actorKey } : {}),
    ...(finiteNonnegative(event.amount) ? { amount: event.amount } : {}),
    ...(finiteNonnegative(event.duration) ? { durationMs: Math.round(event.duration) } : {}),
    ...(Number.isInteger(event.stack) && event.stack! >= 0 ? { stack: event.stack } : {}),
  };
}

function normalizedPhases(fight: WclCompatFight) {
  const occurrences = new Map<number, number>();
  return (fight.phases ?? []).map((phase) => {
    const occurrenceIndex = (occurrences.get(phase.id) ?? 0) + 1;
    occurrences.set(phase.id, occurrenceIndex);
    const atMs = phase.startTime >= fight.start_time ? phase.startTime - fight.start_time : phase.startTime;
    return { id: randomUUID(), semanticPhaseId: phase.id, occurrenceIndex, atMs: Math.max(0, Math.round(atMs)) };
  });
}

function snapshotHash(snapshot: Omit<CombatLogSnapshot, "contentHash">) {
  return createHash("sha256").update(JSON.stringify({ source: snapshot.source, encounter: snapshot.encounter, actors: snapshot.actors, phases: snapshot.phases, events: snapshot.events })).digest("hex");
}

function countByMechanic(draft: ReturnType<typeof convertCombatLogSnapshotToDraft>) {
  const counts = new Map<string, number>();
  for (const candidate of draft.mechanicCandidates) counts.set(candidate.definition.name, (counts.get(candidate.definition.name) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const metadata = WclFightConversionMetadataSchema.parse(JSON.parse(await readFile(options.metadataPath, "utf8")));
  if (!REPORT_CODE.test(metadata.reportCode)) throw new Error("fight 元数据中的报告 ID 无效");
  assertMythicFight(metadata);
  const encounterRecord = JSON.parse(await readFile(options.encounterProfilePath, "utf8"));
  const playerRecord = JSON.parse(await readFile(options.playerProfilePath, "utf8"));
  const prepared = preparePublishedWclConversion(metadata, [encounterRecord], options.profileVersion, [playerRecord], options.playerProfileVersion);
  const encounterProfile = prepared.encounterProfile;
  const playerProfile = prepared.playerSkillProfile;
  const reportDir = join(options.inputRoot, metadata.reportCode);
  const reportPath = join(reportDir, "report.json.gz");
  const statePath = join(reportDir, "download-state.json");
  if (!existsSync(reportPath) || !existsSync(statePath)) throw new Error("找不到完整事件缓存；请先运行 wcl:download");

  const report = await readGzipJson<WclCompatReport>(reportPath);
  const fight = report.fights.find((candidate) => candidate.id === metadata.fightId);
  if (!fight) throw new Error(`报告中不存在 fight ${metadata.fightId}`);
  const cachedEncounterId = fight.encounterID && fight.encounterID > 0 ? fight.encounterID : null;
  if (cachedEncounterId !== null && cachedEncounterId !== metadata.encounterId) throw new Error("完整事件缓存与正式 fight 元数据的 encounterID 不一致");
  const encounterId = metadata.encounterId;
  const difficulty = wclDifficulty(fight.difficulty ?? null);
  if (difficulty !== metadata.difficulty || fight.start_time !== metadata.fightStartReportMs || fight.end_time !== metadata.fightEndReportMs) throw new Error("完整事件缓存与已确认的 fight 元数据不一致");
  if (playerProfile.extractionRules.some((rule) => rule.enabled)) throw new Error("本次 Vashnik 专项模拟尚未生成玩家技能候选；请使用空的全局玩家 profile");

  const state = JSON.parse(await readFile(statePath, "utf8")) as DownloadState;
  if (state.schemaVersion !== 1 || state.reportCode !== metadata.reportCode) throw new Error("下载状态与报告不一致");
  const fightState = state.fights.find((candidate) => candidate.fightId === metadata.fightId);
  if (!fightState?.complete) throw new Error(`fight ${metadata.fightId} 尚未完整下载`);

  const actors = actorIndex(report);
  const referencedActors = new Set<string>();
  const events: ObservedEvent[] = [];
  const collectionRules = [...encounterProfile.collectionRules, ...playerProfile.collectionRules];
  let rawEventCount = 0;
  for (const page of fightState.pages) {
    const payload = await readGzipJson<{ events?: WclRawEvent[] }>(join(reportDir, page.file));
    if (!Array.isArray(payload.events)) throw new Error(`${page.file} 缺少 events`);
    for (const event of payload.events) {
      rawEventCount += 1;
      const source = event.sourceID && event.sourceID > 0 ? actors.get(event.sourceID) : undefined;
      if (!collectionMatches(event, source, collectionRules)) continue;
      const normalized = normalizeEvent(event, rawEventCount, fight, actors);
      if (!normalized) continue;
      events.push(normalized);
      if (normalized.sourceActorKey) referencedActors.add(normalized.sourceActorKey);
      if (normalized.targetActorKey) referencedActors.add(normalized.targetActorKey);
    }
  }
  if (rawEventCount !== fightState.eventCount) throw new Error(`完整事件计数不一致：状态 ${fightState.eventCount}，实际 ${rawEventCount}`);
  const snapshotWithoutHash: Omit<CombatLogSnapshot, "contentHash"> = {
    schemaVersion: 1,
    id: randomUUID(),
    provider: "wcl",
    normalizerVersion: "raidline-local-wcl-v1",
    importedAt: Date.now(),
    source: {
      reportCode: metadata.reportCode,
      fightId: fight.id,
      reportRevision: metadata.reportRevision,
      reportStartEpochMs: metadata.reportStartEpochMs,
      fightStartReportMs: fight.start_time,
      fightEndReportMs: fight.end_time,
      gameVersionKey: metadata.gameVersion,
      ...(report.logVersion != null ? { logVersion: report.logVersion } : {}),
      ...(report.gameVersion != null ? { gameVersion: report.gameVersion } : {}),
      ...(report.lang ? { language: report.lang } : {}),
    },
    encounter: {
      encounterId,
      ...(metadata.zoneId ? { zoneId: metadata.zoneId } : {}),
      name: fight.name,
      kill: fight.kill === true,
      durationMs: fight.end_time - fight.start_time,
    },
    actors: [...actors.values()].map((record) => record.actor).filter((actor) => referencedActors.has(actor.actorKey)).sort((left, right) => left.reportActorId - right.reportActorId),
    phases: normalizedPhases(fight),
    events,
  };
  const snapshot = acceptSnapshotForConversion(metadata, { ...snapshotWithoutHash, contentHash: snapshotHash(snapshotWithoutHash) });
  const draft = convertCombatLogSnapshotToDraft(snapshot, encounterProfile);
  const plan = createPlanFromImportDraft(snapshot, draft, { title: `${metadata.encounterName} fight ${metadata.fightId} · WCL 示例时间轴` });
  const summary = {
    schemaVersion: 1,
    reportCode: metadata.reportCode,
    fightId: metadata.fightId,
    encounterId,
    difficulty,
    gameVersion: metadata.gameVersion,
    encounterProfile: { id: encounterProfile.id, profileVersion: encounterProfile.profileVersion, status: encounterProfile.status },
    playerSkillProfile: { id: playerProfile.id, profileVersion: playerProfile.profileVersion, status: playerProfile.status, extractedRuleCount: 0 },
    rawEventCount,
    retainedEventCount: snapshot.events.length,
    discardedEventCount: rawEventCount - snapshot.events.length,
    mechanicCandidateCount: draft.mechanicCandidates.length,
    mechanics: countByMechanic(draft),
    unresolvedEventCount: draft.unresolvedEvents.length,
    warningCount: draft.warnings.length,
    planMechanicCount: plan.timeline.mechanics.length,
    snapPolicy: "floor-to-previous-1000ms",
  };

  const outputDir = options.outputDir ?? resolve(join(options.inputRoot, metadata.reportCode, "conversion", `fight-${metadata.fightId}`));
  await Promise.all([
    atomicWrite(join(outputDir, "cleaned-snapshot.json.gz"), gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 })),
    writeJson(join(outputDir, "import-draft.json"), draft),
    writeJson(join(outputDir, "plan.json"), plan),
    writeJson(join(outputDir, "summary.json"), summary),
  ]);
  process.stdout.write([
    `元数据：encounter ${encounterId} · ${difficulty} · fight ${fight.id}`,
    `完整事件：${rawEventCount.toLocaleString()} 条`,
    `清洗保留：${snapshot.events.length.toLocaleString()} 条`,
    `时间轴机制：${draft.mechanicCandidates.length.toLocaleString()} 个`,
    `输出：${outputDir}`,
  ].join("\n") + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
