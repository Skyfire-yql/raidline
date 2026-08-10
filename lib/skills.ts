import type {
  CooldownCategory,
  CooldownDefinition,
  CooldownEffect,
  DamageSchool,
  RaidPlanDocument,
  RosterMember,
  SkillCastType,
  SkillDataStatus,
  SkillSource,
  SkillVariant,
  SkillVariantOverrides,
  SkillVerification,
} from "./types.ts";

const CAST_TYPES = new Set<SkillCastType>(["unknown", "instant", "cast", "channel"]);
const DATA_STATUSES = new Set<SkillDataStatus>(["unconfigured", "needs-live-check", "verified", "legacy", "custom"]);
const CATEGORIES = new Set<CooldownCategory>(["团队减伤", "外部减伤", "个人减伤", "治疗", "免疫", "位移", "自定义"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableNumber(value: unknown, fallback: number | null = null) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : [];
}

export function normalizeCooldownEffect(value: unknown): CooldownEffect | null {
  if (!isObject(value)) return null;
  const schools: DamageSchool[] = Array.isArray(value.schools)
    ? value.schools.filter((item): item is DamageSchool => item === "physical" || item === "magic")
    : ["physical", "magic"];
  if (value.type === "damageReduction") return { type: "damageReduction", percent: nullableNumber(value.percent), schools };
  if (value.type === "absorb") return { type: "absorb", amount: nullableNumber(value.amount), allocation: value.allocation === "shared" ? "shared" : "perTarget", schools };
  if (value.type === "maxHealth") return { type: "maxHealth", percent: nullableNumber(value.percent) };
  if (value.type === "immunity") return { type: "immunity", schools };
  return null;
}

function normalizeOverrides(value: unknown): SkillVariantOverrides {
  if (!isObject(value)) return {};
  const result: SkillVariantOverrides = {};
  if (Object.hasOwn(value, "cooldownMs")) result.cooldownMs = nullableNumber(value.cooldownMs);
  if (Object.hasOwn(value, "castType") && CAST_TYPES.has(value.castType as SkillCastType)) result.castType = value.castType as SkillCastType;
  if (Object.hasOwn(value, "castTimeMs")) result.castTimeMs = nullableNumber(value.castTimeMs);
  if (Object.hasOwn(value, "durationMs")) result.durationMs = nullableNumber(value.durationMs);
  if (Object.hasOwn(value, "triggersGcd")) result.triggersGcd = typeof value.triggersGcd === "boolean" ? value.triggersGcd : null;
  if (Object.hasOwn(value, "maxCharges")) result.maxCharges = Math.max(1, Math.round(nullableNumber(value.maxCharges, 1) ?? 1));
  if (Object.hasOwn(value, "maxTargets")) result.maxTargets = nullableNumber(value.maxTargets);
  if (Object.hasOwn(value, "effects")) result.effects = Array.isArray(value.effects)
    ? value.effects.map(normalizeCooldownEffect).filter((item): item is CooldownEffect => Boolean(item))
    : [];
  if (result.castType === "instant") result.castTimeMs = 0;
  if (result.castType === "unknown") result.castTimeMs = null;
  return result;
}

function normalizeVariant(value: unknown, index: number): SkillVariant {
  const source = isObject(value) ? value : {};
  return {
    id: String(source.id ?? `variant-${index + 1}`).trim(),
    name: String(source.name ?? "未命名变体"),
    ...(source.talentSpellId == null || !Number.isFinite(Number(source.talentSpellId)) ? {} : { talentSpellId: Number(source.talentSpellId) }),
    description: String(source.description ?? ""),
    overrides: normalizeOverrides(source.overrides),
    limitations: stringArray(source.limitations),
  };
}

function normalizeSource(value: unknown): SkillSource | null {
  if (!isObject(value) || !["blizzard", "in-game", "community"].includes(String(value.kind))) return null;
  return {
    kind: value.kind as SkillSource["kind"],
    label: String(value.label ?? "").trim(),
    ...(value.url ? { url: String(value.url) } : {}),
    ...(value.note ? { note: String(value.note) } : {}),
  };
}

function normalizeVerification(value: unknown): SkillVerification | undefined {
  if (!isObject(value)) return undefined;
  return {
    gameVersion: String(value.gameVersion ?? ""),
    checkedAt: nullableNumber(value.checkedAt),
    ...(value.clientBuild ? { clientBuild: String(value.clientBuild) } : {}),
    sources: Array.isArray(value.sources) ? value.sources.map(normalizeSource).filter((item): item is SkillSource => Boolean(item)) : [],
  };
}

export interface NormalizeSkillOptions {
  legacy?: boolean;
  defaultStatus?: SkillDataStatus;
  defaultCatalogVersion?: string;
}

export function normalizeCooldownDefinition(value: unknown, options: NormalizeSkillOptions = {}): CooldownDefinition {
  const source = isObject(value) ? value : {};
  const legacy = options.legacy === true;
  // v1 omitted castTimeMs for the old implicit-instant shape. If an old
  // document did persist a cast length, preserve it and infer a real cast.
  const castTimeMs = legacy && !Object.hasOwn(source, "castTimeMs") ? 0 : nullableNumber(source.castTimeMs);
  const inferredCastType: SkillCastType = castTimeMs == null ? "unknown" : castTimeMs === 0 ? "instant" : "cast";
  const rawCastType = CAST_TYPES.has(source.castType as SkillCastType) ? source.castType as SkillCastType : inferredCastType;
  const castType = rawCastType;
  const oldCategory = String(source.category ?? "自定义");
  const category = legacy && oldCategory === "减伤" ? "团队减伤" : oldCategory;
  const requestedStatus = legacy ? "legacy" : source.dataStatus;
  const dataStatus = DATA_STATUSES.has(requestedStatus as SkillDataStatus)
    ? requestedStatus as SkillDataStatus
    : options.defaultStatus ?? "custom";
  const verification = normalizeVerification(source.verification);
  return {
    id: String(source.id ?? "skill-missing-id"),
    ...(source.spellId == null || !Number.isFinite(Number(source.spellId)) ? {} : { spellId: Number(source.spellId) }),
    name: String(source.name ?? "未命名技能"),
    description: String(source.description ?? ""),
    classSlug: String(source.classSlug ?? "Warrior"),
    specSlugs: stringArray(source.specSlugs),
    scope: source.scope === "personal" || source.scope === "external" ? source.scope : "team",
    cooldownMs: nullableNumber(source.cooldownMs),
    castType,
    castTimeMs: castType === "instant" ? 0 : castType === "unknown" ? null : castTimeMs,
    durationMs: nullableNumber(source.durationMs),
    triggersGcd: typeof source.triggersGcd === "boolean" ? source.triggersGcd : null,
    maxCharges: Math.max(1, Math.round(nullableNumber(source.maxCharges, 1) ?? 1)),
    maxTargets: nullableNumber(source.maxTargets),
    effects: Array.isArray(source.effects) ? source.effects.map(normalizeCooldownEffect).filter((item): item is CooldownEffect => Boolean(item)) : [],
    variants: Array.isArray(source.variants) ? source.variants.map(normalizeVariant) : [],
    limitations: stringArray(source.limitations),
    ...(verification ? { verification } : {}),
    category: CATEGORIES.has(category as CooldownCategory) ? category as CooldownCategory : "自定义",
    color: String(source.color ?? "#7b8490"),
    catalogVersion: String(source.catalogVersion ?? options.defaultCatalogVersion ?? (legacy ? "legacy-v1" : "custom")),
    dataStatus,
  };
}

export interface ResolvedCooldownDefinition extends CooldownDefinition {
  selectedVariant?: SkillVariant;
}

export function memberSkillVariantId(plan: RaidPlanDocument, memberId: string, cooldownId: string) {
  return plan.memberSkillVariants.find((item) => item.memberId === memberId && item.cooldownId === cooldownId)?.variantId;
}

export function setMemberSkillVariant(plan: RaidPlanDocument, memberId: string, cooldownId: string, variantId?: string) {
  plan.memberSkillVariants = plan.memberSkillVariants.filter((item) => item.memberId !== memberId || item.cooldownId !== cooldownId);
  if (variantId) plan.memberSkillVariants.push({ memberId, cooldownId, variantId });
}

export function resolveCooldownForMember(plan: RaidPlanDocument, memberId: string, cooldownOrId: CooldownDefinition | string): ResolvedCooldownDefinition | undefined {
  const cooldown = typeof cooldownOrId === "string" ? plan.cooldowns.find((item) => item.id === cooldownOrId) : cooldownOrId;
  if (!cooldown) return undefined;
  const variantId = memberSkillVariantId(plan, memberId, cooldown.id);
  const variant = variantId ? cooldown.variants.find((item) => item.id === variantId) : undefined;
  if (!variant) return { ...cooldown, limitations: [...cooldown.limitations] };
  const overrides = variant.overrides;
  const resolved = {
    ...cooldown,
    ...overrides,
    effects: overrides.effects == null ? structuredClone(cooldown.effects) : structuredClone(overrides.effects),
    limitations: [...new Set([...cooldown.limitations, ...variant.limitations])],
    variants: structuredClone(cooldown.variants),
    selectedVariant: structuredClone(variant),
  } satisfies ResolvedCooldownDefinition;
  resolved.maxCharges = Math.max(1, Math.round(resolved.maxCharges));
  if (resolved.castType === "instant") resolved.castTimeMs = 0;
  if (resolved.castType === "unknown") resolved.castTimeMs = null;
  return resolved;
}

export function skillAvailableToMember(cooldown: CooldownDefinition, member: Pick<RosterMember, "classSlug" | "specSlug">) {
  if (!member.classSlug || cooldown.classSlug !== member.classSlug) return false;
  if (cooldown.specSlugs.length === 0) return true;
  return Boolean(member.specSlug && cooldown.specSlugs.includes(member.specSlug));
}

export function skillEffectStartMs(atMs: number, cooldown: Pick<CooldownDefinition, "castType" | "castTimeMs">) {
  return atMs + (cooldown.castType === "cast" ? cooldown.castTimeMs ?? 0 : 0);
}

export function skillBusyEndMs(atMs: number, cooldown: Pick<CooldownDefinition, "castType" | "castTimeMs">) {
  return atMs + (cooldown.castType === "cast" || cooldown.castType === "channel" ? cooldown.castTimeMs ?? 0 : 0);
}

export function skillDataStatusLabel(status: SkillDataStatus) {
  return {
    unconfigured: "数值待补",
    "needs-live-check": "待正式服复核",
    verified: "已核准",
    legacy: "旧数据",
    custom: "已自定义",
  }[status];
}
