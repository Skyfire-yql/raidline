import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ALL_TARGETS,
  assertPlanDocument,
  buildMechanicDamageEvents,
  calculateMechanicPressure,
  createBlankPlan,
  defaultAssignmentStart,
  detectConflicts,
  exportMrtNote,
  formatTime,
  mechanicImpactMs,
  normalizePlanDocument,
  parseTime,
  resolveTargetMemberIds,
  syncLinkedAssignments,
} from "../lib/core.ts";
import { applyBuiltInPreset, BUILT_IN_PRESETS, createPersonalPreset, parsePresetJson, stringifyPreset } from "../lib/presets.ts";
import { cooldownsForClass, specializationFor, specializationLabel, specializationsForClass } from "../lib/cooldowns.ts";
import type { CooldownDefinition, CooldownEffect, RaidMechanic, TargetSelection } from "../lib/types.ts";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, timeAxisPosition, timelineTimeFromDrag, viewPreferenceKey, zoomFromWheel } from "../lib/view.ts";

function member(id: string, classSlug = "Priest", groupId?: string) {
  return { id, name: id.toUpperCase(), classSlug, specSlug: "测试专精", role: "damage" as const, color: "#fff", ...(groupId ? { groupId } : {}) };
}

function mechanic(id: string, atMs: number, amount: number | null, targets: TargetSelection = ALL_TARGETS, extra: Partial<RaidMechanic> = {}): RaidMechanic {
  return {
    id,
    name: id,
    description: "测试机制",
    atMs,
    castTimeMs: 0,
    durationMs: 0,
    damage: { school: "magic", directAmount: amount, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false },
    targets: structuredClone(targets),
    severity: "warning",
    source: "manual",
    note: "",
    ...extra,
  };
}

function cooldown(id: string, effects: CooldownEffect[], extra: Partial<CooldownDefinition> = {}): CooldownDefinition {
  return {
    id,
    name: id,
    description: "测试技能",
    classSlug: "Priest",
    specSlugs: [],
    scope: "team",
    cooldownMs: 60_000,
    castTimeMs: 0,
    durationMs: 120_000,
    triggersGcd: false,
    maxTargets: null,
    effects,
    category: "团队减伤",
    color: "#fff",
    catalogVersion: "test",
    dataStatus: "custom",
    ...extra,
  };
}

function assignment(id: string, memberId: string, cooldownId: string, atMs = 0, targets: TargetSelection = ALL_TARGETS) {
  return { id, memberId, cooldownId, atMs, targets: structuredClone(targets), note: "", source: "manual" as const };
}

test("migrates v1 to v2 while preserving old numeric data as legacy", () => {
  const v1 = {
    schemaVersion: 1,
    encounter: { name: "旧计划", difficulty: "英雄", durationMs: 120_000 },
    roster: [member("m1")],
    phases: [{ id: "p1", name: "P1", atMs: 0 }],
    mechanics: [{ id: "mec", name: "旧机制", atMs: 10_000, durationMs: 5000, severity: "warning", source: "manual", note: "旧备注" }],
    cooldowns: [{ id: "old", name: "旧技能", classSlug: "Priest", cooldownMs: 180_000, durationMs: 8000, category: "减伤", color: "#fff" }],
    assignments: [{ id: "a1", memberId: "m1", cooldownId: "old", mechanicId: "mec", atMs: 7000, note: "", source: "manual" }],
    settings: { snapMs: 1000, zoom: 1.5, showMinorMechanics: true },
  };
  const plan = normalizePlanDocument(v1);
  assert.equal(plan.schemaVersion, 2);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.mechanics[0].castTimeMs, 0);
  assert.equal(plan.mechanics[0].durationMs, 5000);
  assert.equal(plan.cooldowns[0].cooldownMs, 180_000);
  assert.equal(plan.cooldowns[0].durationMs, 8000);
  assert.equal(plan.cooldowns[0].dataStatus, "legacy");
  assert.equal(plan.assignments[0].targets.mode, "inherit");
  assert.equal(plan.assignments[0].offsetMs, -3000);
  assert.equal(plan.settings.referenceMaxHealth, null);
  assert.equal(plan.settings.pressureResetMs, 10_000);
});

test("distinguishes unknown null from explicit zero and validates v2 documents", () => {
  const plan = createBlankPlan();
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.roster.length, 20);
  assert.equal(plan.encounter.durationMs, 3_600_000);
  assert.equal(plan.roster[0].name, "成员 01");
  assert.equal(plan.roster[19].name, "成员 20");
  assert.ok(plan.roster.every((item) => item.classSlug === ""));
  assert.equal(plan.cooldowns[0].cooldownMs, null);
  const unknown = mechanic("unknown", 10_000, 100_000, ALL_TARGETS, { castTimeMs: null });
  const instant = mechanic("instant", 10_000, 100_000, ALL_TARGETS, { castTimeMs: 0, durationMs: 0 });
  assert.deepEqual(buildMechanicDamageEvents(unknown), []);
  assert.equal(buildMechanicDamageEvents(instant)[0].atMs, 10_000);
  assert.doesNotThrow(() => assertPlanDocument(plan));
  const invalid = structuredClone(plan);
  invalid.settings.referenceMaxHealth = -1;
  assert.throws(() => assertPlanDocument(invalid), /最大生命/);
});

test("filters skills only after a class is selected", () => {
  const plan = createBlankPlan();
  assert.deepEqual(cooldownsForClass(plan.cooldowns, ""), []);
  const priestSkills = cooldownsForClass(plan.cooldowns, "Priest");
  assert.ok(priestSkills.length > 0);
  assert.ok(priestSkills.every((item) => item.classSlug === "Priest"));
  assert.ok(priestSkills.length < plan.cooldowns.length);
});

test("maps specialization dropdown values to labels and roles", () => {
  assert.equal(specializationFor("Priest", "discipline")?.role, "healer");
  assert.equal(specializationFor("Druid", "guardian")?.role, "tank");
  assert.equal(specializationLabel("Mage", "fire"), "火焰");
  assert.equal(specializationLabel("Mage", "旧专精"), "旧专精");
  assert.equal(specializationsForClass("Hunter").length, 3);

  const plan = createBlankPlan();
  plan.roster[0] = { ...plan.roster[0], classSlug: "Druid", specSlug: "guardian", role: "damage" };
  assert.equal(normalizePlanDocument(plan).roster[0].role, "tank");
});

test("calculates the 50/60/80/30 adjacent-pressure example without compounding older pressure", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.mechanics = [
    mechanic("m1", 10_000, 500_000),
    mechanic("m2", 18_000, 600_000),
    mechanic("m3", 26_000, 800_000),
    mechanic("m4", 34_000, 300_000),
  ];
  assert.deepEqual(calculateMechanicPressure(plan).map((item) => item.headlinePressure), [500_000, 1_100_000, 1_400_000, 1_100_000]);
});

test("uses an inclusive reset threshold and marks equality with max health as lethal", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.settings.referenceMaxHealth = 100;
  plan.settings.pressureResetMs = 10_000;
  plan.mechanics = [mechanic("a", 0, 40), mechanic("b", 10_000, 60), mechanic("c", 20_001, 100)];
  const results = calculateMechanicPressure(plan);
  assert.equal(results[1].headlinePressure, 100);
  assert.equal(results[1].members[0].lethal, true);
  assert.equal(results[2].headlinePressure, 100);
  assert.equal(results[2].members[0].previousDamage, 0);
});

test("finds each member's own previous hit across alternating half-room targets", () => {
  const plan = createBlankPlan();
  plan.groups = [{ id: "left", name: "左场", color: "#f00" }, { id: "right", name: "右场", color: "#00f" }];
  plan.roster = [member("left-player", "Priest", "left"), member("right-player", "Priest", "right")];
  plan.mechanics = [
    mechanic("left-1", 0, 100, { mode: "groups", groupIds: ["left"] }),
    mechanic("right-1", 5000, 200, { mode: "groups", groupIds: ["right"] }),
    mechanic("left-2", 9000, 300, { mode: "groups", groupIds: ["left"] }),
  ];
  assert.deepEqual(resolveTargetMemberIds(plan, plan.mechanics[0].targets), ["left-player"]);
  const third = calculateMechanicPressure(plan)[2];
  assert.equal(third.members[0].memberId, "left-player");
  assert.equal(third.members[0].previousDamage, 100);
  assert.equal(third.members[0].pressure, 400);
});

test("generates direct and periodic events including optional immediate first tick", () => {
  const dot = mechanic("dot", 10_000, 100, ALL_TARGETS, {
    castTimeMs: 2000,
    durationMs: 6000,
    damage: { school: "magic", directAmount: 100, periodicAmount: 25, periodicIntervalMs: 2000, tickOnStart: true },
  });
  const events = buildMechanicDamageEvents(dot);
  assert.deepEqual(events.map((item) => [item.atMs, item.amount]), [[12_000, 100], [12_000, 25], [14_000, 25], [16_000, 25], [18_000, 25]]);
  const plan = createBlankPlan(); plan.roster = [member("m1")]; plan.mechanics = [dot];
  const result = calculateMechanicPressure(plan)[0];
  assert.equal(result.rawPerTarget, 200);
  assert.equal(Math.round(result.averageDps ?? 0), 33);
});

test("applies school-specific reductions multiplicatively and immunity first", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.mechanics = [
    mechanic("physical", 10_000, 1000, ALL_TARGETS, { damage: { school: "physical", directAmount: 1000, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false } }),
    mechanic("magic", 30_000, 1000),
    mechanic("immune", 50_000, 1000),
  ];
  plan.cooldowns = [
    cooldown("physical-20", [{ type: "damageReduction", percent: 20, schools: ["physical"] }]),
    cooldown("both-50", [{ type: "damageReduction", percent: 50, schools: ["physical", "magic"] }]),
    cooldown("magic-immunity", [{ type: "immunity", schools: ["magic"] }], { durationMs: 10_000 }),
  ];
  plan.assignments = [assignment("a1", "m1", "physical-20"), assignment("a2", "m1", "both-50"), assignment("a3", "m1", "magic-immunity", 45_000)];
  const results = calculateMechanicPressure(plan);
  assert.equal(results[0].members[0].currentDamage, 400);
  assert.equal(results[1].members[0].currentDamage, 500);
  assert.equal(results[2].members[0].currentDamage, 0);
});

test("consumes per-target and truly shared absorb pools in chronological order across mechanics", () => {
  const makePlan = (allocation: "perTarget" | "shared") => {
    const plan = createBlankPlan();
    plan.roster = [member("m1"), member("m2")];
    plan.mechanics = [mechanic("hit-1", 10_000, 60), mechanic("hit-2", 20_000, 60)];
    plan.cooldowns = [cooldown("shield", [{ type: "absorb", amount: 100, allocation, schools: ["magic"] }])];
    plan.assignments = [assignment("shield-use", "m1", "shield")];
    return plan;
  };
  const perTarget = calculateMechanicPressure(makePlan("perTarget"));
  assert.deepEqual(perTarget.map((item) => item.members.map((entry) => entry.currentDamage)), [[0, 0], [20, 20]]);
  const shared = calculateMechanicPressure(makePlan("shared"));
  assert.deepEqual(shared.map((item) => item.members.map((entry) => entry.currentDamage)), [[0, 20], [60, 60]]);
});

test("raises the survival threshold without reducing healing demand", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.settings.referenceMaxHealth = 100;
  plan.mechanics = [mechanic("hit", 10_000, 100)];
  plan.cooldowns = [cooldown("health", [{ type: "maxHealth", percent: 50 }])];
  plan.assignments = [assignment("health-use", "m1", "health")];
  const result = calculateMechanicPressure(plan)[0].members[0];
  assert.equal(result.currentDamage, 100);
  assert.equal(result.effectiveMaxHealth, 150);
  assert.equal(result.lethal, false);
});

test("forces personal mitigation to the caster and warns about target caps and class mismatch", () => {
  const plan = createBlankPlan();
  plan.roster = [member("priest", "Priest"), member("warrior", "Warrior")];
  plan.mechanics = [mechanic("hit", 10_000, 100)];
  plan.cooldowns = [
    cooldown("personal", [{ type: "damageReduction", percent: 50, schools: ["magic"] }], { scope: "personal", maxTargets: 1, category: "个人减伤" }),
    cooldown("external", [{ type: "damageReduction", percent: 20, schools: ["magic"] }], { scope: "external", maxTargets: 1 }),
  ];
  plan.assignments = [
    assignment("self", "priest", "personal", 0, { mode: "all" }),
    assignment("too-many", "warrior", "external", 0, { mode: "all" }),
  ];
  const damage = calculateMechanicPressure(plan)[0].members;
  assert.deepEqual(damage.map((item) => item.currentDamage), [40, 100]);
  const warnings = detectConflicts(plan);
  assert.ok(warnings.some((item) => item.assignmentId === "too-many" && item.type === "target"));
  assert.ok(warnings.some((item) => item.assignmentId === "too-many" && item.type === "ownership"));
});

test("detects cast overlap, explicit GCD spacing, cooldowns, and leaves zero-length casts non-overlapping", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.cooldowns = [
    cooldown("long", [], { castTimeMs: 2000, triggersGcd: true, cooldownMs: 60_000 }),
    cooldown("instant", [], { castTimeMs: 0, triggersGcd: true }),
    cooldown("off-gcd", [], { castTimeMs: 0, triggersGcd: false }),
  ];
  plan.assignments = [
    assignment("a1", "m1", "long", 0),
    assignment("a2", "m1", "instant", 1000),
    assignment("a3", "m1", "off-gcd", 5000),
    assignment("a4", "m1", "off-gcd", 5500),
    assignment("a5", "m1", "long", 30_000),
  ];
  const warnings = detectConflicts(plan);
  assert.ok(warnings.some((item) => item.assignmentId === "a2" && item.type === "cast"));
  assert.ok(warnings.some((item) => item.assignmentId === "a2" && item.type === "gcd"));
  assert.ok(warnings.some((item) => item.assignmentId === "a5" && item.type === "cooldown"));
  assert.ok(!warnings.some((item) => item.assignmentId === "a4" && (item.type === "cast" || item.type === "gcd")));
});

test("uses the three-second defensive lead, healing cast back-timing, and linked offsets", () => {
  const plan = createBlankPlan();
  const hit = mechanic("hit", 10_000, 100, ALL_TARGETS, { castTimeMs: 2000 });
  const defensive = cooldown("defensive", [{ type: "damageReduction", percent: 20, schools: ["magic"] }], { castTimeMs: 0 });
  const healing = cooldown("healing", [], { category: "治疗", castTimeMs: 2000 });
  assert.equal(mechanicImpactMs(hit), 12_000);
  assert.equal(defaultAssignmentStart(plan, defensive, hit), 9000);
  assert.equal(defaultAssignmentStart(plan, healing, hit), 10_000);
  plan.mechanics = [hit];
  plan.assignments = [{ ...assignment("linked", "m1", "defensive", 9000), mechanicId: "hit", offsetMs: -3000 }];
  hit.atMs = 20_000;
  syncLinkedAssignments(plan, "hit");
  assert.equal(plan.assignments[0].atMs, 19_000);
});

test("presets replace the correct scope and validate imported JSON", () => {
  const plan = createBlankPlan("当前计划");
  plan.groups = [{ id: "g1", name: "左场", color: "#f00" }];
  plan.roster = [member("m1", "Priest", "g1")];
  plan.assignments = [assignment("a1", "m1", plan.cooldowns[0].id)];
  const originalCooldownIds = plan.cooldowns.map((item) => item.id);
  const applied = applyBuiltInPreset(plan, BUILT_IN_PRESETS[0]);
  assert.equal(applied.encounter.name, "基础机制示例");
  assert.equal(applied.phases[0].id, "preset-phase-p1");
  assert.deepEqual(applied.mechanics.map((item) => item.id), [
    "preset-mechanic-stack",
    "preset-mechanic-spread",
    "preset-mechanic-transition",
    "preset-mechanic-soak",
  ]);
  assert.ok(applied.mechanics.every((item) => item.damage.directAmount == null && item.damage.periodicAmount == null));
  assert.deepEqual(applied.roster, plan.roster);
  assert.deepEqual(applied.groups, plan.groups);
  assert.deepEqual(applied.cooldowns.map((item) => item.id), originalCooldownIds);
  assert.deepEqual(applied.assignments, []);
  const personal = createPersonalPreset("完整备份", plan);
  const roundTrip = parsePresetJson(stringifyPreset(personal));
  assert.equal(roundTrip.document.encounter.name, "当前计划");
  assert.equal(roundTrip.kind, "personal");
  assert.throws(() => parsePresetJson('{"name":"坏预设"}'), /缺少计划内容/);
});

test("initializes built-in presets without global-scope randomness", () => {
  const moduleUrl = new URL("../lib/presets.ts?worker-global-safety=1", import.meta.url).href;
  const script = `
    globalThis.crypto.randomUUID = () => { throw new Error("randomUUID called during module initialization"); };
    Math.random = () => { throw new Error("Math.random called during module initialization"); };
    const presets = await import(${JSON.stringify(moduleUrl)});
    if (presets.BUILT_IN_PRESETS[0].document.phases[0].id !== "preset-phase-p1") process.exit(2);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("exports MRT text and converts view coordinates and pointer-anchored zoom", () => {
  const plan = createBlankPlan("测试首领");
  plan.roster = [member("m1")];
  plan.cooldowns = [cooldown("spell", [])];
  plan.assignments = [assignment("a1", "m1", "spell", 30_000)];
  assert.match(exportMrtNote(plan), /\{time:00:30\} M1 — spell/);
  assert.equal(formatTime(83_000), "01:23");
  assert.equal(parseTime("01:23"), 83_000);
  assert.equal(parseTime("1.5"), 1500);
  assert.equal(parseTime("bad"), null);
  assert.equal(defaultOrientation(719), "vertical");
  assert.equal(defaultOrientation(720), "horizontal");
  assert.equal(viewPreferenceKey("plan", "abc", 390), "raidline:view:plan:mobile:abc");
  assert.equal(viewPreferenceKey("plan", "abc", 1280), "raidline:view:plan:desktop:abc");
  assert.equal(zoomFromWheel(1, -1), 1.1);
  assert.equal(zoomFromWheel(3, -1), 3);
  assert.equal(shouldInterceptTimelineWheel(true, true), true);
  assert.equal(shouldInterceptTimelineWheel(false, true), false);
  assert.equal(shouldInterceptTimelineWheel(true, false), false);
  assert.equal(anchoredScroll(100, 50, 1, 2), 250);
  assert.equal(timeAxisPosition(2000, 5), 10);
  assert.equal(timelineTimeFromDrag(30_000, 13, 5, 3_600_000, 1000), 33_000);
  assert.equal(timelineTimeFromDrag(1000, -100, 5, 3_600_000, 1000), 0);
  assert.equal(timelineTimeFromDrag(3_599_000, 100, 5, 3_600_000, 1000), 3_600_000);
});
