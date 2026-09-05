import assert from "node:assert/strict";
import test from "node:test";

import type { WclClient, WclFightEventBundle } from "../lib/wcl-client.ts";
import {
  convertCombatLogSnapshotToDraft,
  createPlanFromImportDraft,
  selectPublishedEncounterProfile,
} from "../lib/wcl-conversion.ts";
import type { WclFightConversionMetadata } from "../lib/wcl-contract.ts";
import {
  eventRequestsForProfiles,
  createWclImportPreview,
  normalizeWclFightBundle,
} from "../lib/wcl-import-server.ts";
import { selectWclImportMechanics } from "../lib/wcl-import.ts";
import {
  encounterConversionProfiles,
  liveVashnikProfile,
  playerSkillExtractionProfiles,
} from "../lib/wcl-profile-registry.ts";

const metadata: WclFightConversionMetadata = {
  schemaVersion: 1,
  reportCode: "LgdFn8NyAGRqWT3V",
  fightId: 64,
  encounterId: 3455,
  encounterName: "万毒邪祟者瓦什尼克",
  difficulty: "mythic",
  gameVersion: "retail-12.1",
  reportRevision: 45,
  reportStartEpochMs: 1_787_653_286_382,
  fightStartReportMs: 18_932_777,
  fightEndReportMs: 19_378_225,
  zoneId: 53,
};

function bundle(): WclFightEventBundle {
  return {
    report: { code: metadata.reportCode, revision: metadata.reportRevision, startTime: metadata.reportStartEpochMs, zoneId: 53 },
    masterData: {
      gameVersion: 1,
      logVersion: 17,
      lang: "cn",
      actors: [
        { id: -1, gameID: 0, type: "NPC", subType: "Boss", petOwner: null },
        { id: 1, gameID: 0, type: "Player", subType: "Mage", petOwner: null },
        { id: 2, gameID: 0, type: "Player", subType: "Priest", petOwner: null },
        { id: 3, gameID: 0, type: "Player", subType: "Warrior", petOwner: null },
        { id: 4, gameID: 0, type: "Player", subType: "Druid", petOwner: null },
        { id: 5, gameID: 0, type: "Player", subType: "Monk", petOwner: null },
        { id: 119, gameID: 259181, type: "NPC", subType: "Boss", petOwner: null },
        { id: 220, gameID: 269430, type: "NPC", subType: "None", petOwner: null },
        { id: 221, gameID: 269430, type: "NPC", subType: "None", petOwner: null },
        { id: 230, gameID: 260905, type: "NPC", subType: "None", petOwner: null },
      ],
    },
    fight: {
      id: 64,
      encounterID: 3455,
      name: metadata.encounterName,
      difficulty: 5,
      kill: true,
      startTime: metadata.fightStartReportMs,
      endTime: metadata.fightEndReportMs,
      phaseTransitions: [],
      friendlyPlayers: [1, 2, 3, 4, 5],
      enemyPlayers: [],
      friendlyNPCs: [],
      enemyNPCs: [
        { id: 119, gameID: 259181, petOwner: null },
      ],
      friendlyPets: [],
      enemyPets: [],
    },
    series: [
      { request: { dataType: "CombatantInfo", hostilityType: "Friendlies" }, pageCount: 1, events: [64, 257, 73, 105, 270].map((specID, index) => ({ type: "combatantinfo", timestamp: metadata.fightStartReportMs, sourceID: index + 1, specID })) },
      {
        request: { dataType: "Casts", hostilityType: "Enemies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 8_020, type: "begincast", sourceID: 119, targetID: -1, abilityGameID: 1_280_935 },
          { timestamp: metadata.fightStartReportMs + 9_999, type: "cast", sourceID: 119, targetID: -1, abilityGameID: 1_280_935 },
          { timestamp: metadata.fightStartReportMs + 26_480, type: "begincast", sourceID: 220, targetID: -1, abilityGameID: 1_304_459 },
          { timestamp: metadata.fightStartReportMs + 27_000, type: "begincast", sourceID: 221, targetID: -1, abilityGameID: 1_304_459 },
          { timestamp: metadata.fightStartReportMs + 28_650, type: "begincast", sourceID: 220, targetID: -1, abilityGameID: 1_304_459 },
          { timestamp: metadata.fightStartReportMs + 120_000, type: "begincast", sourceID: 230, targetID: -1, abilityGameID: 1_280_189 },
        ],
      },
      {
        request: { dataType: "DamageDone", hostilityType: "Friendlies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 10_010, type: "damage", sourceID: 119, targetID: 1, abilityGameID: 1_280_935, amount: 100 },
          { timestamp: metadata.fightStartReportMs + 121_520, type: "damage", sourceID: 230, targetID: 1, abilityGameID: 1_280_189, amount: 100 },
          { timestamp: metadata.fightStartReportMs + 122_000, type: "damage", sourceID: 119, targetID: 1, abilityGameID: 1_282_616, amount: 100 },
          { timestamp: metadata.fightStartReportMs + 123_000, type: "damage", sourceID: 119, targetID: 1, abilityGameID: 1_295_209, amount: 100 },
        ],
      },
      {
        request: { dataType: "Debuffs", hostilityType: "Friendlies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 13_042, type: "applydebuff", sourceID: 119, targetID: 1, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 13_043, type: "applydebuff", sourceID: 119, targetID: 2, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 13_044, type: "applydebuff", sourceID: 119, targetID: 3, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 13_045, type: "applydebuff", sourceID: 119, targetID: 4, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 13_046, type: "applydebuff", sourceID: 119, targetID: 5, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 18_050, type: "removedebuff", sourceID: 119, targetID: 1, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 19_042, type: "removedebuff", sourceID: 119, targetID: 2, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 19_043, type: "removedebuff", sourceID: 119, targetID: 3, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 19_044, type: "removedebuff", sourceID: 119, targetID: 4, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 19_045, type: "removedebuff", sourceID: 119, targetID: 5, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 42_200, type: "applydebuff", sourceID: 119, targetID: 1, abilityGameID: 1_294_994 },
          { timestamp: metadata.fightStartReportMs + 43_000, type: "applydebuff", sourceID: 119, targetID: 2, abilityGameID: 1_294_994 },
          { timestamp: metadata.fightStartReportMs + 43_950, type: "applydebuff", sourceID: 119, targetID: 3, abilityGameID: 1_294_994 },
          { timestamp: metadata.fightStartReportMs + 44_050, type: "applydebuff", sourceID: 119, targetID: 4, abilityGameID: 1_294_994 },
          { timestamp: metadata.fightStartReportMs + 42_800, type: "applydebuff", sourceID: 119, targetID: 1, abilityGameID: 1_295_173 },
          { timestamp: metadata.fightStartReportMs + 43_500, type: "applydebuff", sourceID: 119, targetID: 2, abilityGameID: 1_295_173 },
          { timestamp: metadata.fightStartReportMs + 44_650, type: "applydebuff", sourceID: 119, targetID: 3, abilityGameID: 1_295_173 },
          { timestamp: metadata.fightStartReportMs + 44_700, type: "applydebuff", sourceID: 119, targetID: 4, abilityGameID: 1_295_173 },
          { timestamp: metadata.fightStartReportMs + 50_000, type: "applydebuff", sourceID: 119, targetID: 1, abilityGameID: 1_295_224 },
          { timestamp: metadata.fightStartReportMs + 51_000, type: "applydebuff", sourceID: 119, targetID: 2, abilityGameID: 1_295_224 },
        ],
      },
      {
        request: { dataType: "Debuffs", hostilityType: "Enemies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 65, type: "applydebuff", sourceID: 119, targetID: 119, abilityGameID: 1_284_563, stack: 1 },
        ],
      },
    ],
    fetchedEventCount: 36,
    pageCount: 5,
  };
}

test("encounter 3455 exposes only the current live profile", () => {
  assert.equal(liveVashnikProfile.encounterId, 3455);
  assert.equal(liveVashnikProfile.profileVersion, 3);
  assert.equal(liveVashnikProfile.id, "20000000-0000-4000-8000-00000000000a");
  assert.equal(liveVashnikProfile.mechanicDefinitions.length, 9);
  assert.equal(liveVashnikProfile.collectionRules.length, 10);
  assert.equal(liveVashnikProfile.conversionRules.length, 13);
  assert.ok(liveVashnikProfile.mechanicDefinitions.every((definition) => definition.dataStatus === "verified"));
  assert.equal(liveVashnikProfile.mechanicDefinitions.find((definition) => definition.abilityGameIds.includes(1_295_224))?.name, "虹吸感染");
  assert.equal(liveVashnikProfile.mechanicDefinitions.find((definition) => definition.name === "瘟疫泡沫")?.durationMs, 6_000);
  assert.equal(liveVashnikProfile.conversionRules.some((rule) => rule.id.endsWith("305")), false);
  assert.equal(encounterConversionProfiles.length, 1);
  assert.equal(selectPublishedEncounterProfile(encounterConversionProfiles, {
    encounterId: 3455,
    gameVersion: "retail-12.1",
    profileVersion: 3,
  }).id, liveVashnikProfile.id);
  assert.throws(() => selectPublishedEncounterProfile(encounterConversionProfiles, {
    encounterId: 3455,
    gameVersion: "retail-12.1",
    profileVersion: 2,
  }));
});

test("event query planning reads both provider views and pushes complete ability allowlists to WCL", () => {
  const requests = eventRequestsForProfiles(liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(requests.length, 14);
  const profileRules = [...liveVashnikProfile.collectionRules, ...playerSkillExtractionProfiles[0].collectionRules];
  const collectionDataTypes = {
    Buffs: "buffs",
    Casts: "casts",
    CombatantInfo: "combatant-info",
    All: "deaths",
    DamageDone: "damage",
    Deaths: "deaths",
    Debuffs: "debuffs",
    Dispels: "dispels",
    Healing: "healing",
    Interrupts: "interrupts",
  } as const;
  for (const request of requests) {
    const rules = profileRules.filter((rule) => rule.enabled && rule.dataType === collectionDataTypes[request.dataType]);
    const expectedAbilityGameIds = rules.every((rule) => rule.abilityGameIds?.length)
      ? [...new Set(rules.flatMap((rule) => rule.abilityGameIds ?? []))].sort((left, right) => left - right)
      : undefined;
    assert.deepEqual(
      (request as typeof request & { abilityGameIds?: number[] }).abilityGameIds,
      expectedAbilityGameIds,
      `${request.dataType} should push the published profile ability allowlist into the WCL request`,
    );
  }
  for (const dataType of ["Casts", "DamageDone", "Debuffs"] as const) {
    assert.deepEqual(
      requests.filter((request) => request.dataType === dataType).map((request) => request.hostilityType).sort(),
      ["Enemies", "Friendlies"],
    );
  }
});

test("anonymous live events infer profile-scoped unlisted enemy NPCs, convert and prune into a strict local plan", async () => {
  const snapshot = await normalizeWclFightBundle(bundle(), metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(snapshot.encounter.encounterId, 3455);
  assert.equal(snapshot.events.length, 31);
  assert.ok(snapshot.actors.some((actor) => actor.name === "玩家 1"));
  assert.ok(snapshot.actors.some((actor) => actor.name === "NPC 269430"));
  assert.ok(snapshot.events.some((event) => event.abilityGameId === 1_280_189 && event.type === "cast-start"));
  assert.equal(snapshot.actors.find(actor => actor.reportActorId === 1)?.classSlug, "Mage");
  assert.equal(snapshot.actors.find(actor => actor.reportActorId === 1)?.specSlug, "frost");
  assert.doesNotMatch(JSON.stringify(snapshot), /access[_-]?token|client[_-]?secret/i);

  const draft = convertCombatLogSnapshotToDraft(snapshot, liveVashnikProfile);
  assert.deepEqual(new Set(draft.mechanicCandidates.map((candidate) => candidate.definition.name)), new Set([
    "毒性蒸汽",
    "滴毒之牙",
    "瘟疫泡沫",
    "虹吸感染",
    "冥河感染",
    "爆炸感染",
    "恶念",
  ]));
  assert.equal(draft.warnings.length, 0);
  assert.equal(draft.unresolvedEvents.length, 0);
  const froth = draft.mechanicCandidates.find((candidate) => candidate.definition.name === "瘟疫泡沫")!;
  assert.equal(froth.observed.endMs - froth.observed.startMs, 6_000);
  for (const name of ["虹吸感染", "冥河感染", "爆炸感染", "恶念"]) {
    assert.equal(draft.mechanicCandidates.filter((candidate) => candidate.definition.name === name).length, 1);
  }
  assert.equal(draft.mechanicCandidates.some((candidate) => candidate.definition.abilityGameIds.includes(1_280_189)), false);
  const plan = createPlanFromImportDraft(snapshot, draft);
  const selectedId = draft.mechanicCandidates.find((candidate) => candidate.definition.name === "瘟疫泡沫")!.id;
  const selected = selectWclImportMechanics(plan, [selectedId]);
  assert.equal(selected.timeline.mechanics.length, 1);
  assert.equal(selected.definitions.mechanics.length, 1);
  assert.equal(selected.roster.members.length, 0);
  assert.equal(selected.encounter.externalIds?.wclEncounterId, 3455);
});

test("fight-end truncation keeps only observed waves without missing warnings or catalog padding", async () => {
  const fullSnapshot = await normalizeWclFightBundle(bundle(), metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  const fullDraft = convertCombatLogSnapshotToDraft(fullSnapshot, liveVashnikProfile);
  const cutoffMs = 40_000;
  const shortBundle = structuredClone(bundle());
  shortBundle.fight.endTime = metadata.fightStartReportMs + cutoffMs;
  shortBundle.series = shortBundle.series.map((series) => ({
    ...series,
    events: series.events.filter((event) => {
      const timestamp = (event as { timestamp?: unknown }).timestamp;
      return typeof timestamp === "number" && timestamp <= shortBundle.fight.endTime;
    }),
  }));
  shortBundle.fetchedEventCount = shortBundle.series.reduce((total, series) => total + series.events.length, 0);
  const shortMetadata = {
    ...metadata,
    fightEndReportMs: metadata.fightStartReportMs + cutoffMs,
  };

  const shortSnapshot = await normalizeWclFightBundle(
    shortBundle,
    shortMetadata,
    liveVashnikProfile,
    playerSkillExtractionProfiles[0],
  );
  const shortDraft = convertCombatLogSnapshotToDraft(shortSnapshot, liveVashnikProfile);
  const shortPlan = createPlanFromImportDraft(shortSnapshot, shortDraft);

  assert.ok(shortDraft.mechanicCandidates.length < fullDraft.mechanicCandidates.length);
  assert.equal(shortDraft.warnings.length, 0);
  assert.equal(shortDraft.unresolvedEvents.length, 0);
  assert.equal(shortPlan.timeline.mechanics.length, shortDraft.mechanicCandidates.length);
  assert.ok(shortDraft.mechanicCandidates.every((candidate) => candidate.observed.startMs <= cutoffMs));
  assert.ok(shortDraft.mechanicCandidates.every((candidate) => (
    fullDraft.mechanicCandidates.some((fullCandidate) => fullCandidate.definition.id === candidate.definition.id)
  )));
});

test("WCL import preview exposes only an anonymous strict plan boundary", async () => {
  const fakeClient: WclClient = {
    async probeReport(link) {
      assert.equal(link.reportCode, metadata.reportCode);
      assert.equal(link.fight, metadata.fightId);
      return {
        report: {
          code: metadata.reportCode,
          title: "Anonymous test report",
          revision: metadata.reportRevision,
          startEpochMs: metadata.reportStartEpochMs,
          endEpochMs: metadata.reportStartEpochMs + metadata.fightEndReportMs,
          zone: { id: 53, name: "Midnight" },
        },
        requestedFight: metadata.fightId,
        selectedFightId: metadata.fightId,
        fights: [{
          id: metadata.fightId,
          encounterId: metadata.encounterId,
          encounterName: metadata.encounterName,
          difficulty: "mythic",
          supported: true,
          kill: true,
          startReportMs: metadata.fightStartReportMs,
          endReportMs: metadata.fightEndReportMs,
          durationMs: metadata.fightEndReportMs - metadata.fightStartReportMs,
          bossPercentage: 0,
          fightPercentage: 0,
          hasOfficialPhases: false,
          phases: [{ semanticPhaseId: 1, occurrenceIndex: 1, atMs: 0 }],
        }],
      };
    },
    async readFightEvents(reportCode, fightId, requests) {
      assert.equal(reportCode, metadata.reportCode);
      assert.equal(fightId, metadata.fightId);
      assert.ok(requests.every((request) => request.lifecycleOnly || request.dataType === "CombatantInfo" || Boolean(request.abilityGameIds?.length)));
      return bundle();
    },
  };

  const preview = await createWclImportPreview(fakeClient, {
    reportCode: metadata.reportCode,
    fight: metadata.fightId,
  }, metadata.fightId);
  const serialized = JSON.stringify(preview);

  assert.equal(preview.encounterId, 3455);
  assert.equal(preview.difficulty, "mythic");
  assert.equal(preview.encounterProfile.profileVersion, 3);
  assert.equal(preview.warningCount, 0);
  assert.equal(preview.unresolvedEventCount, 0);
  assert.equal(preview.plan.roster.members.length, 5);
  assert.deepEqual(preview.plan.roster.members.map(member => member.role), ["tank", "healer", "healer", "healer", "damage"]);
  assert.doesNotMatch(serialized, /"(?:actors|events|headers)":/i);
  assert.doesNotMatch(serialized, /玩家\s*\d+/);
  assert.doesNotMatch(serialized, /access[_-]?token|client[_-]?secret|authorization|bearer\s/i);
});

test("normalization strips combatant payloads, keeps reliable specs and has stable deduplicated hashes", async () => {
  const input = bundle();
  const info = input.series.find(series => series.request.dataType === "CombatantInfo")!;
  info.events[0] = { ...(info.events[0] as object), name: "DO_NOT_COPY_NAME", gear: [{ name: "DO_NOT_COPY_GEAR" }], talentTree: [123] };
  const first = await normalizeWclFightBundle(input, metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  const repeated = structuredClone(input);
  repeated.series.push(structuredClone(repeated.series[1]));
  const second = await normalizeWclFightBundle(repeated, metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.events.length, second.events.length);
  assert.doesNotMatch(JSON.stringify(first), /DO_NOT_COPY|gear|talentTree/);
  assert.equal(first.actors.find(actor => actor.reportActorId === 1)?.specSlug, "frost");
  info.events.push({ type: "combatantinfo", sourceID: 1, specID: 63 });
  const conflict = await normalizeWclFightBundle(input, metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(conflict.actors.find(actor => actor.reportActorId === 1)?.specSlug, undefined);
});
