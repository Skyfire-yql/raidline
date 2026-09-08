import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyCatalogPreset, SEED_CATALOG, validateCatalogRelease } from "../lib/catalog.ts";
import {
  buildTimelineScene,
  createBlankPlan,
  detectConflicts,
  deleteRosterMember,
  exportPlan,
  moveAnchorTo,
  parsePlanDocument,
  resolveDirectiveTime,
  resolveMemberIds,
  resolveMechanicPoint,
  resolveSkillTargets,
  resolveTimelineAnchor,
  validatePlanSemantics,
} from "../lib/core.ts";
import { MechanicTimelinePresentationSchema, parseCombatLogSnapshot, parseComparisonRun, parseConversionProfile, parsePlanImportDraft } from "../lib/domain/schema.ts";
import { isExpectedRevision, snapshotIdsToDelete } from "../lib/local-policy.ts";
import { createFileObjectStore } from "../lib/object-store.ts";
import { assertEditId, assertShareId, randomBase62 } from "../lib/publication-ids.ts";
import { resolveSkillForAssignment, skillTimelineDurationMs } from "../lib/skills.ts";
import type { CombatLogSnapshot, EncounterConversionProfile, MechanicDefinitionSnapshot, PlayerSkillDefinition, RaidPlanDocument } from "../lib/types.ts";
import { acceptNormalizedWclSnapshot, UnsupportedDifficultyError } from "../lib/wcl-contract.ts";
import { adaptiveTickMs, anchoredScroll, clampZoom, defaultOrientation, layoutMechanicLanes, mechanicPresentationPartKey, timelineContentEnd, timelineRangeMs, timelineTimeFromDrag, zoomFromWheel } from "../lib/view.ts";
import type { TimelineSceneMechanic } from "../lib/domain/view-model.ts";

const uuid = () => crypto.randomUUID();

function skillSnapshot(id = uuid()): PlayerSkillDefinition {
  return {
    id,
    spellId: 1001,
    name: "测试屏障",
    description: "团队减伤",
    gameVersion: "retail-12.1",
    classSlug: "Priest",
    specSlugs: ["discipline"],
    scope: "team",
    cooldownMs: 180_000,
    castType: "cast",
    castTimeMs: 2000,
    durationMs: 10_000,
    maxCharges: 1,
    observedSpells: [],
    limitations: [],
    category: "团队减伤",
    color: "#e7e7e7",
    dataStatus: "needs-live-check",
  };
}

function mechanicSnapshot(id = uuid()): MechanicDefinitionSnapshot {
  return {
    id,
    name: "毁灭冲击",
    description: "测试机制",
    gameVersion: "retail-12.1",
    abilityGameIds: [2001],
    castTimeMs: 3000,
    durationMs: 5000,
    timelinePresentation: { parts: [
      { kind: "interval", from: "cast-start", to: "impact", tone: "warning", text: "毁灭冲击" },
      { kind: "marker", at: "impact", tone: "judgment", text: "伤害判定" },
      { kind: "interval", from: "impact", to: "end", tone: "active", text: "余波" },
    ] },
    color: "#cf3e3e",
    dataStatus: "needs-live-check",
    limitations: [],
  };
}

function populatedPlan(): RaidPlanDocument {
  const plan = createBlankPlan("vNext 样板");
  plan.encounter.name = "测试首领";
  plan.encounter.gameVersion = "retail-12.1";
  const priest = { id: uuid(), name: "白牧", classSlug: "Priest", specSlug: "discipline", role: "healer" as const, color: "#e7e7e7" };
  const warrior = { id: uuid(), name: "战士", classSlug: "Warrior", specSlug: "protection", role: "tank" as const, color: "#c69b6d" };
  const skill = SEED_CATALOG.playerSkills.find(item => item.spellId === 62618)!;
  const mechanic = mechanicSnapshot();
  const occurrenceId = uuid();
  const p2 = { id: uuid(), name: "P2", ordinal: 2, estimatedStartMs: 60_000 };
  plan.roster.members.push(priest, warrior);
  plan.definitions.mechanics.push(mechanic);
  plan.timeline.phases.push(p2);
  plan.timeline.mechanics.push({ id: occurrenceId, definitionId: mechanic.id, anchor: { kind: "phase", phaseId: p2.id, offsetMs: 10_000 } });
  plan.timeline.directives.push(
    { id: uuid(), kind: "task", text: "集合减伤", scope: { kind: "phase", phaseId: p2.id }, assignees: { kind: "members", memberIds: [priest.id] }, durationMs: null },
    { id: uuid(), kind: "note", text: "全局说明", scope: { kind: "plan" }, durationMs: null },
    { id: uuid(), kind: "note", text: "冲击前散开", scope: { kind: "timed", anchor: { kind: "phase", phaseId: p2.id, offsetMs: 11000 } }, durationMs: null },
  );
  plan.timeline.skillAssignments.push({ id: uuid(), memberId: priest.id, skillDefinitionId: skill.id, anchor: { kind: "pull", offsetMs: 68000 }, targets: { kind: "all" }, note: "覆盖冲击" });
  return parsePlanDocument(plan);
}

test("v1 plan is strict, round-trips, and rejects removed or unknown structure", () => {
  const plan = populatedPlan();
  assert.deepEqual(parsePlanDocument(JSON.parse(JSON.stringify(plan))), plan);
  assert.throws(() => parsePlanDocument({ ...plan, schemaVersion: 5 }), /不支持的计划版本/);
  assert.throws(() => parsePlanDocument({ ...plan, unexpected: true }));
  const bad = structuredClone(plan) as RaidPlanDocument & { settings?: object };
  bad.settings = { snapMs: 1000 };
  assert.throws(() => parsePlanDocument(bad));
  const unaligned = structuredClone(plan);
  unaligned.timeline.phases[1].estimatedStartMs = 60_001;
  assert.throws(() => parsePlanDocument(unaligned));
  const duplicate = structuredClone(plan);
  duplicate.timeline.directives[0].id = duplicate.timeline.phases[0].id;
  assert.throws(() => parsePlanDocument(duplicate), /重复的实体 ID/);
  const oversized = structuredClone(plan);
  oversized.timeline.directives = Array.from({ length: 2000 }, () => ({ id: uuid(), kind: "note" as const, text: "x".repeat(600), scope: { kind: "plan" as const }, durationMs: null }));
  assert.throws(() => parsePlanDocument(oversized), /1 MB/);
});

test("semantic validation rejects duplicate IDs while preserving non-blocking mismatch warnings", () => {
  const plan = populatedPlan();
  plan.timeline.directives[0].id = plan.timeline.phases[0].id;
  assert.ok(validatePlanSemantics(plan).some((item) => item.code === "DUPLICATE_ID" && item.severity === "error"));
  plan.timeline.directives[0].id = uuid();
  plan.roster.members[0].classSlug = "Mage";
  assert.ok(validatePlanSemantics(plan).some((item) => item.code === "SKILL_MEMBER_MISMATCH" && item.severity === "warning"));
});

test("removed features cannot re-enter persisted plans", () => {
  const plan = populatedPlan();
  const change = (fn: (value: Record<string, unknown>) => void) => {
    const value = structuredClone(plan) as unknown as Record<string, unknown>;
    fn(value);
    assert.throws(() => parsePlanDocument(value));
  };
  change(value => { (value.definitions as Record<string, unknown>).skills = []; });
  change(value => { (value.roster as Record<string, unknown>).groups = []; });
  change(value => { (value.roster as Record<string, unknown>).memberSkills = []; });
  const task = { ...plan.timeline.directives[0], reminder: { leadMs: 5000 } };
  assert.throws(() => parsePlanDocument({ ...plan, timeline: { ...plan.timeline, directives: [task] } }));
  const assignment = { ...plan.timeline.skillAssignments[0], variantId: uuid() };
  assert.throws(() => parsePlanDocument({ ...plan, timeline: { ...plan.timeline, skillAssignments: [assignment] } }));
  const bound = { ...plan.timeline.skillAssignments[0], anchor: { kind: "mechanic", mechanicOccurrenceId: plan.timeline.mechanics[0].id, point: "impact", offsetMs: 0 } };
  assert.throws(() => parsePlanDocument({ ...plan, timeline: { ...plan.timeline, skillAssignments: [bound] } }));
});

test("phase-relative assignments float with the phase and are independent of mechanics", () => {
  const plan = populatedPlan();
  const assignment = plan.timeline.skillAssignments[0];
  assignment.anchor = { kind: "phase", phaseId: plan.timeline.phases[1].id, offsetMs: 8000 };
  plan.timeline.mechanics = [];
  assert.deepEqual(resolveTimelineAnchor(plan, assignment.anchor), { ok: true, atMs: 68000 });
  plan.timeline.phases[1].estimatedStartMs = 90000;
  assert.deepEqual(resolveTimelineAnchor(plan, assignment.anchor), { ok: true, atMs: 98000 });
  assert.equal(buildTimelineScene(plan).assignments[0].atMs, 98000);
});

test("deleting a member removes owned casts and references without deleting tasks or other members", () => {
  const plan = populatedPlan();
  const [priest, warrior] = plan.roster.members;
  const other = { ...plan.timeline.skillAssignments[0], id: uuid(), memberId: warrior.id, targets: { kind: "members" as const, memberIds: [priest.id, warrior.id] } };
  plan.timeline.skillAssignments.push(other);
  deleteRosterMember(plan, priest.id);
  assert.deepEqual(plan.roster.members.map(item => item.id), [warrior.id]);
  assert.deepEqual(plan.timeline.skillAssignments.map(item => item.id), [other.id]);
  assert.deepEqual(resolveSkillTargets(plan, other), [warrior.id]);
  assert.deepEqual(resolveMemberIds(plan, { kind: "all" }), [warrior.id]);
  const task = plan.timeline.directives[0];
  const diagnostic = validatePlanSemantics(plan).find(item => item.code === "EMPTY_ASSIGNEES")!;
  assert.equal(diagnostic.objectId, task.id);
  assert.equal(diagnostic.objectType, "directive");
  assert.equal(validatePlanSemantics(plan).some(item => item.code === "MISSING_MEMBER"), false);
  assert.deepEqual(parsePlanDocument(JSON.parse(JSON.stringify(plan))), plan);
});

test("missing member, skill and phase diagnostics point to the assignment that can be repaired", () => {
  const plan = populatedPlan();
  const item = plan.timeline.skillAssignments[0];
  item.memberId = uuid(); item.skillDefinitionId = uuid(); item.anchor = { kind: "phase", phaseId: uuid(), offsetMs: 0 };
  const diagnostics = validatePlanSemantics(plan).filter(diagnostic => diagnostic.objectId === item.id);
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code).sort(), ["MISSING_MEMBER", "MISSING_PHASE", "MISSING_SKILL_DEFINITION"]);
  assert.ok(diagnostics.every(diagnostic => diagnostic.objectType === "assignment"));
  item.memberId = plan.roster.members[0].id;
  item.skillDefinitionId = SEED_CATALOG.playerSkills.find(skill => skill.spellId === 62618)!.id;
  item.anchor = { kind: "pull", offsetMs: 68000 };
  assert.equal(validatePlanSemantics(plan).some(diagnostic => diagnostic.objectId === item.id), false);
});

test("global library updates reach existing plans, scenes and export without modifying plan bytes", () => {
  const plan = populatedPlan();
  const copy = parsePlanDocument(JSON.parse(JSON.stringify(plan)));
  const before = JSON.stringify(plan);
  const assignment = plan.timeline.skillAssignments[0];
  const library = structuredClone(SEED_CATALOG.playerSkills);
  const updated = library.find(item => item.id === assignment.skillDefinitionId)!;
  updated.name = "全局技能名称"; updated.cooldownMs = 60000;
  assert.equal(resolveSkillForAssignment(assignment, library)?.cooldownMs, 60000);
  assert.equal(buildTimelineScene(copy, library).assignments[0].name, "全局技能名称");
  assert.match(exportPlan({ target: "mrt-reading", document: copy, skillLibrary: library }).text, /白牧 — 全局技能名称/);
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(copy, plan);
  assert.equal(plan.sources.length, 0);
});

test("cooldown checks use the global minimum and ignore overlapping unrelated casts", () => {
  const plan = populatedPlan();
  const base = plan.timeline.skillAssignments[0];
  const spell = SEED_CATALOG.playerSkills.find(item => item.spellId === 64843)!;
  assert.equal(spell.cooldownMs, 120000);
  plan.timeline.skillAssignments = [0, 120000, 239000].map(offsetMs => ({ ...base, id: uuid(), skillDefinitionId: spell.id, anchor: { kind: "pull", offsetMs } }));
  const warnings = detectConflicts(plan);
  assert.deepEqual(warnings.map(item => item.assignmentId), [plan.timeline.skillAssignments[2].id]);
  plan.timeline.skillAssignments = [base, { ...base, id: uuid(), skillDefinitionId: spell.id }];
  assert.deepEqual(detectConflicts(plan), []);
  const ultimate = SEED_CATALOG.playerSkills.find(item => item.spellId === 421453)!;
  plan.timeline.skillAssignments = [{ ...base, skillDefinitionId: ultimate.id, anchor: { kind: "pull", offsetMs: 10000 } }];
  const scene = buildTimelineScene(plan).assignments[0];
  assert.equal(scene.atMs, 10000);
  assert.equal(scene.durationMs, 8000);
  assert.equal("effectStartMs" in scene, false);
  assert.equal("castTimeMs" in scene, false);
});

test("documented cooldown reductions without former variants allow casts at the minimum", () => {
  const plan = populatedPlan();
  const base = plan.timeline.skillAssignments[0];
  for (const [spellId, cooldownMs] of [[48743, 90000], [31821, 150000], [22812, 45600]]) {
    const skill = SEED_CATALOG.playerSkills.find(item => item.spellId === spellId)!;
    assert.equal(skill.cooldownMs, cooldownMs);
    const allowedAt = Math.ceil(cooldownMs / 1000) * 1000;
    plan.timeline.skillAssignments = [0, allowedAt - 1000, allowedAt].map(offsetMs => ({ ...base, id: uuid(), skillDefinitionId: skill.id, anchor: { kind: "pull", offsetMs } }));
    assert.deepEqual(detectConflicts(plan).map(item => item.assignmentId), [plan.timeline.skillAssignments[1].id]);
  }
  const brew = SEED_CATALOG.playerSkills.find(item => item.spellId === 322507)!;
  plan.timeline.skillAssignments = [0, 0, 0, 72000].map(offsetMs => ({ ...base, id: uuid(), skillDefinitionId: brew.id, anchor: { kind: "pull", offsetMs } }));
  assert.deepEqual(detectConflicts(plan).map(item => item.assignmentId), [plan.timeline.skillAssignments[2].id]);
});

test("timeline anchors resolve pull, phase and all mechanic points", () => {
  const plan = populatedPlan();
  const occurrence = plan.timeline.mechanics[0];
  assert.deepEqual(resolveTimelineAnchor(plan, { kind: "pull", offsetMs: 12_000 }), { ok: true, atMs: 12_000 });
  assert.deepEqual(resolveTimelineAnchor(plan, { kind: "phase", phaseId: plan.timeline.phases[1].id, offsetMs: -5000 }), { ok: true, atMs: 55_000 });
  assert.deepEqual(resolveMechanicPoint(plan, occurrence.id, "cast-start"), { ok: true, atMs: 70_000 });
  assert.deepEqual(resolveMechanicPoint(plan, occurrence.id, "impact"), { ok: true, atMs: 73_000 });
  assert.deepEqual(resolveMechanicPoint(plan, occurrence.id, "end"), { ok: true, atMs: 78_000 });
});

test("dragging changes only the current anchor offset", () => {
  const plan = populatedPlan();
  const occurrence = plan.timeline.mechanics[0];
  const movedPhase = moveAnchorTo(plan, occurrence.anchor, 80_000);
  assert.equal(movedPhase.kind, "phase");
  assert.equal(movedPhase.kind === "phase" ? movedPhase.offsetMs : 0, 20_000);
  const mechanicAnchor = plan.timeline.skillAssignments[0].anchor;
  const movedMechanic = moveAnchorTo(plan, mechanicAnchor, 70_000);
  assert.equal(movedMechanic.kind, "pull");
  assert.equal(movedMechanic.offsetMs, 70000);
});

test("timeline scene derives range with 30 second tail, 2 minute floor and 120 minute cap", () => {
  const blank = createBlankPlan();
  assert.equal(buildTimelineScene(blank).durationMs, 120_000);
  const plan = populatedPlan();
  plan.timeline.directives.push({ id: uuid(), kind: "note", text: "远端", scope: { kind: "timed", anchor: { kind: "pull", offsetMs: 121_000 } }, durationMs: null });
  assert.equal(buildTimelineScene(plan).durationMs, 180_000);
  plan.timeline.directives.at(-1)!.scope = { kind: "timed", anchor: { kind: "pull", offsetMs: 7_200_000 } };
  assert.equal(buildTimelineScene(plan).durationMs, 7_200_000);
  plan.timeline.directives.pop();
  assert.ok(buildTimelineScene(plan).durationMs < 180_000);
});

test("tasks and notes preserve distinct scopes and export unsupported phase triggers visibly", () => {
  const plan = populatedPlan();
  const phaseTask = plan.timeline.directives.find((item) => item.kind === "task")!;
  const timedNote = plan.timeline.directives.find((item) => item.kind === "note" && item.scope.kind === "timed")!;
  assert.equal(resolveDirectiveTime(plan, phaseTask)?.ok, true);
  assert.equal(resolveDirectiveTime(plan, timedNote)?.ok, true);
  const result = exportPlan({ target: "mrt-reading", document: plan });
  assert.equal(result.text.includes("vNext 样板 · 测试首领"), true);
  assert.equal(result.text.includes("集合减伤"), true);
  assert.equal(result.text.includes("冲击前散开"), true);
  assert.ok(result.diagnostics.some((item) => item.code === "PHASE_TASK_AS_SECTION"));
});

test("empty task assignees block export but source loss only warns", () => {
  const plan = populatedPlan();
  const task = plan.timeline.directives.find((item) => item.kind === "task")!;
  if (task.kind === "task") task.assignees = { kind: "members", memberIds: [] };
  const blocked = exportPlan({ target: "mrt-reading", document: plan });
  assert.ok(blocked.diagnostics.some((item) => item.code === "EMPTY_ASSIGNEES" && item.severity === "error"));
  const sourceId = uuid();
  plan.timeline.skillAssignments[0].origin = { sourceId };
  assert.ok(validatePlanSemantics(plan).some((item) => item.code === "MISSING_SOURCE" && item.severity === "warning"));
});

test("skill spans start at the cast anchor without asserting effect or busy windows", () => {
  const cast = skillSnapshot();
  assert.equal(skillTimelineDurationMs(cast), 12_000);
  cast.castType = "channel"; cast.castTimeMs = 5000;
  assert.equal(skillTimelineDurationMs(cast), 10_000);
});

test("serial charge recovery allows two immediate uses and warns on the third", () => {
  const plan = populatedPlan();
  const base = plan.timeline.skillAssignments[0];
  plan.timeline.skillAssignments = [0, 1000, 2000].map((offset) => ({ ...structuredClone(base), id: uuid(), anchor: { kind: "pull" as const, offsetMs: 20_000 + offset } }));
  const library = [{ ...skillSnapshot(base.skillDefinitionId), maxCharges: 2, cooldownMs: 90000 }];
  const cooldownWarnings = detectConflicts(plan, library).filter((item) => item.type === "cooldown");
  assert.equal(cooldownWarnings.length, 1);
  assert.equal(cooldownWarnings[0].assignmentId, plan.timeline.skillAssignments[2].id);
});

test("catalog v1 seed is strict and presets copy snapshot definitions into an isolated plan", () => {
  const release = validateCatalogRelease(SEED_CATALOG);
  assert.equal(release.manifest.schemaVersion, 1);
  assert.equal(release.manifest.version, "builtin-seed-v7");
  assert.equal(release.playerSkills.length, 72);
  assert.equal(release.playerSkills.filter(skill => skill.enabled).length, 72);
  assert.equal(release.bossMechanics.length, 13);
  assert.equal(release.timelinePresets.length, 2);

  const preset = release.timelinePresets[0];
  const plan = applyCatalogPreset(createBlankPlan(), release, preset);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.templateSourceId, plan.sources[0].id);
  assert.deepEqual(plan.roster.members, []);
  assert.deepEqual(plan.timeline.skillAssignments, []);
  assert.ok(plan.definitions.mechanics.length > 0);
  assert.equal("skills" in plan.definitions, false);
  const originalName = release.bossMechanics.find((item) => item.id === plan.definitions.mechanics[0].id)!.name;
  plan.definitions.mechanics[0].name = "计划内修改";
  assert.equal(release.bossMechanics.find((item) => item.id === plan.definitions.mechanics[0].id)!.name, originalName);
  const legacy = structuredClone(release) as unknown as { manifest: { schemaVersion: number } };
  legacy.manifest.schemaVersion = 3;
  assert.throws(() => validateCatalogRelease(legacy));
});

test("live Vashnik preset is an offline catalog snapshot built from the cross-sample canonical timeline", () => {
  const release = validateCatalogRelease(SEED_CATALOG);
  const preset = release.timelinePresets.find((item) => item.encounter.externalIds?.wclEncounterId === 3455);
  assert.ok(preset);
  assert.equal(preset.enabled, true);
  assert.equal(preset.encounter.externalIds?.wclZoneId, 53);
  assert.deepEqual(preset.phases.map((phase) => [phase.name, phase.ordinal, phase.estimatedStartMs]), [["P1", 1, 0]]);
  assert.equal(preset.mechanics.length, 76);
  assert.equal(preset.notes.length, 1);

  const plan = applyCatalogPreset(createBlankPlan(), release, preset);
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].kind, "catalog");
  assert.equal(plan.sources.some((source) => source.kind === "combat-log"), false);
  assert.equal(plan.definitions.mechanics.length, 8);
  assert.equal(plan.timeline.mechanics.length, 76);
  assert.equal(plan.timeline.directives.length, 1);
  assert.equal(plan.roster.members.length, 0);
  assert.equal(plan.timeline.skillAssignments.length, 0);
  assert.ok(plan.timeline.mechanics.every((occurrence) => occurrence.anchor.offsetMs % 1000 === 0));

  const scene = buildTimelineScene(plan);
  assert.equal(scene.durationMs, 480_000);
  assert.equal(scene.mechanics.at(-1)?.atMs, 447_000);
  assert.deepEqual(
    scene.mechanics.filter((mechanic) => mechanic.typeName === "毒性蒸汽").map((mechanic) => mechanic.displayLabel),
    ["×1", "×2", "×3", "×4", "×5", "×6", "×7"],
  );
  assert.equal(scene.mechanics.some((mechanic) => mechanic.typeName === "虹吸感染"), false);
  assert.ok(release.bossMechanics.some((mechanic) => mechanic.name === "虹吸感染" && mechanic.enabled));
});

test("mechanic timeline presentation is strict and rejects invalid or duplicate parts", () => {
  const valid = { parts: [
    { kind: "interval", from: "cast-start", to: "impact", tone: "warning", text: "读条" },
    { kind: "marker", at: "impact", tone: "judgment", text: "判定" },
  ] };
  assert.deepEqual(MechanicTimelinePresentationSchema.parse(valid), valid);
  assert.throws(() => MechanicTimelinePresentationSchema.parse({ parts: [] }));
  assert.throws(() => MechanicTimelinePresentationSchema.parse({ parts: [{ kind: "interval", from: "end", to: "impact", tone: "warning", text: "反向" }] }));
  assert.throws(() => MechanicTimelinePresentationSchema.parse({ parts: [valid.parts[0], valid.parts[0]] }));
  assert.throws(() => MechanicTimelinePresentationSchema.parse({ parts: [{ kind: "marker", at: "impact", tone: "point", text: "A" }, { kind: "marker", at: "impact", tone: "judgment", text: "B" }] }));
  assert.throws(() => MechanicTimelinePresentationSchema.parse({ parts: [{ kind: "marker", at: "impact", tone: "point", text: "A", unexpected: true }] }));
  const plan = structuredClone(populatedPlan()) as unknown as { definitions: { mechanics: Array<Partial<MechanicDefinitionSnapshot>> } };
  delete plan.definitions.mechanics[0].timelinePresentation;
  assert.throws(() => parsePlanDocument(plan));
});

test("mechanic lanes support minimal collision stacking and stable definition tracks", () => {
  const mechanic = (id: string, definitionId: string, typeName: string, atMs: number, endMs = atMs): TimelineSceneMechanic => ({
    id,
    definitionId,
    typeName,
    name: typeName,
    displayLabel: undefined,
    description: "",
    atMs,
    impactMs: atMs,
    endMs,
    castTimeMs: 0,
    durationMs: endMs - atMs,
    color: "#fff",
    presentationParts: endMs > atMs
      ? [{ index: 0, kind: "interval", tone: "active", text: typeName, startMs: atMs, endMs }]
      : [{ index: 0, kind: "marker", tone: "judgment", text: typeName, atMs }],
  });
  const mechanics = [
    mechanic("alpha-1", "alpha", "Alpha", 0, 10_000),
    mechanic("beta-1", "beta", "Beta", 5_000),
    mechanic("alpha-2", "alpha", "Alpha", 13_000),
  ];

  const compact = layoutMechanicLanes(mechanics, "compact", "vertical", 10);
  assert.equal(compact.lanes.length, 2);
  assert.equal(compact.laneByMechanicId.get("alpha-1"), 0);
  assert.equal(compact.laneByMechanicId.get("beta-1"), 1);
  assert.equal(compact.laneByMechanicId.get("alpha-2"), 0);

  const fixed = layoutMechanicLanes(mechanics, "by-type", "horizontal", 1);
  assert.deepEqual(fixed.lanes.map((lane) => [lane.key, lane.label, lane.mechanicCount]), [["alpha", "Alpha", 2], ["beta", "Beta", 1]]);
  assert.equal(fixed.laneByMechanicId.get("alpha-1"), fixed.laneByMechanicId.get("alpha-2"));
  assert.notEqual(fixed.laneByMechanicId.get("alpha-1"), fixed.laneByMechanicId.get("beta-1"));

  const points = [mechanic("point-1", "point", "Point", 0), mechanic("point-2", "point", "Point", 5_000)];
  assert.equal(layoutMechanicLanes(points, "compact", "horizontal", 5).lanes.length, 2);
  assert.equal(layoutMechanicLanes(points, "compact", "horizontal", 20).lanes.length, 1);
  assert.equal(layoutMechanicLanes([mechanic("empty-name", "", "", 0)], "by-type", "horizontal", 1).lanes[0].key, "");

  const compound = mechanic("compound", "compound", "Compound", 10_000, 20_000);
  compound.presentationParts = [
    { index: 0, kind: "interval", tone: "warning", text: "Long first stage", startMs: 10_000, endMs: 18_000 },
    { index: 1, kind: "marker", tone: "judgment", text: "Long judgment", atMs: 18_000 },
    { index: 2, kind: "marker", tone: "point", text: "End point", atMs: 20_000 },
  ];
  const measurements = new Map([
    [mechanicPresentationPartKey(compound.id, 0), { axisSizePx: 100, crossSizePx: 22 }],
    [mechanicPresentationPartKey(compound.id, 1), { axisSizePx: 90, crossSizePx: 22 }],
    [mechanicPresentationPartKey(compound.id, 2), { axisSizePx: 80, crossSizePx: 22 }],
  ]);
  const compactCompound = layoutMechanicLanes([compound], "compact", "horizontal", 10, measurements);
  const compoundLayout = compactCompound.presentationByMechanicId.get(compound.id)!;
  assert.deepEqual(compoundLayout.parts.map((part) => [part.labelStartPx, part.targetAxisPx, part.labelRow]), [[100, 100, 0], [180, 180, 1], [200, 200, 0]], "stage bubbles stay left-aligned to their exact time and spill into the next label row");
  assert.equal(compoundLayout.parts[0].labelMaxAxisSizePx, 94, "a crowded prior bubble is truncated before it can overlap the next exact-time bubble");
  assert.equal(compactCompound.lanes[0].crossSizePx, 70, "an extra label row increases only the affected compact track");
  const verticalCompound = structuredClone(compound);
  verticalCompound.presentationParts = verticalCompound.presentationParts.slice(0, 2);
  const vertical = layoutMechanicLanes([verticalCompound], "compact", "vertical", 10, new Map([
    [mechanicPresentationPartKey(compound.id, 0), { axisSizePx: 22, crossSizePx: 220 }],
    [mechanicPresentationPartKey(compound.id, 1), { axisSizePx: 22, crossSizePx: 120 }],
  ]));
  assert.equal(vertical.lanes[0].crossSizePx, 244, "vertical compact tracks reserve the full bubble width with tighter padding");
});

function combatLogFixture(): CombatLogSnapshot {
  return {
    schemaVersion: 1,
    id: uuid(),
    provider: "wcl",
    normalizerVersion: "fixture-v1",
    importedAt: 1_800_000_000_000,
    source: { reportCode: "ABC123", fightId: 7, reportRevision: 1, reportStartEpochMs: 1_800_000_000_000, fightStartReportMs: 12_345, fightEndReportMs: 98_765, gameVersionKey: "retail-12.1" },
    encounter: { encounterId: 9001, zoneId: 42, name: "测试首领", kill: false, durationMs: 86_420 },
    actors: [{ actorKey: "player:1", reportActorId: 1, type: "player", name: "白牧", classSlug: "Priest", specSlug: "discipline" }],
    phases: [{ id: uuid(), semanticPhaseId: 1, occurrenceIndex: 1, atMs: 33_333 }],
    events: [{ eventKey: "event:1", atMs: 12_345, type: "cast-start", abilityGameId: 62618, sourceActorKey: "player:1" }],
    contentHash: "fixture-hash",
  };
}

test("WCL boundary blocks non-mythic fights before accepting a snapshot", () => {
  const fixture = combatLogFixture();
  assert.throws(() => acceptNormalizedWclSnapshot({ reportCode: "ABC123", fightId: 7, difficulty: "heroic" }, fixture), (error) => error instanceof UnsupportedDifficultyError && error.code === "UNSUPPORTED_DIFFICULTY");
  const accepted = acceptNormalizedWclSnapshot({ reportCode: "ABC123", fightId: 7, difficulty: "mythic" }, fixture);
  assert.equal(accepted.events[0].atMs, 12_345);
  assert.equal("difficulty" in accepted.encounter, false);
  assert.equal(parseCombatLogSnapshot(JSON.parse(JSON.stringify(fixture))).events[0].atMs, 12_345);
});

test("provider-independent conversion profiles use semantic event names", () => {
  const definition = mechanicSnapshot();
  const profile: EncounterConversionProfile = {
    schemaVersion: 1,
    id: uuid(),
    encounterId: 9001,
    gameVersion: "retail-12.1",
    profileVersion: 1,
    status: "draft",
    mechanicDefinitions: [definition],
    collectionRules: [{ id: uuid(), enabled: true, dataType: "casts", hostility: "enemy", abilityGameIds: [2001], uses: ["timeline"], purpose: "记录关键 Boss 施法" }],
    conversionRules: [{ id: uuid(), enabled: true, match: { eventTypes: ["cast-start"], abilityGameIds: [2001], sourceActorType: "npc" }, convertTo: { kind: "mechanic", definitionId: definition.id, timingPoint: "cast-start" }, notes: "人工核准后发布", verification: { reviewedAt: 1_800_000_000_000, sourceReportCodes: ["ABC123"] } }],
    notes: "fixture",
  };
  assert.deepEqual(parseConversionProfile(JSON.parse(JSON.stringify(profile))), profile);
  assert.doesNotMatch(JSON.stringify(profile), /GraphQL|WCL DTO|MRT/);
});

test("checked-in v1 fixtures validate combat log, conversion, import draft and comparison boundaries", () => {
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../data/fixtures/${name}`, import.meta.url), "utf8"));
  const snapshot = parseCombatLogSnapshot(fixture("combat-log-snapshot-v1.json"));
  const profile = parseConversionProfile(fixture("encounter-conversion-profile-v1.json"));
  const draft = parsePlanImportDraft(fixture("plan-import-draft-v1.json"));
  const comparison = parseComparisonRun(fixture("comparison-run-v1.json"));
  assert.equal(snapshot.source.reportCode, "ABC123");
  assert.equal(profile.conversionRules[0].match.eventTypes[0], "cast-start");
  assert.equal(draft.snapshotId, snapshot.id);
  assert.equal(comparison.conversionProfileId, profile.id);
  assert.equal("difficulty" in snapshot.encounter, false);
});

test("short publication IDs are strict base62", () => {
  const deterministic = randomBase62(16, (array) => { array.fill(61); return array; });
  assert.equal(deterministic, "ZZZZZZZZZZZZZZZZ");
  assert.doesNotThrow(() => assertShareId(deterministic));
  assert.doesNotThrow(() => assertEditId("A9z0"));
  assert.throws(() => assertShareId("too-short"));
  assert.throws(() => assertEditId("A9-0"));
});

test("file object store keeps JSON under its configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "raidline-object-store-"));
  const store = createFileObjectStore(root);
  const key = "publications/0123456789ABCDEF.json";
  try {
    assert.equal(await store.getJson(key), null);
    assert.equal(await store.exists(key), false);
    await store.putJson(key, { revision: 1 });
    assert.deepEqual(await store.getJson(key), { revision: 1 });
    await store.putJson(key, { revision: 2 });
    assert.deepEqual(await store.getJson(key), { revision: 2 });
    assert.equal(await store.exists(key), true);
    await assert.rejects(() => store.putJson("../escape.json", {}));
    await store.delete(key);
    assert.equal(await store.exists(key), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot cleanup retains newest 30 per plan and honors total byte cap", () => {
  const snapshots = Array.from({ length: 35 }, (_, index) => ({ id: `a-${index}`, planId: "a", createdAt: index, bytes: 10 }));
  const countPolicy = snapshotIdsToDelete(snapshots, 30, 10_000);
  assert.equal(countPolicy.ids.size, 5);
  assert.ok(countPolicy.ids.has("a-0"));
  const bytePolicy = snapshotIdsToDelete([{ id: "old", planId: "a", createdAt: 1, bytes: 80 }, { id: "new", planId: "b", createdAt: 2, bytes: 80 }], 30, 100);
  assert.deepEqual([...bytePolicy.ids], ["old"]);
  assert.equal(isExpectedRevision(7, 7), true);
  assert.equal(isExpectedRevision(8, 7), false);
});

test("view helpers keep fit zoom, responsive orientation and one-second drag alignment", () => {
  assert.equal(defaultOrientation(1366), "horizontal");
  assert.equal(defaultOrientation(390), "vertical");
  assert.equal(clampZoom(1), 4);
  assert.equal(clampZoom(99), 16);
  assert.equal(zoomFromWheel(4, -100), 4.1);
  assert.equal(zoomFromWheel(4, 100), 4);
  assert.equal(zoomFromWheel(16, -100), 16);
  assert.equal(anchoredScroll(100, 200, 1, 2), 400);
  assert.equal(timelineTimeFromDrag(10_000, 15, 10), 12_000);
  assert.ok(adaptiveTickMs(2) >= 30_000);
  const plan = populatedPlan();
  assert.equal(timelineRangeMs(plan), buildTimelineScene(plan).durationMs);
  assert.equal(timelineContentEnd(plan), 78000);
});
