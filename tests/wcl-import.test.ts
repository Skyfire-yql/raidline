import assert from "node:assert/strict";
import test from "node:test";

import type { WclFightEventBundle } from "../lib/wcl-client.ts";
import {
  convertCombatLogSnapshotToDraft,
  createPlanFromImportDraft,
  selectPublishedEncounterProfile,
} from "../lib/wcl-conversion.ts";
import type { WclFightConversionMetadata } from "../lib/wcl-contract.ts";
import {
  eventRequestsForProfiles,
  normalizeWclFightBundle,
} from "../lib/wcl-import-server.ts";
import { selectWclImportMechanics } from "../lib/wcl-import.ts";
import {
  encounterConversionProfiles,
  liveVashnikProfile,
  liveVashnikProfileV1,
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
        { id: 119, gameID: 259181, type: "NPC", subType: "Boss", petOwner: null },
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
      friendlyPlayers: [1],
      enemyPlayers: [],
      friendlyNPCs: [],
      enemyNPCs: [{ id: 119, gameID: 259181, petOwner: null }],
      friendlyPets: [],
      enemyPets: [],
    },
    series: [
      {
        request: { dataType: "Casts", hostilityType: "Enemies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 8_020, type: "begincast", sourceID: 119, targetID: -1, abilityGameID: 1_280_935 },
          { timestamp: metadata.fightStartReportMs + 9_999, type: "cast", sourceID: 119, targetID: -1, abilityGameID: 1_280_935 },
        ],
      },
      {
        request: { dataType: "DamageDone", hostilityType: "Friendlies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 10_010, type: "damage", sourceID: 119, targetID: 1, abilityGameID: 1_280_935, amount: 100 },
        ],
      },
      {
        request: { dataType: "Debuffs", hostilityType: "Friendlies" },
        pageCount: 1,
        events: [
          { timestamp: metadata.fightStartReportMs + 13_042, type: "applydebuff", sourceID: 119, targetID: 1, abilityGameID: 1_281_913 },
          { timestamp: metadata.fightStartReportMs + 21_028, type: "removedebuff", sourceID: 119, targetID: 1, abilityGameID: 1_281_913 },
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
    fetchedEventCount: 6,
    pageCount: 4,
  };
}

test("live encounter 3455 keeps v1 and selects the localized v2 profile exactly", () => {
  assert.equal(liveVashnikProfile.encounterId, 3455);
  assert.equal(liveVashnikProfile.profileVersion, 2);
  assert.equal(liveVashnikProfile.id, "20000000-0000-4000-8000-000000000009");
  assert.equal(liveVashnikProfile.mechanicDefinitions.length, 6);
  assert.equal(liveVashnikProfile.conversionRules.length, 11);
  assert.equal(liveVashnikProfile.mechanicDefinitions.find((definition) => definition.abilityGameIds.includes(1_295_224))?.name, "虹吸感染");
  assert.equal(liveVashnikProfile.conversionRules.find((rule) => rule.id.endsWith("30c"))?.verification.sourceReportCodes[0], "baxm3wf8MDvF6V7W");
  assert.ok(liveVashnikProfile.conversionRules.filter((rule) => !rule.id.endsWith("30c")).every((rule) => (
    rule.verification.sourceReportCodes.length === 1
    && rule.verification.sourceReportCodes[0] === "LgdFn8NyAGRqWT3V"
  )));
  assert.equal(selectPublishedEncounterProfile(encounterConversionProfiles, {
    encounterId: 3455,
    gameVersion: "retail-12.1",
    profileVersion: 1,
  }).id, liveVashnikProfileV1.id);
  assert.equal(selectPublishedEncounterProfile(encounterConversionProfiles, {
    encounterId: 3455,
    gameVersion: "retail-12.1",
    profileVersion: 2,
  }).id, liveVashnikProfile.id);
});

test("event query planning reads both provider views and leaves source hostility to normalization", () => {
  const requests = eventRequestsForProfiles(liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(requests.length, 8);
  for (const dataType of ["Casts", "DamageDone", "Deaths", "Debuffs"] as const) {
    assert.deepEqual(
      requests.filter((request) => request.dataType === dataType).map((request) => request.hostilityType).sort(),
      ["Enemies", "Friendlies"],
    );
  }
});

test("anonymous live events normalize, convert and prune into a strict local plan", async () => {
  const snapshot = await normalizeWclFightBundle(bundle(), metadata, liveVashnikProfile, playerSkillExtractionProfiles[0]);
  assert.equal(snapshot.encounter.encounterId, 3455);
  assert.equal(snapshot.events.length, 6);
  assert.deepEqual(snapshot.actors.map((actor) => actor.name), ["玩家 1", "NPC 259181"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /"Mage"/);
  assert.doesNotMatch(JSON.stringify(snapshot), /access[_-]?token|client[_-]?secret/i);

  const draft = convertCombatLogSnapshotToDraft(snapshot, liveVashnikProfile);
  assert.deepEqual(new Set(draft.mechanicCandidates.map((candidate) => candidate.definition.name)), new Set([
    "毒性蒸汽",
    "滴毒之牙",
    "瘟疫泡沫",
  ]));
  const plan = createPlanFromImportDraft(snapshot, draft);
  const selectedId = draft.mechanicCandidates.find((candidate) => candidate.definition.name === "瘟疫泡沫")!.id;
  const selected = selectWclImportMechanics(plan, [selectedId]);
  assert.equal(selected.timeline.mechanics.length, 1);
  assert.equal(selected.definitions.mechanics.length, 1);
  assert.equal(selected.roster.members.length, 0);
  assert.equal(selected.encounter.externalIds?.wclEncounterId, 3455);
});
