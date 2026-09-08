import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlanFromImportDraft,
  EncounterProfileNotConfiguredError,
  convertCombatLogSnapshotToDraft,
  selectPublishedEncounterProfile,
  selectPublishedPlayerSkillProfile,
} from "../lib/wcl-conversion.ts";
import { preparePublishedWclConversion, UnsupportedDifficultyError } from "../lib/wcl-contract.ts";
import {
  parseConversionProfile,
  parsePlayerSkillExtractionProfile,
  type CombatLogSnapshot,
  type EncounterConversionProfile,
  type MechanicDefinitionSnapshot,
  type PlayerSkillExtractionProfile,
} from "../lib/types.ts";

const uuid = () => crypto.randomUUID();

function mechanic(id: string, name: string, abilityGameIds: number[], castTimeMs: number, durationMs: number): MechanicDefinitionSnapshot {
  return {
    id,
    name,
    description: `${name} 测试定义`,
    gameVersion: "retail-12.1",
    abilityGameIds,
    castTimeMs,
    durationMs,
    timelinePresentation: { parts: durationMs > 0
      ? [{ kind: "interval", from: "cast-start", to: "end", tone: "active", text: name }, { kind: "marker", at: "end", tone: "judgment", text: `${name} 判定` }]
      : castTimeMs > 0
        ? [{ kind: "interval", from: "cast-start", to: "impact", tone: "warning", text: name }, { kind: "marker", at: "impact", tone: "judgment", text: `${name} 判定` }]
        : [{ kind: "marker", at: "cast-start", tone: "judgment", text: name }] },
    color: "#cf3e3e",
    dataStatus: "verified",
    limitations: [],
  };
}

function snapshot(): CombatLogSnapshot {
  return {
    schemaVersion: 1,
    id: uuid(),
    provider: "wcl",
    normalizerVersion: "test-v1",
    importedAt: 1_800_000_000_000,
    source: {
      reportCode: "LgdFn8NyAGRqWT3V",
      fightId: 64,
      reportRevision: 45,
      reportStartEpochMs: 1_787_653_286_382,
      fightStartReportMs: 18_932_777,
      fightEndReportMs: 19_378_225,
      gameVersionKey: "retail-12.1",
      logVersion: 17,
      gameVersion: 1,
      language: "en",
    },
    encounter: { encounterId: 3_455, zoneId: 53, name: "万毒邪祟者瓦什尼克", kill: true, durationMs: 445_448 },
    actors: [
      { actorKey: "npc:173", reportActorId: 173, gameId: 259_181, type: "npc", name: "NPC 259181" },
      { actorKey: "player:1", reportActorId: 1, type: "player", name: "玩家 1" },
      { actorKey: "player:2", reportActorId: 2, type: "player", name: "玩家 2" },
    ],
    phases: [],
    events: [
      { eventKey: "fang:start", atMs: 8_020, type: "cast-start", abilityGameId: 1_280_935, sourceActorKey: "npc:173" },
      { eventKey: "fang:impact", atMs: 9_999, type: "damage", abilityGameId: 1_280_935, sourceActorKey: "npc:173", targetActorKey: "player:1", amount: 100 },
      { eventKey: "froth:start:1", atMs: 13_042, type: "aura-applied", abilityGameId: 1_281_913, sourceActorKey: "npc:173", targetActorKey: "player:1" },
      { eventKey: "froth:start:2", atMs: 13_046, type: "aura-applied", abilityGameId: 1_281_913, sourceActorKey: "npc:173", targetActorKey: "player:2" },
      { eventKey: "froth:end:1", atMs: 21_028, type: "aura-removed", abilityGameId: 1_281_913, sourceActorKey: "npc:173", targetActorKey: "player:1" },
      { eventKey: "froth:end:2", atMs: 21_032, type: "aura-removed", abilityGameId: 1_281_913, sourceActorKey: "npc:173", targetActorKey: "player:2" },
      { eventKey: "vapor:1", atMs: 65, type: "aura-applied", abilityGameId: 1_284_563, sourceActorKey: "npc:173", targetActorKey: "npc:173" },
      { eventKey: "vapor:2", atMs: 23_991, type: "aura-applied", abilityGameId: 1_284_563, sourceActorKey: "npc:173", targetActorKey: "npc:173", stack: 2 },
      { eventKey: "validation:tick", atMs: 24_500, type: "damage", abilityGameId: 1_284_561, sourceActorKey: "npc:173", targetActorKey: "player:1", amount: 20 },
    ],
    contentHash: "test-cleaned-hash",
  };
}

function encounterProfile(): EncounterConversionProfile {
  const fangId = uuid();
  const frothId = uuid();
  const vaporId = uuid();
  const verification = { reviewedAt: 1_788_019_200_000, sourceReportCodes: ["LgdFn8NyAGRqWT3V"] };
  return parseConversionProfile({
    schemaVersion: 1,
    id: uuid(),
    encounterId: 3_455,
    gameVersion: "retail-12.1",
    profileVersion: 3,
    status: "published",
    mechanicDefinitions: [
      mechanic(fangId, "Dripping Fangs", [1_280_935], 2_000, 0),
      { ...mechanic(frothId, "Plague Froth", [1_281_913], 0, 6_000), timelinePresentation: { parts: [{ kind: "interval", from: "cast-start", to: "end", tone: "active", text: "Plague Froth" }, { kind: "marker", at: "end", tone: "judgment", text: "Plague Wave" }] } },
      mechanic(vaporId, "Toxic Vapor", [1_284_563], 0, 0),
    ],
    collectionRules: [
      { id: uuid(), enabled: true, dataType: "casts", hostility: "enemy", abilityGameIds: [1_280_935], uses: ["timeline"], purpose: "Fangs 读条" },
      { id: uuid(), enabled: true, dataType: "damage", hostility: "enemy", abilityGameIds: [1_280_935], uses: ["timeline"], purpose: "Fangs 判定" },
      { id: uuid(), enabled: true, dataType: "debuffs", eventTypes: ["aura-applied"], hostility: "enemy", abilityGameIds: [1_281_913, 1_284_563], uses: ["timeline", "relationship"], purpose: "Froth 与 Vapor" },
      { id: uuid(), enabled: true, dataType: "debuffs", eventTypes: ["aura-removed"], hostility: "enemy", abilityGameIds: [1_281_913], uses: ["validation"], purpose: "Froth 移除只作校验" },
      { id: uuid(), enabled: true, dataType: "damage", hostility: "enemy", abilityGameIds: [1_284_561], uses: ["validation"], purpose: "只保留验证 Tick" },
    ],
    conversionRules: [
      { id: uuid(), enabled: true, match: { eventTypes: ["cast-start"], abilityGameIds: [1_280_935], sourceNpcGameIds: [259_181], sourceActorType: "npc" }, convertTo: { kind: "mechanic", definitionId: fangId, timingPoint: "cast-start" }, notes: "读条开始", verification },
      { id: uuid(), enabled: true, match: { eventTypes: ["damage"], abilityGameIds: [1_280_935], sourceNpcGameIds: [259_181], sourceActorType: "npc" }, convertTo: { kind: "mechanic", definitionId: fangId, timingPoint: "impact" }, notes: "伤害判定", verification },
      { id: uuid(), enabled: true, match: { eventTypes: ["aura-applied"], abilityGameIds: [1_281_913], sourceNpcGameIds: [259_181], sourceActorType: "npc" }, convertTo: { kind: "mechanic", definitionId: frothId, timingPoint: "cast-start" }, deduplication: { windowMs: 100, groupBy: ["ability"] }, notes: "同轮多目标聚类", verification },
      { id: uuid(), enabled: true, match: { eventTypes: ["aura-applied"], abilityGameIds: [1_284_563], sourceNpcGameIds: [259_181], sourceActorType: "npc" }, convertTo: { kind: "mechanic", definitionId: vaporId, timingPoint: "cast-start", display: { kind: "stack", prefix: "×", missingValue: 1 } }, notes: "只显示层数变化", verification },
    ],
    notes: "匿名正式服转换行为 fixture",
  });
}

test("published profiles are selected by exact encounter, game version and profile version", () => {
  const profile = encounterProfile();
  assert.deepEqual(selectPublishedEncounterProfile([profile], { encounterId: 3_455, gameVersion: "retail-12.1", profileVersion: 3 }), profile);
  assert.throws(
    () => selectPublishedEncounterProfile([profile], { encounterId: 3_456, gameVersion: "retail-12.1", profileVersion: 3 }),
    (error) => error instanceof EncounterProfileNotConfiguredError && error.code === "ENCOUNTER_NOT_CONFIGURED",
  );
  assert.throws(() => selectPublishedEncounterProfile([{ ...profile, status: "draft" }], { encounterId: 3_455, gameVersion: "retail-12.1", profileVersion: 3 }), EncounterProfileNotConfiguredError);
});

test("global player extraction profiles stay independent from encounter rules", () => {
  const profile: PlayerSkillExtractionProfile = parsePlayerSkillExtractionProfile({
    schemaVersion: 1,
    id: uuid(),
    gameVersion: "retail-12.1",
    profileVersion: 3,
    status: "published",
    collectionRules: [{ id: uuid(), enabled: true, dataType: "casts", hostility: "friendly", abilityGameIds: [62_618], uses: ["timeline"], purpose: "全局玩家减伤提取" }],
    extractionRules: [{ id: uuid(), enabled: true, definitionId: uuid(), match: { eventTypes: ["cast-success"], abilityGameIds: [62_618], sourceActorType: "player" }, timingPoint: "cast-start", confirmation: { eventTypes: ["aura-applied"], abilityGameIds: [81782], windowMs: 2000, target: "friendly", minimumTargets: 1 }, notes: "全局技能目录引用", verification: { reviewedAt: 1_800_000_000_000, sourceReportCodes: [], status: "fixture-verified", evidence: ["synthetic fixture"] } }],
    notes: "不包含 encounterId",
  });
  assert.deepEqual(selectPublishedPlayerSkillProfile([profile], { gameVersion: "retail-12.1", profileVersion: 3 }), profile);
  assert.equal("encounterId" in profile, false);
  assert.doesNotMatch(JSON.stringify(encounterProfile()), /player-skill|extractionRules/);
});

test("formal WCL preparation checks metadata and mythic difficulty before exact published profiles", () => {
  const encounter = encounterProfile();
  const player = parsePlayerSkillExtractionProfile({
    schemaVersion: 1,
    id: uuid(),
    gameVersion: "retail-12.1",
    profileVersion: 1,
    status: "published",
    collectionRules: [],
    extractionRules: [],
    notes: "空的全局玩家 profile fixture",
  });
  const metadata = {
    schemaVersion: 1 as const,
    reportCode: "LgdFn8NyAGRqWT3V",
    fightId: 64,
    encounterId: 3455,
    encounterName: "万毒邪祟者瓦什尼克",
    difficulty: "mythic" as const,
    gameVersion: "retail-12.1",
    reportRevision: 45,
    reportStartEpochMs: 1_787_653_286_382,
    fightStartReportMs: 18_932_777,
    fightEndReportMs: 19_378_225,
  };
  const prepared = preparePublishedWclConversion(metadata, [encounter], 3, [player], 1);
  assert.equal(prepared.encounterProfile.id, encounter.id);
  assert.equal(prepared.playerSkillProfile.id, player.id);
  assert.throws(
    () => preparePublishedWclConversion({ ...metadata, difficulty: "heroic" }, [encounter], 3, [player], 1),
    (error) => error instanceof UnsupportedDifficultyError,
  );
  assert.throws(
    () => preparePublishedWclConversion({ ...metadata, encounterId: 3456 }, [encounter], 3, [player], 1),
    EncounterProfileNotConfiguredError,
  );
});

test("conversion derives the six-second Froth interval, preserves milliseconds and ignores validation-only events", () => {
  const profile = encounterProfile();
  const draft = convertCombatLogSnapshotToDraft(snapshot(), profile);
  assert.equal(draft.mechanicCandidates.length, 4);
  assert.equal(draft.unresolvedEvents.length, 0);

  const fang = draft.mechanicCandidates.find((item) => item.definition.name === "Dripping Fangs")!;
  assert.deepEqual(fang.observed, { startMs: 8_020, impactMs: 9_999, endMs: 9_999 });
  assert.deepEqual(fang.sourceEventKeys, ["fang:start", "fang:impact"]);

  const froth = draft.mechanicCandidates.find((item) => item.definition.name === "Plague Froth")!;
  assert.deepEqual(froth.observed, { startMs: 13_042, impactMs: 13_042, endMs: 19_042 });
  assert.equal(froth.sourceEventKeys.length, 2);
  assert.equal(froth.definition.timelinePresentation.parts.some((part) => part.kind === "marker" && part.at === "end" && part.text === "Plague Wave"), true);
  assert.equal(draft.mechanicCandidates.some((item) => item.definition.name === "Plague Wave"), false);

  assert.deepEqual(
    draft.mechanicCandidates.filter((item) => item.definition.name === "Toxic Vapor").map((item) => item.observed.displayLabel),
    ["×1", "×2"],
  );
  assert.equal(draft.mechanicCandidates.some((item) => item.sourceEventKeys.includes("validation:tick")), false);
});

test("writing a draft to plan snaps every observed timing point toward the previous second", () => {
  const source = snapshot();
  const draft = convertCombatLogSnapshotToDraft(source, encounterProfile());
  const plan = createPlanFromImportDraft(source, draft, { title: "Vashnik 正式服 fight 64 示例", importedAt: 1_788_019_200_000 });
  const fangDefinition = plan.definitions.mechanics.find((item) => item.name === "Dripping Fangs")!;
  const fang = plan.timeline.mechanics.find((item) => item.definitionId === fangDefinition.id)!;
  assert.deepEqual(fang.anchor, { kind: "pull", offsetMs: 8_000 });
  assert.deepEqual(fang.timing, { castTimeMs: 1_000, durationMs: 0 });
  assert.equal(plan.timeline.mechanics.find((item) => item.displayLabel === "×2")?.anchor.kind, "pull");
  assert.equal(plan.sources[0].kind, "combat-log");
  assert.equal(plan.roster.members.length, 0, "Boss timeline conversion must not leak player identities into the example plan");
});
