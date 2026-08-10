import seedJson from "../data/catalog-seed.json" with { type: "json" };
import { normalizePlanDocument, snapTime } from "./core.ts";
import { normalizeCooldownDefinition } from "./skills.ts";
import type { BossMechanic, CatalogRelease, PlayerSkill, RaidMechanic, RaidPlanDocument, TimelinePreset } from "./types.ts";

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateCatalogRelease(value: unknown): CatalogRelease {
  if (!isObject(value) || !isObject(value.manifest)) throw new Error("目录缺少 manifest");
  const raw = structuredClone(value) as Record<string, unknown> & { manifest: Record<string, unknown> };
  if (raw.manifest.schemaVersion !== 1 && raw.manifest.schemaVersion !== 2 && raw.manifest.schemaVersion !== 3) throw new Error("不支持的目录版本");
  raw.manifest.schemaVersion = 3;
  raw.playerSkills = (Array.isArray(raw.playerSkills) ? raw.playerSkills : []).map((entry) => {
    const source = isObject(entry) ? entry : {};
    return {
      ...normalizeCooldownDefinition(source, {
        defaultStatus: "unconfigured",
        defaultCatalogVersion: String(raw.manifest.version ?? "unknown"),
      }),
      catalogVersion: String(raw.manifest.version ?? "unknown"),
      enabled: source.enabled !== false,
      gameVersion: String(source.gameVersion ?? raw.manifest.gameVersion ?? "retail"),
    } satisfies PlayerSkill;
  });
  raw.bossMechanics = (Array.isArray(raw.bossMechanics) ? raw.bossMechanics : []).map((entry) => {
    const item = { ...(entry as Record<string, unknown>) };
    delete item.difficulties;
    return item;
  });
  raw.timelinePresets = (Array.isArray(raw.timelinePresets) ? raw.timelinePresets : []).map((entry) => {
    const item = { ...(entry as Record<string, unknown>) };
    const encounter = isObject(item.encounter) ? item.encounter : {};
    item.encounter = { name: String(encounter.name ?? item.name ?? "未命名预设") };
    item.phases = (Array.isArray(item.phases) ? item.phases : []).map((phase) => {
      const source = phase as Record<string, unknown>;
      return { id: String(source.id ?? crypto.randomUUID()), name: String(source.name ?? "阶段"), atMs: snapTime(Number(source.atMs) || 0) };
    });
    item.timelineNotes = (Array.isArray(item.timelineNotes) ? item.timelineNotes : []).map((note) => {
      const source = note as Record<string, unknown>;
      return { id: String(source.id ?? crypto.randomUUID()), text: String(source.text ?? ""), atMs: snapTime(Number(source.atMs) || 0) };
    });
    item.mechanics = (Array.isArray(item.mechanics) ? item.mechanics : []).map((reference) => {
      const source = reference as Record<string, unknown>;
      return { mechanicId: String(source.mechanicId ?? ""), atMs: snapTime(Number(source.atMs) || 0), ...(source.phaseId ? { phaseId: String(source.phaseId) } : {}) };
    });
    delete item.difficulties;
    return item;
  });
  const release = raw as unknown as CatalogRelease;
  if (!VERSION_PATTERN.test(release.manifest.version)) throw new Error("目录版本标识无效");
  if (!Array.isArray(release.playerSkills) || !Array.isArray(release.bossMechanics) || !Array.isArray(release.timelinePresets)) throw new Error("目录数据不完整");
  const ids = new Set<string>();
  for (const item of [...release.playerSkills, ...release.bossMechanics, ...release.timelinePresets]) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) throw new Error("目录条目缺少 ID");
    if (ids.has(item.id)) throw new Error(`目录 ID 重复：${item.id}`);
    ids.add(item.id);
  }
  for (const skill of release.playerSkills) validatePlayerSkill(skill);
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

function validatePlayerSkill(skill: PlayerSkill) {
  if (!Number.isInteger(skill.maxCharges) || skill.maxCharges < 1 || skill.maxCharges > 10) throw new Error(`技能 ${skill.id} 的充能层数无效`);
  if (skill.castType === "instant" && skill.castTimeMs !== 0) throw new Error(`技能 ${skill.id} 的瞬发时间必须为 0`);
  if ((skill.castType === "cast" || skill.castType === "channel") && (skill.castTimeMs == null || skill.castTimeMs <= 0)) throw new Error(`技能 ${skill.id} 缺少有效施法或引导时间`);
  const variantIds = new Set<string>();
  for (const variant of skill.variants) {
    if (!VERSION_PATTERN.test(variant.id) || variantIds.has(variant.id)) throw new Error(`技能 ${skill.id} 的变体 ID 无效或重复`);
    if (!variant.name.trim()) throw new Error(`技能 ${skill.id} 的变体缺少名称`);
    variantIds.add(variant.id);
    if (variant.overrides.maxCharges != null && (!Number.isInteger(variant.overrides.maxCharges) || variant.overrides.maxCharges < 1 || variant.overrides.maxCharges > 10)) throw new Error(`技能 ${skill.id} 的变体充能层数无效`);
  }
  for (const source of skill.verification?.sources ?? []) {
    if (!source.label) throw new Error(`技能 ${skill.id} 的来源缺少名称`);
    if (source.url) {
      let parsed: URL;
      try { parsed = new URL(source.url); }
      catch { throw new Error(`技能 ${skill.id} 的来源链接无效`); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`技能 ${skill.id} 的来源链接无效`);
    }
  }
  if (skill.dataStatus !== "verified") return;
  if (skill.cooldownMs == null || skill.castType === "unknown" || skill.castTimeMs == null || skill.durationMs == null || skill.triggersGcd == null) throw new Error(`已核准技能 ${skill.id} 的基础时间数据不完整`);
  const verification = skill.verification;
  if (!verification || verification.gameVersion !== skill.gameVersion || verification.checkedAt == null || verification.checkedAt <= 0) throw new Error(`已核准技能 ${skill.id} 缺少匹配版本的核准记录`);
  if (!verification.sources.some((source) => source.kind === "blizzard" || source.kind === "in-game")) throw new Error(`已核准技能 ${skill.id} 缺少正式服或 Blizzard 主来源`);
  if (!verification.sources.some((source) => source.kind === "community")) throw new Error(`已核准技能 ${skill.id} 缺少社区复核来源`);
}

export const SEED_CATALOG = validateCatalogRelease(seedJson);

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
  next.timelineNotes = structuredClone(preset.timelineNotes);
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
  next.memberSkillVariants = [];
  next.assignments = [];
  next.catalogSource = { version: release.manifest.version, presetId: preset.id, appliedAt: Date.now() };
  return normalizePlanDocument(next);
}

export function catalogDifference(current: RaidPlanDocument, release: CatalogRelease) {
  const currentSkills = new Map(current.cooldowns.map((item) => [item.id, item]));
  const releaseSkills = release.playerSkills.filter((item) => item.enabled).map((item) => {
    const { enabled: _enabled, gameVersion: _gameVersion, ...definition } = item;
    void _enabled; void _gameVersion;
    return definition;
  });
  const releaseSkillIds = new Set(releaseSkills.map((item) => item.id));
  return {
    addedSkills: releaseSkills.filter((item) => !currentSkills.has(item.id)).length,
    changedSkills: releaseSkills.filter((item) => {
      const existing = currentSkills.get(item.id);
      return existing && existing.dataStatus !== "custom" && JSON.stringify(existing) !== JSON.stringify(item);
    }).length,
    removedSkills: current.cooldowns.filter((item) => !releaseSkillIds.has(item.id) && item.dataStatus !== "custom" && !item.id.startsWith("custom-")).length,
    currentVersion: current.catalogSource?.version ?? "未记录",
    availableVersion: release.manifest.version,
  };
}
