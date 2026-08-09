import seedJson from "../data/catalog-seed.json" with { type: "json" };
import { normalizePlanDocument } from "./core.ts";
import type { BossMechanic, CatalogRelease, RaidMechanic, RaidPlanDocument, TimelinePreset } from "./types.ts";

export const SEED_CATALOG = structuredClone(seedJson) as unknown as CatalogRelease;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateCatalogRelease(value: unknown): CatalogRelease {
  if (!isObject(value) || !isObject(value.manifest)) throw new Error("目录缺少 manifest");
  const release = structuredClone(value) as unknown as CatalogRelease;
  if (release.manifest.schemaVersion !== 1) throw new Error("不支持的目录版本");
  if (!VERSION_PATTERN.test(release.manifest.version)) throw new Error("目录版本标识无效");
  if (!Array.isArray(release.playerSkills) || !Array.isArray(release.bossMechanics) || !Array.isArray(release.timelinePresets)) throw new Error("目录数据不完整");
  const ids = new Set<string>();
  for (const item of [...release.playerSkills, ...release.bossMechanics, ...release.timelinePresets]) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error("目录条目缺少 ID");
    if (ids.has(item.id)) throw new Error(`目录 ID 重复：${item.id}`);
    ids.add(item.id);
  }
  const mechanicIds = new Set(release.bossMechanics.map((item) => item.id));
  for (const preset of release.timelinePresets) {
    if (!Array.isArray(preset.mechanics)) throw new Error(`预设 ${preset.id} 缺少机制引用`);
    for (const reference of preset.mechanics) {
      if (!mechanicIds.has(reference.mechanicId)) throw new Error(`预设 ${preset.id} 引用了不存在的机制 ${reference.mechanicId}`);
      if (!Number.isFinite(reference.atMs) || reference.atMs < 0) throw new Error(`预设 ${preset.id} 的机制时间无效`);
    }
  }
  release.manifest.counts = {
    playerSkills: release.playerSkills.length,
    bossMechanics: release.bossMechanics.length,
    timelinePresets: release.timelinePresets.length,
  };
  return release;
}

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

function mechanicSnapshot(definition: BossMechanic, atMs: number, phaseId?: string): RaidMechanic {
  return {
    id: crypto.randomUUID(),
    name: definition.name,
    description: definition.description,
    atMs,
    castTimeMs: definition.castTimeMs,
    durationMs: definition.durationMs,
    damage: structuredClone(definition.damage),
    targets: structuredClone(definition.targets),
    ...(definition.spellId == null ? {} : { spellId: definition.spellId }),
    severity: definition.severity,
    ...(phaseId ? { phaseId } : {}),
    source: "preset",
    note: definition.note,
  };
}

export function applyCatalogPreset(current: RaidPlanDocument, release: CatalogRelease, preset: TimelinePreset) {
  const mechanics = new Map(release.bossMechanics.map((item) => [item.id, item]));
  const next = structuredClone(current);
  next.encounter = structuredClone(preset.encounter);
  next.phases = structuredClone(preset.phases);
  next.mechanics = preset.mechanics.map((reference) => {
    const definition = mechanics.get(reference.mechanicId);
    if (!definition) throw new Error(`预设引用的机制不存在：${reference.mechanicId}`);
    return mechanicSnapshot(definition, reference.atMs, reference.phaseId);
  });
  next.cooldowns = release.playerSkills.filter((item) => item.enabled).map((item) => {
    const { enabled: _enabled, gameVersion: _gameVersion, ...skill } = item;
    void _enabled; void _gameVersion;
    return structuredClone(skill);
  });
  next.assignments = [];
  next.catalogSource = { version: release.manifest.version, presetId: preset.id, appliedAt: Date.now() };
  return normalizePlanDocument(next);
}

export function catalogDifference(current: RaidPlanDocument, release: CatalogRelease) {
  const currentSkillIds = new Set(current.cooldowns.map((item) => item.id));
  const releaseSkillIds = new Set(release.playerSkills.filter((item) => item.enabled).map((item) => item.id));
  return {
    addedSkills: [...releaseSkillIds].filter((id) => !currentSkillIds.has(id)).length,
    removedSkills: [...currentSkillIds].filter((id) => !releaseSkillIds.has(id) && !id.startsWith("custom-")).length,
    currentVersion: current.catalogSource?.version ?? "未记录",
    availableVersion: release.manifest.version,
  };
}
