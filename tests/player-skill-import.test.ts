import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillTargetEditor } from "../app/components/SkillTargetEditor.tsx";
import { createBlankPlan, exportPlan } from "../lib/core.ts";
import { extractPlayerSkillCandidates } from "../lib/player-skill-extraction.ts";
import { playerSkillDefinitions, playerSkillExtractionProfiles } from "../lib/wcl-profile-registry.ts";
import { selectWclImportContent } from "../lib/wcl-import.ts";
import { buildTimelineScene } from "../lib/domain/view-model.ts";
import { defaultSkillTargets, resolveSkillForAssignment, resolveSkillVariant, skillTargetMode, skillTargetsForMode } from "../lib/skills.ts";
import { skillAssignmentNoteText, skillEffectText, tacticalDirectiveText } from "../lib/plan-presentation.ts";
import { WOW_CLASS_SPECS } from "../lib/cooldowns.ts";
import { parsePlanDocument } from "../lib/types.ts";
import { createPlanFromImportDraft } from "../lib/wcl-conversion.ts";
import type { CombatLogSnapshot, ObservedEvent, SkillTargetSelector } from "../lib/types.ts";

const actor = (id: number, classSlug: string, specSlug: string) => ({ actorKey: `player:${id}`, reportActorId: id, type: "player" as const, name: "Forbidden original name", classSlug, specSlug });
const event = (atMs: number, type: ObservedEvent["type"], abilityGameId: number, sourceActorKey = "player:1", targetActorKey = sourceActorKey): ObservedEvent => ({ eventKey: `${type}:${atMs}:${abilityGameId}:${sourceActorKey}:${targetActorKey}`, atMs, type, abilityGameId, sourceActorKey, targetActorKey });
function snapshot(events: ObservedEvent[]): CombatLogSnapshot {
  return { schemaVersion: 1, id: crypto.randomUUID(), provider: "wcl", normalizerVersion: "test", importedAt: 0,
    source: { reportCode: "AnonymousFixture", fightId: 1, reportRevision: 1, reportStartEpochMs: 0, fightStartReportMs: 0, fightEndReportMs: 240000, gameVersionKey: "retail-12.1" },
    encounter: { encounterId: 3455, name: "Vashnik", kill: true, durationMs: 240000 },
    actors: [actor(1, "Warrior", "protection"), actor(2, "Priest", "holy"), actor(3, "Mage", "frost"), actor(4, "Mage", "fire")],
    events, phases: [], contentHash: "synthetic-only" };
}
const extract = (events: ObservedEvent[]) => extractPlayerSkillCandidates(snapshot(events), playerSkillExtractionProfiles[0], playerSkillDefinitions);

test("skill targets offer only all or self without rewriting existing selectors", () => {
  const memberId = crypto.randomUUID(), anotherMemberId = crypto.randomUUID();
  assert.deepEqual(defaultSkillTargets({ scope: "team" }, memberId), { kind: "all" });
  assert.deepEqual(defaultSkillTargets({ scope: "personal" }, memberId), { kind: "members", memberIds: [memberId] });
  assert.equal(skillTargetMode(skillTargetsForMode("all", memberId), memberId), "all");
  assert.equal(skillTargetMode(skillTargetsForMode("self", memberId), memberId), "self");
  assert.equal(skillTargetMode(skillTargetsForMode("self", memberId), anotherMemberId), null);
  const targets: SkillTargetSelector[] = [
    { kind: "all" }, { kind: "members", memberIds: [memberId] },
    { kind: "members", memberIds: [anotherMemberId] }, { kind: "members", memberIds: [memberId, anotherMemberId] },
    { kind: "members", memberIds: [] }, { kind: "groups", groupIds: [crypto.randomUUID()] },
    { kind: "roles", roles: ["healer"] }, { kind: "subgroups", subgroups: [1] }, { kind: "mechanic-targets" },
  ];
  for (const target of targets) {
    const before = JSON.stringify(target);
    let changes = 0;
    const html = renderToStaticMarkup(createElement(SkillTargetEditor, { target, memberId, onChange: () => { changes++; } }));
    const selectableOptions = [...html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].filter(match => !match[1].includes("disabled"));
    assert.deepEqual(selectableOptions.map(match => match[2]), ["全团", "自己"]);
    assert.doesNotMatch(html, /checkbox|策略组|小队|具体成员|继承锚定/);
    if (skillTargetMode(target, memberId) === null) assert.match(html, /保留原目标/);
    assert.equal(JSON.stringify(target), before);
    assert.equal(changes, 0);
  }
});

test("new WCL plans use all or self, independent of observed recipients, without changing draft evidence", () => {
  const source = snapshot([
    event(10000, "cast-success", 871), event(10001, "aura-applied", 871),
    event(20000, "cast-success", 64843, "player:2"), event(20001, "healing", 64844, "player:2", "player:1"),
  ]);
  const extracted = extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions);
  const draft = { schemaVersion: 1, id: crypto.randomUUID(), snapshotId: source.id, conversionProfileId: crypto.randomUUID(), conversionProfileVersion: 3, rosterCandidates: extracted.rosterCandidates, phaseCandidates: [], mechanicCandidates: [], skillAssignmentCandidates: extracted.skillAssignmentCandidates, unresolvedEvents: [], warnings: [] };
  const before = JSON.stringify(draft);
  const plan = createPlanFromImportDraft(source, draft);
  assert.equal(plan.timeline.skillAssignments.length, 2);
  const personal = plan.timeline.skillAssignments.find(item => plan.definitions.skills.find(skill => skill.id === item.skillDefinitionId)?.scope === "personal")!;
  const team = plan.timeline.skillAssignments.find(item => plan.definitions.skills.find(skill => skill.id === item.skillDefinitionId)?.scope === "team")!;
  assert.deepEqual(personal.targets, { kind: "members", memberIds: [personal.memberId] });
  assert.deepEqual(team.targets, { kind: "all" });
  assert.equal(JSON.stringify(draft), before);
  const selected = selectWclImportContent(plan, { mechanicIds: [], memberIds: [team.memberId], assignmentIds: [team.id] });
  assert.equal(selected.timeline.skillAssignments.length, 1);
  assert.equal(selected.roster.members.length, 1);
});

test("Anti-Magic Zone imports successful casts without aura attribution and still rejects starts, duplicates and dead casters", () => {
  const input = snapshot([
    event(1000, "cast-start", 51052),
    event(10000, "cast-success", 51052),
    event(10020, "cast-success", 51052),
    event(10000, "cast-success", 51052, "player:2"),
    event(19000, "death", 1), event(20000, "cast-success", 51052),
  ]);
  input.actors[0] = actor(1, "DeathKnight", "blood");
  input.actors[1] = actor(2, "DeathKnight", "unholy");
  const result = extractPlayerSkillCandidates(input, playerSkillExtractionProfiles[0], playerSkillDefinitions);
  assert.equal(result.skillAssignmentCandidates.length, 2);
  assert.deepEqual(result.skillAssignmentCandidates.map(candidate => candidate.assignment.anchor.offsetMs), [10000, 10000]);
  assert.ok(result.skillAssignmentCandidates.every(candidate => candidate.assignment.targets.kind === "all" && candidate.assignment.timing?.durationMs === 6000 && candidate.assignment.note === ""));
  assert.ok(result.warnings.some(warning => warning.code === "PLAYER_SKILL_AFTER_DEATH"));
  assert.ok(!result.warnings.some(warning => warning.code === "PLAYER_SKILL_EFFECT_UNCONFIRMED"));
});

test("published player scope excludes external healing, disputed skills and Holy Bulwark", () => {
  const ids = new Set(playerSkillExtractionProfiles[0].extractionRules.flatMap(rule => rule.match.abilityGameIds));
  for (const id of [33206, 47788, 102342, 116849, 6940, 1022, 204018, 357170, 53480, 432459, 432472, 432496]) assert.equal(ids.has(id), false, String(id));
  assert.equal(new Set(playerSkillDefinitions.filter(skill => skill.enabled).map(skill => skill.classSlug)).size, 13);
});

test("the cast-only exception is versioned and limited to Anti-Magic Zone", () => {
  const latest = playerSkillExtractionProfiles[0];
  assert.equal(latest.profileVersion, 2);
  assert.deepEqual(latest.extractionRules.filter(rule => "kind" in rule.confirmation).flatMap(rule => rule.match.abilityGameIds), [51052]);
  const previous = playerSkillExtractionProfiles.find(profile => profile.profileVersion === 1)!;
  const input = snapshot([event(10000, "cast-success", 51052)]);
  input.actors[0] = actor(1, "DeathKnight", "blood");
  assert.equal(extractPlayerSkillCandidates(input, previous, playerSkillDefinitions).skillAssignmentCandidates.length, 0);
});

test("presentation removes only generated text, preserves manual notes and never mutates a saved plan", () => {
  const plan = createBlankPlan();
  const result = extract([event(10000, "cast-success", 871), event(10001, "aura-applied", 871)]);
  const assignment = result.skillAssignmentCandidates[0].assignment;
  assignment.origin = { sourceId: crypto.randomUUID(), conversionRuleIds: [crypto.randomUUID()] };
  assignment.note = "来源为 WCL 中已施放且找到生效证据的记录；建轴后的调整不再代表原始日志。结束时间采用基础持续时长，并非完整实测覆盖。不代表原团队的完整战术计划或所有受益目标。";
  const note = { id: crypto.randomUUID(), kind: "note" as const, text: "嗜血类增益（至少 2 人同时生效的实测区间，不代表全员覆盖）", scope: { kind: "timed" as const, anchor: { kind: "pull" as const, offsetMs: 0 } }, durationMs: 40000, timelinePresentation: "team-buff-window" as const };
  plan.roster.members = result.rosterCandidates.map(candidate => candidate.slot);
  plan.definitions.skills = result.skillAssignmentCandidates.map(candidate => candidate.definition);
  plan.timeline.skillAssignments = [assignment];
  plan.timeline.directives = [note];
  const before = JSON.stringify(plan);
  assert.equal(skillAssignmentNoteText(assignment), "");
  assert.equal(tacticalDirectiveText(note), "嗜血");
  assert.equal(buildTimelineScene(plan).directives[0].text, "嗜血");
  const exported = exportPlan({ target: "mrt-reading", document: plan });
  assert.match(exported.text, /嗜血/);
  assert.doesNotMatch(exported.text, /来源为 WCL|至少 2 人|实测区间/);
  assert.equal(JSON.stringify(plan), before);
  const manual = { ...assignment, note: "第一轮站门口" };
  assert.equal(skillAssignmentNoteText(manual), manual.note);
  assert.equal(skillAssignmentNoteText({ ...assignment, note: assignment.note + "我补充的安排" }), assignment.note + "我补充的安排");
  assert.equal(skillAssignmentNoteText({ ...assignment, origin: undefined }), assignment.note);
  assert.equal(tacticalDirectiveText({ ...note, text: "嗜血留到 P2" }), "嗜血留到 P2");
});

test("skill details show effect text instead of review limitations and respect effect-changing variants", () => {
  const wings = playerSkillDefinitions.find(skill => skill.name === "复仇之怒")!;
  assert.equal(skillEffectText(resolveSkillVariant(wings)), "神圣专精下强化治疗、伤害和爆击");
  const crusader = wings.variants.find(variant => variant.name === "复仇十字军")!;
  assert.equal(skillEffectText(resolveSkillVariant(wings, crusader.id)), "由攻击技能转化为附近最多 5 人治疗");
});

test("only active cast plus effect creates a skill candidate; repeats and passive auras do not", () => {
  const result = extract([
    event(1000, "cast-start", 871),
    event(5000, "aura-applied", 871), // passive/unpaired
    event(10000, "cast-success", 871), event(10001, "aura-applied", 871), event(18000, "aura-removed", 871),
    { ...event(10000, "cast-success", 871), eventKey: "duplicate-provider-view" },
    event(40000, "cast-success", 871), // no effect
  ]);
  assert.equal(result.skillAssignmentCandidates.length, 1);
  assert.equal(result.skillAssignmentCandidates[0].assignment.anchor.offsetMs, 10000);
  assert.equal(result.skillAssignmentCandidates[0].assignment.timing?.durationMs, 8000);
  assert.ok(result.warnings.some(w => w.code === "PLAYER_SKILL_EFFECT_UNCONFIRMED"));
});

test("anonymous roster names never copy source names and same-class slots stay distinct", () => {
  const result = extract([]);
  assert.deepEqual(result.rosterCandidates.map(c => c.slot.name), ["战士A", "牧师A", "法师A", "法师B"]);
  assert.doesNotMatch(JSON.stringify(result), /Forbidden original name/);
  assert.doesNotMatch(JSON.stringify(result.rosterCandidates.map(candidate => candidate.slot)), /player:\d|reportActorId|server/);
});

test("group healing folds ticks and accepts overheal as evidence", () => {
  const result = extract([
    event(20000, "cast-success", 64843, "player:2"),
    { ...event(20200, "healing", 64844, "player:2", "player:1"), amount: 0 },
    event(21000, "healing", 64844, "player:2", "player:3"),
    event(22000, "healing", 64844, "player:2", "player:1"),
  ]);
  assert.equal(result.skillAssignmentCandidates.length, 1);
  assert.equal(result.skillAssignmentCandidates[0].definition.spellId, 64843);
});

test("observed short cooldowns remain candidates without inventing talents or charges", () => {
  const result = extract([
    event(10000, "cast-success", 871), event(10001, "aura-applied", 871),
    event(40000, "cast-success", 871), event(40001, "aura-applied", 871),
  ]);
  assert.equal(result.skillAssignmentCandidates.length, 2);
  assert.ok(result.warnings.some(w => w.code === "PLAYER_SKILL_COOLDOWN_UNCERTAIN"));
});

test("casts after death require resurrection evidence and cannot fabricate extra cooldowns", () => {
  const result = extract([event(9000, "death", 1), event(10000, "cast-success", 871), event(10001, "aura-applied", 871)]);
  assert.equal(result.skillAssignmentCandidates.length, 0);
  assert.ok(result.warnings.some(w => w.code === "PLAYER_SKILL_AFTER_DEATH"));
});

test("missing or conflicting specialization does not guess a spec-specific skill", () => {
  const input = snapshot([event(10000, "cast-success", 871), event(10001, "aura-applied", 871)]);
  delete input.actors[0].specSlug;
  const result = extractPlayerSkillCandidates(input, playerSkillExtractionProfiles[0], playerSkillDefinitions);
  assert.equal(result.skillAssignmentCandidates.length, 0);
  assert.ok(result.warnings.some(w => w.code === "PLAYER_SPECIALIZATION_UNKNOWN"));
});

test("explicit import selection prunes only deselected candidates and their unused definitions", () => {
  const input = createBlankPlan();
  const result = extract([event(10000, "cast-success", 871), event(10001, "aura-applied", 871)]);
  input.roster.members = result.rosterCandidates.map(c => c.slot);
  input.definitions.skills = [result.skillAssignmentCandidates[0].definition];
  input.timeline.skillAssignments = result.skillAssignmentCandidates.map(c => c.assignment);
  input.roster.memberSkills = [{ memberId: input.roster.members[0].id, skillDefinitionId: input.definitions.skills[0].id, variantId: null }];
  const selected = selectWclImportContent(input, { mechanicIds: [], memberIds: [input.roster.members[1].id], assignmentIds: [] });
  assert.equal(selected.roster.members.length, 1);
  assert.equal(selected.timeline.skillAssignments.length, 0);
  assert.equal(selected.definitions.skills.length, 0);
  assert.equal(selected.roster.memberSkills.length, 0);
  assert.equal(input.timeline.skillAssignments.length, 1);
});

test("timeline view sorts roles without mutating the plan", () => {
  const plan = createBlankPlan();
  plan.roster.members = extract([]).rosterCandidates.map(c => c.slot).reverse();
  const before = JSON.stringify(plan);
  assert.deepEqual(buildTimelineScene(plan).members.map(m => m.role), ["tank", "healer", "damage", "damage"]);
  assert.equal(JSON.stringify(plan), before);
});

test("an aura ends at its first removal; later passive procs do not stretch an active cooldown", () => {
  const result = extract([
    event(10000, "cast-success", 871), event(10001, "aura-applied", 871), event(18000, "aura-removed", 871),
    event(40000, "aura-applied", 871), event(48000, "aura-removed", 871),
  ]);
  assert.equal(result.skillAssignmentCandidates.length, 1);
  assert.equal(result.skillAssignmentCandidates[0].observed?.endMs, 18000);
});

test("every enabled rule enforces its explicit confirmation policy", () => {
  const profile = playerSkillExtractionProfiles[0];
  for (const rule of profile.extractionRules.filter(rule => rule.enabled)) {
    const definition = playerSkillDefinitions.find(skill => skill.id === rule.definitionId)!;
    const source = snapshot([]);
    source.actors[0] = actor(1, definition.classSlug, definition.specSlugs[0] ?? WOW_CLASS_SPECS[definition.classSlug][0].slug);
    const cast = event(10000, "cast-success", rule.match.abilityGameIds[0]);
    source.events = [cast];
    const confirmation = "kind" in rule.confirmation ? undefined : rule.confirmation;
    assert.equal(extractPlayerSkillCandidates(source, profile, playerSkillDefinitions).skillAssignmentCandidates.length, confirmation ? 0 : 1, `${rule.id}: cast only`);
    if (confirmation) source.events.push(event(10001, confirmation.eventTypes[0], confirmation.abilityGameIds[0]));
    const result = extractPlayerSkillCandidates(source, profile, playerSkillDefinitions);
    assert.equal(result.skillAssignmentCandidates.length, 1, rule.id);
    assert.equal(result.skillAssignmentCandidates[0].assignment.variantId, rule.variantId);
    assert.equal(result.skillAssignmentCandidates[0].assignment.note, "");
  }
});

test("trusted pet effects can confirm their owner; another player's pet cannot", () => {
  const source = snapshot([event(10000, "cast-success", 64843, "player:2"), event(10001, "healing", 64844, "pet:5", "player:1")]);
  source.actors.push({ actorKey: "pet:5", reportActorId: 5, type: "pet", name: "anonymous pet", ownerActorKey: "player:2" });
  assert.equal(extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions).skillAssignmentCandidates.length, 1);
  source.actors[4].ownerActorKey = "player:3";
  assert.equal(extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions).skillAssignmentCandidates.length, 0);
});

test("resurrection reopens active casts and short fights clip imported effects", () => {
  const source = snapshot([event(1000, "death", 1), event(2000, "resurrection", 1), event(3000, "cast-success", 871), event(3001, "aura-applied", 871)]);
  source.encounter.durationMs = 6000; source.source.fightEndReportMs = 6000;
  const result = extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions);
  assert.equal(result.skillAssignmentCandidates.length, 1);
  assert.equal(result.skillAssignmentCandidates[0].assignment.timing?.durationMs, 3000);
});

test("per-use variants resolve from the snapshot, not a second layer over the member variant", () => {
  const plan = createBlankPlan();
  const skill = structuredClone(playerSkillDefinitions.find(skill => skill.spellId === 871)!);
  const base = { ...skill, enabled: undefined }; delete base.enabled;
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  base.variants = [{ id: first, name: "双充能", description: "test", limitations: [], overrides: { maxCharges: 2 } }, { id: second, name: "持续变化", description: "test", limitations: [], overrides: { durationMs: 10000 } }];
  plan.definitions.skills = [base]; plan.roster.members = extract([]).rosterCandidates.map(c => c.slot);
  const memberId = plan.roster.members[0].id;
  plan.roster.memberSkills = [{ memberId, skillDefinitionId: base.id, variantId: first }];
  const assignment = { id: crypto.randomUUID(), memberId, skillDefinitionId: base.id, variantId: second, anchor: { kind: "pull" as const, offsetMs: 0 }, targets: { kind: "all" as const }, note: "", timing: { castTimeMs: 0, durationMs: 3000 } };
  assert.equal(resolveSkillForAssignment(plan, assignment)?.maxCharges, 1);
  assert.equal(resolveSkillForAssignment(plan, assignment)?.durationMs, 3000);
});

test("stale selections and missing recipient dependencies fail explicitly", () => {
  const plan = createBlankPlan();
  assert.throws(() => selectWclImportContent(plan, { mechanicIds: [crypto.randomUUID()], memberIds: [], assignmentIds: [] }), /失效/);
  const result = extract([event(10000, "cast-success", 64843, "player:2"), event(10001, "healing", 64844, "player:2", "player:1")]);
  plan.roster.members = result.rosterCandidates.map(c => c.slot);
  plan.definitions.skills = result.skillAssignmentCandidates.map(c => c.definition);
  plan.timeline.skillAssignments = result.skillAssignmentCandidates.map(c => c.assignment);
  assert.throws(() => selectWclImportContent(plan, { mechanicIds: [], memberIds: [plan.timeline.skillAssignments[0].memberId], assignmentIds: [plan.timeline.skillAssignments[0].id] }), /依赖/);
});

test("Darkness needs a confirmed friendly absorb and does not infer effect from cast success alone", () => {
  const source = snapshot([event(10000, "cast-success", 196718), { ...event(13500, "absorb", 209426, "player:1", "player:3"), amount: 100 }]);
  source.actors[0] = actor(1, "DemonHunter", "havoc");
  assert.equal(extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions).skillAssignmentCandidates.length, 1);
  source.events[1].amount = 0;
  assert.equal(extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions).skillAssignmentCandidates.length, 0);
});

test("bloodlust uses overlapping recipient windows, never a member skill", () => {
  const result = extract([
    event(1000, "aura-applied", 2825, "player:1", "player:2"), event(41000, "aura-removed", 2825, "player:1", "player:2"),
    event(1010, "aura-applied", 2825, "player:1", "player:3"), event(41000, "aura-removed", 2825, "player:1", "player:3"),
  ]);
  assert.equal(result.skillAssignmentCandidates.length, 0);
  assert.equal(result.noteCandidates?.length, 1);
  assert.equal(result.noteCandidates?.[0].note.durationMs, 40000);
  assert.equal(result.noteCandidates?.[0].note.timelinePresentation, "team-buff-window");
  assert.equal(result.noteCandidates?.[0].note.text, "嗜血");
  const missingEnd = extract([event(1000, "aura-applied", 2825, "player:1", "player:2")]);
  assert.equal(missingEnd.noteCandidates?.length, 0);
  assert.ok(missingEnd.warnings.some(w => w.code === "TEAM_BUFF_END_UNCONFIRMED"));
});

test("bloodlust excludes lone personal procs, extensions and duplicate auras on one recipient", () => {
  const result = extract([
    event(1000, "aura-applied", 2825, "player:1", "player:2"), event(41000, "aura-removed", 2825, "player:1", "player:2"),
    event(1000, "aura-applied", 2825, "player:1", "player:3"), event(56000, "aura-removed", 2825, "player:1", "player:3"),
    event(80000, "aura-applied", 80353, "player:3"), event(83000, "aura-removed", 80353, "player:3"),
    event(80000, "aura-applied", 2825, "player:1", "player:3"), event(83000, "aura-removed", 2825, "player:1", "player:3"),
  ]);
  assert.equal(result.noteCandidates?.length, 1);
  assert.equal(result.noteCandidates?.[0].note.durationMs, 40000);
});

test("imports use official phase anchors and remain independent after removing source metadata", () => {
  const source = snapshot([event(90000, "cast-success", 871), event(90001, "aura-applied", 871)]);
  source.phases = [{ id: crypto.randomUUID(), semanticPhaseId: 1, occurrenceIndex: 1, atMs: 0 }, { id: crypto.randomUUID(), semanticPhaseId: 2, occurrenceIndex: 1, atMs: 60000 }];
  const extracted = extractPlayerSkillCandidates(source, playerSkillExtractionProfiles[0], playerSkillDefinitions);
  const draft = { schemaVersion: 1, id: crypto.randomUUID(), snapshotId: source.id, conversionProfileId: crypto.randomUUID(), conversionProfileVersion: 3, rosterCandidates: extracted.rosterCandidates, phaseCandidates: [], mechanicCandidates: [], skillAssignmentCandidates: extracted.skillAssignmentCandidates, unresolvedEvents: [], warnings: [] };
  const plan = createPlanFromImportDraft(source, draft);
  assert.equal(plan.timeline.skillAssignments[0].anchor.kind, "phase");
  assert.equal(plan.timeline.skillAssignments[0].anchor.offsetMs, 30000);
  const before = buildTimelineScene(plan).assignments;
  plan.sources = [];
  assert.deepEqual(buildTimelineScene(plan).assignments, before);
  plan.timeline.phases[1].estimatedStartMs = 70000;
  assert.equal(buildTimelineScene(plan).assignments[0].atMs, 100000);
});

test("large plans fail the existing 1 MB boundary without trimming user data", () => {
  const plan = createBlankPlan();
  plan.timeline.directives = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), kind: "note", text: "X".repeat(11000), scope: { kind: "plan" }, durationMs: null }));
  assert.throws(() => parsePlanDocument(plan), /1 MB/);
  assert.equal(plan.timeline.directives.length, 100);
});

test("deduplication uses milliseconds across second boundaries before plan rounding", () => {
  const result = extract([event(1990, "cast-success", 871), event(1991, "aura-applied", 871), event(2050, "cast-success", 871)]);
  assert.equal(result.skillAssignmentCandidates.length, 1);
});
