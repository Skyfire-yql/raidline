import seedJson from "../data/catalog-seed.json" with { type: "json" };
import vashnikProfileJson from "../data/fixtures/vashnik-encounter-conversion-profile-v1.json" with { type: "json" };
import vashnikPresetJson from "../data/fixtures/vashnik-fight-32-timeline-preset-v1.json" with { type: "json" };
import { TimelinePresetSchema, parseCatalogRelease, parseConversionProfile, parsePlanDocument, type CatalogMechanicDefinition, type CatalogRelease, type CatalogSkillDefinition, type MechanicDefinitionSnapshot, type PlayerSkillDefinitionSnapshot, type RaidPlanDocument, type TimelinePreset } from "./types";

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => seen.has(value) || !seen.add(value));
}

function validateVerification(skill: CatalogSkillDefinition) {
  if (skill.castType === "instant" && skill.castTimeMs !== 0) throw new Error(`技能 ${skill.name} 的瞬发时间必须为 0`);
  if ((skill.castType === "cast" || skill.castType === "channel") && (!skill.castTimeMs || skill.castTimeMs <= 0)) throw new Error(`技能 ${skill.name} 缺少有效施法或引导时间`);
  if (duplicateValues(skill.variants.map((item) => item.id)).length) throw new Error(`技能 ${skill.name} 的变体 ID 重复`);
  if (skill.dataStatus !== "verified") return;
  const verification = skill.verification;
  if (!verification || verification.gameVersion !== skill.gameVersion || verification.checkedAt == null) throw new Error(`已核准技能 ${skill.name} 缺少匹配版本的核准记录`);
  if (!verification.sources.some((source) => source.kind === "blizzard" || source.kind === "in-game")) throw new Error(`已核准技能 ${skill.name} 缺少正式服或 Blizzard 主来源`);
  if (!verification.sources.some((source) => source.kind === "community")) throw new Error(`已核准技能 ${skill.name} 缺少社区复核来源`);
}

export function validateCatalogRelease(value: unknown): CatalogRelease {
  const release = parseCatalogRelease(value);
  if (!VERSION_PATTERN.test(release.manifest.version)) throw new Error("目录版本标识无效");
  const ids = [
    ...release.playerSkills.map((item) => item.id),
    ...release.bossMechanics.map((item) => item.id),
    ...release.timelinePresets.map((item) => item.id),
    ...release.playerSkills.flatMap((item) => item.variants.map((variant) => variant.id)),
    ...release.timelinePresets.flatMap((item) => [...item.phases.map((phase) => phase.id), ...item.mechanics.map((mechanic) => mechanic.id), ...item.notes.map((note) => note.id)]),
  ];
  if (duplicateValues(ids).length) throw new Error("目录条目 ID 重复");
  if (release.manifest.counts.playerSkills !== release.playerSkills.length || release.manifest.counts.bossMechanics !== release.bossMechanics.length || release.manifest.counts.timelinePresets !== release.timelinePresets.length) throw new Error("目录 manifest 计数与正文不一致");
  for (const skill of release.playerSkills) validateVerification(skill);
  const mechanicsById = new Map(release.bossMechanics.map((item) => [item.id, item]));
  for (const preset of release.timelinePresets) {
    const phaseIds = new Set(preset.phases.map((item) => item.id));
    if (duplicateValues([...phaseIds]).length) throw new Error(`预设 ${preset.name} 的阶段 ID 重复`);
    for (const occurrence of preset.mechanics) {
      const definition = mechanicsById.get(occurrence.definitionId);
      if (!definition) throw new Error(`预设 ${preset.name} 引用了不存在的机制定义`);
      if (definition.encounterId !== preset.encounter.id) throw new Error(`预设 ${preset.name} 引用了其他遭遇的机制定义`);
      if (occurrence.anchor.kind === "phase" && !phaseIds.has(occurrence.anchor.phaseId)) throw new Error(`预设 ${preset.name} 的机制引用了不存在的阶段`);
    }
    for (const note of preset.notes) if (note.kind !== "note") throw new Error(`预设 ${preset.name} 只能包含通用说明`);
  }
  return release;
}

const BASE_SEED_CATALOG = validateCatalogRelease(seedJson);
const VASHNIK_PROFILE = parseConversionProfile(vashnikProfileJson);
const VASHNIK_PRESET = TimelinePresetSchema.parse(vashnikPresetJson);

function builtInCatalog() {
  if (VASHNIK_PROFILE.status !== "published" || VASHNIK_PROFILE.encounterId !== VASHNIK_PRESET.encounter.externalIds?.wclEncounterId || VASHNIK_PROFILE.gameVersion !== VASHNIK_PRESET.encounter.gameVersion) {
    throw new Error("Vashnik 示例预设与已发布转换 profile 不一致");
  }
  const release = structuredClone(BASE_SEED_CATALOG);
  release.manifest.version = "builtin-seed-v2";
  release.manifest.title = "Raidline vNext 内置种子目录（含 Vashnik WCL 示例）";
  release.bossMechanics.push(...VASHNIK_PROFILE.mechanicDefinitions.map((definition) => ({
    ...structuredClone(definition),
    encounterId: VASHNIK_PRESET.encounter.id,
    enabled: true,
  })));
  release.timelinePresets.push(structuredClone(VASHNIK_PRESET));
  release.manifest.counts = {
    playerSkills: release.playerSkills.length,
    bossMechanics: release.bossMechanics.length,
    timelinePresets: release.timelinePresets.length,
  };
  return validateCatalogRelease(release);
}

export const SEED_CATALOG = builtInCatalog();

export function catalogReleaseKeys(version: string) {
  if (!VERSION_PATTERN.test(version)) throw new Error("目录版本标识无效");
  const prefix = `catalog/releases/${version}`;
  return {
    manifest: `${prefix}/manifest.json`,
    playerSkills: `${prefix}/player-skills.json`,
    bossMechanics: `${prefix}/boss-mechanics.json`,
    timelinePresets: `${prefix}/timeline-presets.json`,
  };
}

function skillSnapshot(item: CatalogSkillDefinition, sourceId: string): PlayerSkillDefinitionSnapshot {
  const { enabled: _enabled, ...definition } = item;
  void _enabled;
  return { ...structuredClone(definition), origin: { sourceId } };
}

export function ensureCatalogSkillSnapshot(plan: RaidPlanDocument, release: CatalogRelease, skillDefinitionId: string) {
  const existing = plan.definitions.skills.find((item) => item.id === skillDefinitionId);
  if (existing) return existing;
  const catalogSkill = release.playerSkills.find((item) => item.enabled && item.id === skillDefinitionId);
  if (!catalogSkill) throw new Error("目录中找不到可用的技能定义");
  let source = plan.sources.find((item) => item.kind === "catalog" && item.catalogVersion === release.manifest.version);
  if (!source) {
    source = { id: crypto.randomUUID(), kind: "catalog", catalogVersion: release.manifest.version, importedAt: Date.now() };
    plan.sources.push(source);
  }
  const snapshot = skillSnapshot(catalogSkill, source.id);
  plan.definitions.skills.push(snapshot);
  return snapshot;
}

export function upgradeCatalogSkillSnapshots(current: RaidPlanDocument, release: CatalogRelease) {
  const next = structuredClone(current);
  const currentSkills = new Map(next.definitions.skills.map((item) => [item.id, item]));
  const catalogSkills = new Map(release.playerSkills.filter((item) => item.enabled).map((item) => [item.id, item]));
  for (const selection of next.roster.memberSkills) {
    if (!selection.variantId || !currentSkills.has(selection.skillDefinitionId)) continue;
    const replacement = catalogSkills.get(selection.skillDefinitionId);
    if (replacement && !replacement.variants.some((variant) => variant.id === selection.variantId)) throw new Error("新版目录移除了计划正在使用的技能变体，请先将对应成员切回基础版本或其他变体");
  }
  const sourceId = crypto.randomUUID();
  next.sources.push({ id: sourceId, kind: "catalog", catalogVersion: release.manifest.version, importedAt: Date.now() });
  next.definitions.skills = next.definitions.skills.map((item) => {
    if (item.dataStatus === "custom") return item;
    const replacement = catalogSkills.get(item.id);
    return replacement ? skillSnapshot(replacement, sourceId) : item;
  });
  return parsePlanDocument(next);
}

function mechanicSnapshot(item: CatalogMechanicDefinition, sourceId: string): MechanicDefinitionSnapshot {
  const { enabled: _enabled, encounterId: _encounterId, ...definition } = item;
  void _enabled; void _encounterId;
  return { ...structuredClone(definition), origin: { sourceId } };
}

export function applyCatalogPreset(current: RaidPlanDocument, release: CatalogRelease, preset: TimelinePreset) {
  const sourceId = crypto.randomUUID();
  const source = { id: sourceId, kind: "catalog" as const, catalogVersion: release.manifest.version, presetId: preset.id, importedAt: Date.now() };
  const referencedMechanicIds = new Set(preset.mechanics.map((item) => item.definitionId));
  const definitions = release.bossMechanics.filter((item) => item.enabled && referencedMechanicIds.has(item.id)).map((item) => mechanicSnapshot(item, sourceId));
  const skillDefinitions = release.playerSkills.filter((item) => item.enabled).map((item) => skillSnapshot(item, sourceId));
  const next = structuredClone(current);
  next.metadata.title = preset.name;
  next.encounter = structuredClone(preset.encounter);
  next.sources = [source];
  next.templateSourceId = sourceId;
  next.definitions.mechanics = definitions;
  next.definitions.skills = skillDefinitions;
  next.timeline.phases = preset.phases.map((item) => ({ ...structuredClone(item), origin: { sourceId } }));
  next.timeline.mechanics = preset.mechanics.map((item) => ({ ...structuredClone(item), origin: { sourceId } }));
  next.timeline.directives = preset.notes.map((item) => ({ ...structuredClone(item), origin: { sourceId } }));
  next.timeline.skillAssignments = [];
  next.roster.memberSkills = [];
  return parsePlanDocument(next);
}

export function catalogDifference(current: RaidPlanDocument, release: CatalogRelease) {
  const currentSkills = new Map(current.definitions.skills.map((item) => [item.id, item]));
  const releaseSkills = release.playerSkills.filter((item) => item.enabled).map((item) => skillSnapshot(item, item.origin?.sourceId ?? crypto.randomUUID()));
  const currentMechanics = new Map(current.definitions.mechanics.map((item) => [item.id, item]));
  const releaseMechanics = release.bossMechanics.filter((item) => item.enabled).map((item) => mechanicSnapshot(item, item.origin?.sourceId ?? crypto.randomUUID()));
  const stripOrigin = <T extends { origin?: unknown }>(item: T) => {
    const { origin: _origin, ...rest } = item;
    void _origin;
    return rest;
  };
  const changed = <T extends { id: string; origin?: unknown }>(items: T[], existing: Map<string, T>) => items.filter((item) => {
    const value = existing.get(item.id);
    return value && JSON.stringify(stripOrigin(value)) !== JSON.stringify(stripOrigin(item));
  }).length;
  const catalogSources = current.sources.filter((item) => item.kind === "catalog");
  const currentSource = catalogSources.at(-1);
  const currentVersion = currentSource?.catalogVersion ?? "未记录";
  return {
    addedSkills: releaseSkills.filter((item) => !currentSkills.has(item.id)).length,
    changedSkills: changed(releaseSkills, currentSkills),
    removedSkills: current.definitions.skills.filter((item) => !releaseSkills.some((candidate) => candidate.id === item.id) && item.dataStatus !== "custom").length,
    addedMechanics: releaseMechanics.filter((item) => !currentMechanics.has(item.id)).length,
    changedMechanics: changed(releaseMechanics, currentMechanics),
    removedMechanics: current.definitions.mechanics.filter((item) => !releaseMechanics.some((candidate) => candidate.id === item.id) && item.dataStatus !== "custom").length,
    currentVersion,
    availableVersion: release.manifest.version,
    versionChanged: currentVersion !== "未记录" && currentVersion !== release.manifest.version,
  };
}
