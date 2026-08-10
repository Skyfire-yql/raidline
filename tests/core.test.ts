import assert from "node:assert/strict";
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
import { applyCatalogPreset, catalogDifference, SEED_CATALOG, validateCatalogRelease } from "../lib/catalog.ts";
import { cooldownsForClass, cooldownsForMember, specializationFor, specializationLabel, specializationsForClass } from "../lib/cooldowns.ts";
import { memberSkillVariantId, resolveCooldownForMember, setMemberSkillVariant } from "../lib/skills.ts";
import { EDIT_ID_PATTERN, randomBase62, SHARE_ID_PATTERN } from "../lib/publication-ids.ts";
import { isExpectedRevision, snapshotIdsToDelete } from "../lib/local-policy.ts";
import type { CooldownDefinition, CooldownEffect, RaidMechanic, TargetSelection } from "../lib/types.ts";
import { adaptiveTickMs, anchoredScroll, defaultOrientation, MAX_ZOOM, MIN_TIMELINE_MS, shouldInterceptTimelineWheel, timeAxisPosition, timelineRangeMs, timelineTimeFromDrag, viewPreferenceKey, zoomFromWheel } from "../lib/view.ts";

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
  const result = {
    id,
    name: id,
    description: "测试技能",
    classSlug: "Priest",
    specSlugs: [],
    scope: "team",
    cooldownMs: 60_000,
    castType: "instant",
    castTimeMs: 0,
    durationMs: 120_000,
    triggersGcd: false,
    maxCharges: 1,
    maxTargets: null,
    effects,
    variants: [],
    limitations: [],
    category: "团队减伤",
    color: "#fff",
    catalogVersion: "test",
    dataStatus: "custom",
    ...extra,
  } as CooldownDefinition;
  if (extra.castType == null && extra.castTimeMs != null) result.castType = extra.castTimeMs === 0 ? "instant" : "cast";
  return result;
}

function assignment(id: string, memberId: string, cooldownId: string, atMs = 0, targets: TargetSelection = ALL_TARGETS) {
  return { id, memberId, cooldownId, atMs, targets: structuredClone(targets), note: "", source: "manual" as const };
}

test("migrates v1 to v5 while preserving old numeric data as legacy", () => {
  const v1 = {
    schemaVersion: 1,
    encounter: { name: "旧计划", difficulty: "英雄", durationMs: 120_000 },
    roster: [member("m1")],
    phases: [{ id: "p1", name: "P1", atMs: 0 }],
    mechanics: [{ id: "mec", name: "旧机制", atMs: 10_000, durationMs: 5000, severity: "warning", source: "manual", note: "旧备注" }],
    cooldowns: [{ id: "old", name: "旧技能", classSlug: "Priest", cooldownMs: 180_000, castTimeMs: 2500, durationMs: 8000, category: "减伤", color: "#fff" }],
    assignments: [{ id: "a1", memberId: "m1", cooldownId: "old", mechanicId: "mec", atMs: 7000, note: "", source: "manual" }],
    settings: { snapMs: 1000, zoom: 1.5, showMinorMechanics: true },
  };
  const plan = normalizePlanDocument(v1);
  assert.equal(plan.schemaVersion, 5);
  assert.equal("difficulty" in plan.encounter, false);
  assert.equal("durationMs" in plan.encounter, false);
  assert.deepEqual(plan.timelineNotes, []);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.mechanics[0].castTimeMs, 0);
  assert.equal(plan.mechanics[0].durationMs, 5000);
  assert.equal(plan.cooldowns[0].cooldownMs, 180_000);
  assert.equal(plan.cooldowns[0].durationMs, 8000);
  assert.equal(plan.cooldowns[0].dataStatus, "legacy");
  assert.equal(plan.cooldowns[0].castType, "cast");
  assert.equal(plan.cooldowns[0].castTimeMs, 2500);
  assert.equal(plan.cooldowns[0].maxCharges, 1);
  assert.deepEqual(plan.cooldowns[0].variants, []);
  assert.deepEqual(plan.memberSkillVariants, []);
  assert.equal(plan.assignments[0].targets.mode, "inherit");
  assert.equal(plan.assignments[0].offsetMs, -3000);
  assert.equal(plan.settings.referenceMaxHealth, null);
  assert.equal(plan.settings.pressureResetMs, 10_000);
});

test("distinguishes unknown null from explicit zero and validates v5 documents", () => {
  const plan = createBlankPlan();
  assert.equal(plan.schemaVersion, 5);
  assert.equal(plan.roster.length, 20);
  assert.equal("durationMs" in plan.encounter, false);
  assert.equal("snapMs" in plan.settings, false);
  assert.deepEqual(plan.timelineNotes, []);
  assert.equal(plan.roster[0].name, "成员 01");
  assert.equal(plan.roster[19].name, "成员 20");
  assert.ok(plan.roster.every((item) => item.classSlug === ""));
  assert.equal(plan.cooldowns[0].cooldownMs, 180_000);
  assert.equal(plan.cooldowns[0].dataStatus, "needs-live-check");
  assert.ok(plan.cooldowns.some((item) => item.dataStatus === "unconfigured" && item.cooldownMs == null));
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

test("ships the five 12.1 Priest pilot skills while keeping every other skill selectable but unconfigured", () => {
  const release = validateCatalogRelease(SEED_CATALOG);
  assert.equal(release.manifest.schemaVersion, 3);
  assert.equal(release.manifest.version, "builtin-seed-v3");
  assert.equal(release.manifest.gameVersion, "retail-12.1");
  const priest = release.playerSkills.filter((item) => item.classSlug === "Priest");
  assert.equal(priest.length, 5);
  assert.ok(priest.every((item) => item.dataStatus === "needs-live-check"));
  assert.equal(release.playerSkills.filter((item) => item.classSlug !== "Priest" && item.dataStatus === "unconfigured").length, 37);
  const barrier = priest.find((item) => item.id === "spell-62618")!;
  assert.deepEqual(barrier.specSlugs, ["discipline"]);
  assert.equal(barrier.cooldownMs, 180_000);
  assert.equal(barrier.effects[0].type === "damageReduction" ? barrier.effects[0].percent : null, 20);
  const hymn = priest.find((item) => item.id === "spell-64843")!;
  assert.equal(hymn.castType, "channel");
  assert.equal(hymn.castTimeMs, 5000);
  assert.equal(hymn.variants[0].overrides.cooldownMs, 120_000);
  const suppression = priest.find((item) => item.id === "spell-33206")!;
  assert.equal(suppression.variants[0].overrides.maxCharges, 2);
  assert.match(suppression.variants[0].limitations[0], /动态冷却缩减未计算/);
});

test("shows only class-wide skills before a specialization is selected", () => {
  const plan = createBlankPlan();
  const general = cooldownsForMember(plan.cooldowns, { classSlug: "Priest", specSlug: "" });
  assert.deepEqual(general.map((item) => item.id), ["spell-19236"]);
  const discipline = cooldownsForMember(plan.cooldowns, { classSlug: "Priest", specSlug: "discipline" });
  assert.deepEqual(discipline.map((item) => item.id), ["spell-62618", "spell-33206", "spell-19236"]);
  const holy = cooldownsForMember(plan.cooldowns, { classSlug: "Priest", specSlug: "holy" });
  assert.deepEqual(holy.map((item) => item.id), ["spell-64843", "spell-19236"]);
  const shadow = cooldownsForMember(plan.cooldowns, { classSlug: "Priest", specSlug: "shadow" });
  assert.deepEqual(shadow.map((item) => item.id), ["spell-19236", "spell-47585"]);
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

test("stores one variant per member and applies serial two-charge recovery", () => {
  const plan = createBlankPlan();
  plan.roster = [{ ...member("priest"), specSlug: "discipline", role: "healer" }];
  const suppression = plan.cooldowns.find((item) => item.id === "spell-33206")!;
  assert.equal(resolveCooldownForMember(plan, "priest", suppression)?.maxCharges, 1);
  setMemberSkillVariant(plan, "priest", suppression.id, "protector-of-the-frail");
  assert.equal(memberSkillVariantId(plan, "priest", suppression.id), "protector-of-the-frail");
  const resolved = resolveCooldownForMember(plan, "priest", suppression)!;
  assert.equal(resolved.maxCharges, 2);
  assert.equal(resolved.selectedVariant?.name, "Protector of the Frail");
  assert.match(resolved.limitations.join(" "), /动态冷却缩减未计算/);
  plan.assignments = [
    assignment("charge-1", "priest", suppression.id, 0),
    assignment("charge-2", "priest", suppression.id, 1000),
    assignment("too-early-1", "priest", suppression.id, 2000),
    assignment("charge-3", "priest", suppression.id, 180_000),
    assignment("too-early-2", "priest", suppression.id, 181_000),
    assignment("charge-4", "priest", suppression.id, 360_000),
  ];
  const cooldownWarnings = detectConflicts(plan).filter((item) => item.type === "cooldown");
  assert.deepEqual(cooldownWarnings.map((item) => item.assignmentId), ["too-early-1", "too-early-2"]);
});

test("starts channel effects immediately while keeping the caster occupied", () => {
  const plan = createBlankPlan();
  plan.roster = [member("m1")];
  plan.mechanics = [mechanic("during-channel", 1000, 100)];
  plan.cooldowns = [
    cooldown("channel", [{ type: "damageReduction", percent: 50, schools: ["magic"] }], { castType: "channel", castTimeMs: 5000, durationMs: 5000 }),
    cooldown("instant", [], { castType: "instant", castTimeMs: 0 }),
  ];
  plan.assignments = [assignment("channel-use", "m1", "channel", 0), assignment("overlap", "m1", "instant", 1000)];
  assert.equal(calculateMechanicPressure(plan)[0].members[0].currentDamage, 50);
  assert.ok(detectConflicts(plan).some((item) => item.assignmentId === "overlap" && item.type === "cast"));
});

test("warns instead of deleting a skill after the member specialization changes", () => {
  const plan = createBlankPlan();
  plan.roster = [{ ...member("priest"), specSlug: "holy", role: "healer" }];
  plan.assignments = [assignment("barrier", "priest", "spell-62618")];
  assert.ok(detectConflicts(plan).some((item) => item.assignmentId === "barrier" && item.type === "ownership" && /专精/.test(item.message)));
  assert.equal(plan.assignments.length, 1);
});

test("requires a live or Blizzard source plus a community cross-check before verified status", () => {
  const release = structuredClone(validateCatalogRelease(SEED_CATALOG));
  const barrier = release.playerSkills.find((item) => item.id === "spell-62618")!;
  barrier.dataStatus = "verified";
  barrier.verification = { gameVersion: barrier.gameVersion, checkedAt: Date.now(), clientBuild: "12.1.0", sources: [{ kind: "in-game", label: "正式服客户端" }] };
  assert.throws(() => validateCatalogRelease(release), /社区复核/);
  barrier.verification.sources.push({ kind: "community", label: "Wowhead", url: "https://www.wowhead.com/ptr/spell=62618/power-word-barrier" });
  assert.doesNotThrow(() => validateCatalogRelease(release));
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

test("catalog presets snapshot referenced mechanics and preserve player-owned scope", () => {
  const plan = createBlankPlan("当前计划");
  plan.groups = [{ id: "g1", name: "左场", color: "#f00" }];
  plan.roster = [member("m1", "Priest", "g1")];
  plan.assignments = [assignment("a1", "m1", plan.cooldowns[0].id)];
  setMemberSkillVariant(plan, "m1", "spell-33206", "protector-of-the-frail");
  const release = validateCatalogRelease(SEED_CATALOG);
  assert.equal(release.manifest.schemaVersion, 3);
  const preset = release.timelinePresets[0];
  const applied = applyCatalogPreset(plan, release, preset);
  assert.equal(applied.encounter.name, "基础机制示例");
  assert.equal(applied.phases[0].id, "preset-phase-p1");
  assert.deepEqual(applied.mechanics.map((item) => item.name), ["集合", "分散", "转阶段", "分组站位"]);
  assert.ok(applied.mechanics.every((item) => item.damage.directAmount == null && item.damage.periodicAmount == null));
  assert.deepEqual(applied.roster, plan.roster);
  assert.deepEqual(applied.groups, plan.groups);
  assert.deepEqual(applied.cooldowns.map((item) => item.id), release.playerSkills.map((item) => item.id));
  assert.deepEqual(applied.assignments, []);
  assert.deepEqual(applied.memberSkillVariants, []);
  assert.deepEqual(applied.timelineNotes, preset.timelineNotes);
  assert.equal(applied.catalogSource?.version, release.manifest.version);
  const broken = structuredClone(release);
  broken.timelinePresets[0].mechanics[0].mechanicId = "missing";
  assert.throws(() => validateCatalogRelease(broken), /不存在的机制/);
});

test("only offers a catalog upgrade for real built-in skill differences", () => {
  const plan = createBlankPlan();
  const release = validateCatalogRelease(SEED_CATALOG);
  assert.deepEqual(catalogDifference(plan, release), {
    addedSkills: 0,
    changedSkills: 0,
    removedSkills: 0,
    currentVersion: "未记录",
    availableVersion: release.manifest.version,
  });
  const changed = structuredClone(release);
  changed.playerSkills[0].description += " 更新";
  assert.equal(catalogDifference(plan, changed).changedSkills, 1);
  plan.cooldowns[0].dataStatus = "custom";
  assert.equal(catalogDifference(plan, changed).changedSkills, 0);
});

test("migrates existing v2, v3, and v4 plans to v5 locally", () => {
  const source = structuredClone(createBlankPlan()) as unknown as Record<string, unknown>;
  source.schemaVersion = 2;
  source.encounter = { name: "旧计划", difficulty: "史诗", durationMs: 600_000 };
  source.settings = { snapMs: 5000, showMinorMechanics: true, referenceMaxHealth: null, pressureResetMs: 10_000, defensiveLeadMs: 3000 };
  const oldSkill = (source.cooldowns as Array<Record<string, unknown>>)[0];
  oldSkill.castTimeMs = 2500;
  delete oldSkill.castType;
  delete oldSkill.maxCharges;
  delete oldSkill.variants;
  delete oldSkill.limitations;
  delete oldSkill.verification;
  const migrated = normalizePlanDocument(source);
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.encounter.name, "旧计划");
  assert.equal("difficulty" in migrated.encounter, false);
  assert.equal("durationMs" in migrated.encounter, false);
  assert.equal("snapMs" in migrated.settings, false);
  assert.equal(migrated.cooldowns[0].castType, "cast");
  assert.equal(migrated.cooldowns[0].castTimeMs, 2500);
  assert.equal(migrated.cooldowns[0].maxCharges, 1);
  assert.deepEqual(migrated.cooldowns[0].variants, []);
  source.schemaVersion = 3;
  assert.equal(normalizePlanDocument(source).schemaVersion, 5);
  source.schemaVersion = 4;
  assert.equal(normalizePlanDocument(source).schemaVersion, 5);
});

test("migrates v1 and v2 catalogs to v3 without difficulty or fixed preset duration", () => {
  const legacy = structuredClone(SEED_CATALOG) as unknown as {
    manifest: { schemaVersion: number; version: string };
    bossMechanics: Array<Record<string, unknown>>;
    timelinePresets: Array<Record<string, unknown>>;
  };
  legacy.manifest.schemaVersion = 1;
  legacy.manifest.version = "legacy-v1";
  legacy.bossMechanics[0].difficulties = ["史诗"];
  legacy.timelinePresets[0].difficulties = ["史诗"];
  legacy.timelinePresets[0].encounter = { name: "旧预设", difficulty: "史诗", durationMs: 600_000 };
  delete legacy.timelinePresets[0].timelineNotes;
  const migrated = validateCatalogRelease(legacy);
  assert.equal(migrated.manifest.schemaVersion, 3);
  assert.equal("difficulties" in migrated.bossMechanics[0], false);
  assert.equal("difficulties" in migrated.timelinePresets[0], false);
  assert.deepEqual(migrated.timelinePresets[0].encounter, { name: "旧预设" });
  assert.deepEqual(migrated.timelinePresets[0].timelineNotes, []);
  assert.equal(migrated.playerSkills[0].maxCharges, 1);
  assert.ok(["instant", "cast", "channel", "unknown"].includes(migrated.playerSkills[0].castType));
});

test("generates exact base62 publication identifiers without modulo bias", () => {
  let seed = 0;
  const random = (array: Uint8Array) => {
    for (let index = 0; index < array.length; index += 1) array[index] = (seed++ * 31) % 256;
    return array;
  };
  const shareId = randomBase62(16, random);
  const editId = randomBase62(4, random);
  assert.equal(shareId.length, 16);
  assert.equal(editId.length, 4);
  assert.match(shareId, SHARE_ID_PATTERN);
  assert.match(editId, EDIT_ID_PATTERN);
});

test("keeps 30 checkpoints per plan, then enforces the global byte ceiling oldest-first", () => {
  const snapshots = Array.from({ length: 33 }, (_, index) => ({ id: `a-${index}`, planId: "a", createdAt: index, bytes: 10 }));
  snapshots.push({ id: "b-old", planId: "b", createdAt: 100, bytes: 80 });
  snapshots.push({ id: "b-new", planId: "b", createdAt: 101, bytes: 80 });
  const result = snapshotIdsToDelete(snapshots, 30, 350);
  assert.ok(result.ids.has("a-0") && result.ids.has("a-1") && result.ids.has("a-2"));
  assert.ok(result.ids.has("a-3"));
  assert.ok(result.retainedBytes <= 350);
  assert.equal(result.ids.has("b-new"), false);
  assert.equal(isExpectedRevision(4, 4), true);
  assert.equal(isExpectedRevision(5, 4), false);
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
  assert.equal(zoomFromWheel(MAX_ZOOM, -1), MAX_ZOOM);
  assert.equal(shouldInterceptTimelineWheel(true, true), true);
  assert.equal(shouldInterceptTimelineWheel(false, true), false);
  assert.equal(shouldInterceptTimelineWheel(true, false), false);
  assert.equal(anchoredScroll(100, 50, 1, 2), 250);
  assert.equal(timeAxisPosition(2000, 5), 10);
  assert.equal(timelineTimeFromDrag(30_000, 13, 5, 3_600_000), 33_000);
  assert.equal(timelineTimeFromDrag(1000, -100, 5, 3_600_000), 0);
  assert.equal(timelineTimeFromDrag(3_599_000, 100, 5, 3_600_000), 3_600_000);
});

test("derives and shortens the timeline range from every timed object", () => {
  const plan = createBlankPlan();
  plan.phases = [{ id: "p1", name: "P1", atMs: 0 }];
  plan.timelineNotes = [];
  plan.mechanics = [];
  plan.assignments = [];
  assert.equal(timelineRangeMs(plan), MIN_TIMELINE_MS);
  plan.timelineNotes = [{ id: "n1", text: "转火", atMs: 121_000 }];
  assert.equal(timelineRangeMs(plan), 180_000);
  plan.timelineNotes = [];
  assert.equal(timelineRangeMs(plan), MIN_TIMELINE_MS);
  plan.mechanics = [mechanic("long", 115_000, null, ALL_TARGETS, { castTimeMs: 5000, durationMs: 31_000 })];
  assert.equal(timelineRangeMs(plan), 210_000);
  plan.cooldowns = [cooldown("lasting", [], { castTimeMs: 2000, durationMs: 40_000 })];
  plan.assignments = [assignment("a", "m1", "lasting", 160_000)];
  assert.equal(timelineRangeMs(plan), 240_000);
  plan.timelineNotes = [{ id: "limit", text: "上限", atMs: 7_200_000 }];
  assert.equal(timelineRangeMs(plan), 7_200_000);
  assert.ok(adaptiveTickMs(8) < adaptiveTickMs(0.2));
});
