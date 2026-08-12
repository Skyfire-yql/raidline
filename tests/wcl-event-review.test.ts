import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWclActorIndex,
  buildWclEventReviewCatalog,
  formatReviewTime,
  type WclCompatReport,
  type WclRawEvent,
} from "../lib/wcl-event-review.ts";

const report: WclCompatReport = {
  title: "Fixture Vashnik",
  masterData: {
    actors: [
      { id: -1, name: "Environment", guid: 0, type: "NPC", subType: "Boss" },
      { id: 1, name: "Priest", guid: 1001, type: "Player", subType: "Priest" },
      { id: 2, name: "Priest Pet", guid: 1002, type: "Pet", subType: "Pet", petOwner: 1 },
      { id: 10, name: "Vashnik", guid: 259181, type: "NPC", subType: "Boss" },
    ],
  },
  friendlies: [{ id: 1, name: "Priest", guid: 1001, type: "Priest" }],
  friendlyPets: [{ id: 2, name: "Priest Pet", guid: 1002, type: "Pet", petOwner: 1 }],
  enemies: [{ id: 10, name: "Vashnik", guid: 259181, type: "NPC", subType: "Boss" }],
  fights: [1, 2, 3].map((id) => ({
    id,
    start_time: id * 100_000,
    end_time: id * 100_000 + 60_000,
    name: "Vashnik the Malignant",
    difficulty: 5,
    kill: id === 3,
    enemyNPCs: [{ id: 10 }],
  })),
};

const toxic = { name: "Toxic Vapor", guid: 1284561, type: 8, abilityIcon: "toxic.jpg" };
const shield = { name: "Test Shield", guid: 9001, type: 2 };

function event(fight: number, atMs: number, value: { type: string } & Omit<WclRawEvent, "fight" | "timestamp" | "type">): WclRawEvent {
  return { ...value, fight, timestamp: fight * 100_000 + atMs };
}

test("WCL review keeps enemy mechanics, preserves shield absorption ownership and excludes player output", () => {
  const events: WclRawEvent[] = [];
  for (const fight of [1, 2, 3]) {
    events.push(
      event(fight, 1_000 + fight * 100, { type: "begincast", sourceID: 10, targetID: -1, ability: toxic }),
      event(fight, 2_000 + fight * 100, { type: "damage", sourceID: 10, targetID: 1, ability: toxic, amount: 100 }),
      event(fight, 2_050 + fight * 100, { type: "damage", sourceID: 10, targetID: 1, ability: toxic, amount: 110 }),
      event(fight, 2_100 + fight * 100, { type: "absorbed", sourceID: 1, targetID: 1, attackerID: 10, ability: shield, extraAbility: toxic, amount: 50 }),
      event(fight, 3_000, { type: "damage", sourceID: 1, targetID: 10, ability: { name: "Smite", guid: 585 }, amount: 500, hitPoints: 900, maxHitPoints: 1_000 }),
      event(fight, 4_000, { type: "applybuff", sourceID: 1, targetID: 1, ability: { name: "Player Defensive", guid: 777 } }),
      event(fight, 4_500, { type: "heal", sourceID: 1, targetID: 1, ability: { name: "Ordinary Heal", guid: 888 }, amount: 200 }),
      event(fight, 5_000, { type: "damage", sourceID: 2, targetID: 10, ability: { name: "Pet Attack", guid: 999 }, amount: 20 }),
      event(fight, 5_500, { type: "aurabroken", sourceID: 10, targetID: 10, ability: { name: "Player Crowd Control", guid: 111 }, extraAbility: { name: "Player Damage", guid: 222 } }),
    );
  }

  const catalog = buildWclEventReviewCatalog({ reportCode: "ABCDEF1234567890", report, fightIds: [1, 2, 3], events, generatedAt: 1 });
  const toxicFamily = catalog.families.find((family) => family.abilityId === 1284561);
  assert.ok(toxicFamily);
  assert.equal(toxicFamily.category, "enemy");
  assert.deepEqual(toxicFamily.observedTargets.map((target) => target.name), ["Environment", "Priest"]);
  assert.match(toxicFamily.description, /周期自然伤害/);
  assert.deepEqual(toxicFamily.relatedAbilityIds, []);
  assert.equal(toxicFamily.suggestedAnchorEvent, "begincast");
  assert.equal(toxicFamily.crossFightTiming.stableWithinThreeSeconds, true);
  const damage = toxicFamily.eventTypes.find((item) => item.type === "damage");
  assert.equal(damage?.fights[0].rawEventCount, 2);
  assert.equal(damage?.fights[0].waves.length, 1, "同一轮对多个目标的相邻事件合并为一个时间波次");

  const smite = catalog.families.find((family) => family.abilityId === 585);
  const defensive = catalog.families.find((family) => family.abilityId === 777);
  const shieldFamily = catalog.families.find((family) => family.abilityId === 9001);
  const heal = catalog.families.find((family) => family.abilityId === 888);
  const pet = catalog.families.find((family) => family.abilityId === 999);
  const auraBroken = catalog.families.find((family) => family.abilityId === 111);
  assert.equal(smite?.category, "excluded");
  assert.match(smite?.excludedReason ?? "", /玩家伤害/);
  assert.equal(defensive?.category, "player");
  assert.equal(shieldFamily?.category, "player");
  assert.deepEqual(shieldFamily?.relatedAbilityIds, [1284561]);
  assert.equal(heal?.category, "excluded");
  assert.equal(pet?.category, "excluded");
  assert.equal(auraBroken?.category, "excluded");
  assert.match(auraBroken?.excludedReason ?? "", /光环破除/);
  assert.equal(catalog.extractedBossHealth.length, 3, "丢弃玩家伤害候选前提取 Boss 血量样本");
  assert.equal(catalog.extractedBossHealth[0].percent, 90);
});

test("WCL review time formatting preserves millisecond precision", () => {
  assert.equal(formatReviewTime(0), "00:00.000");
  assert.equal(formatReviewTime(125_678), "02:05.678");
});

test("WCL review prefers per-fight actor ownership when top-level compatibility lists are incomplete", () => {
  const incompleteReport: WclCompatReport = {
    title: "Incomplete actor lists",
    masterData: {
      actors: [
        { id: 20, name: "Late-spawned Venom", guid: 259999, type: "NPC" },
        { id: 21, name: "Late-joining Priest", guid: 1002, type: "Player" },
        { id: 22, name: "Late-spawned Venom", guid: 259999, type: "NPC" },
      ],
    },
    fights: [{
      id: 1,
      start_time: 0,
      end_time: 1_000,
      name: "Vashnik the Malignant",
      enemyNPCs: [{ id: 20 }],
      friendlyPlayers: [21],
    }],
  };

  const actors = buildWclActorIndex(incompleteReport);
  assert.equal(actors.get(20)?.affiliation, "enemy");
  assert.equal(actors.get(21)?.affiliation, "friendly-player");
  assert.equal(actors.get(22)?.affiliation, "enemy", "同一 NPC game ID 的附加 actor 也应归为敌方");
});
