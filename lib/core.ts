import { DEFAULT_COOLDOWNS, WOW_CLASS_COLORS } from "./cooldowns.ts";
import type {
  CooldownDefinition,
  CooldownEffect,
  DamageSchool,
  RaidAssignment,
  RaidMechanic,
  RaidPlanDocument,
  RosterMember,
  TargetSelection,
} from "./types.ts";

export const PLAN_LIMITS = {
  groups: 20,
  roster: 40,
  phases: 40,
  mechanics: 1500,
  cooldowns: 250,
  assignments: 3000,
  bytes: 1_000_000,
} as const;

export const ALL_TARGETS: TargetSelection = { mode: "all" };
export const INHERIT_TARGETS: TargetSelection = { mode: "inherit" };

export function makeId(prefix = "id") {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${random}`;
}

export function createBlankPlan(title = "新建团本排轴", initialPhaseId = makeId("phase")): RaidPlanDocument {
  return {
    schemaVersion: 2,
    encounter: { name: title, difficulty: "史诗", durationMs: 480_000 },
    groups: [],
    roster: [],
    phases: [{ id: initialPhaseId, name: "P1", atMs: 0 }],
    mechanics: [],
    cooldowns: DEFAULT_COOLDOWNS.map((item) => structuredClone(item)),
    assignments: [],
    settings: {
      snapMs: 1000,
      showMinorMechanics: true,
      referenceMaxHealth: null,
      pressureResetMs: 10_000,
      defensiveLeadMs: 3000,
    },
  };
}

export function formatTime(ms: number) {
  const safe = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function parseTime(value: string) {
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Math.round(Number(normalized) * 1000);
  const match = normalized.match(/^(\d{1,3}):([0-5]?\d(?:\.\d+)?)$/);
  if (!match) return null;
  return Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000);
}

export function snapTime(ms: number, snapMs: number) {
  const snap = Math.max(100, snapMs || 1000);
  return Math.max(0, Math.round(ms / snap) * snap);
}

export function formatCompactNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "待补充";
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${trimNumber(value / 100_000_000)}亿`;
  if (absolute >= 10_000) return `${trimNumber(value / 10_000)}万`;
  return Math.round(value).toLocaleString("zh-CN");
}

function trimNumber(value: number) {
  return Number(value.toFixed(Math.abs(value) >= 100 ? 0 : 1)).toString();
}

function nullableNumber(value: unknown, fallback: number | null = null) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedTarget(value: unknown, fallback: TargetSelection = ALL_TARGETS): TargetSelection {
  if (!value || typeof value !== "object") return structuredClone(fallback);
  const target = value as Partial<TargetSelection>;
  if (!["all", "groups", "roles", "members", "inherit"].includes(String(target.mode))) return structuredClone(fallback);
  return {
    mode: target.mode!,
    ...(target.groupIds ? { groupIds: target.groupIds.map(String) } : {}),
    ...(target.roles ? { roles: target.roles.filter((item) => ["tank", "healer", "damage"].includes(item)) } : {}),
    ...(target.memberIds ? { memberIds: target.memberIds.map(String) } : {}),
  };
}

function normalizeEffect(value: unknown): CooldownEffect | null {
  if (!value || typeof value !== "object") return null;
  const effect = value as Record<string, unknown>;
  const schools: DamageSchool[] = Array.isArray(effect.schools)
    ? effect.schools.filter((item): item is DamageSchool => item === "physical" || item === "magic")
    : ["physical", "magic"];
  if (effect.type === "damageReduction") return { type: "damageReduction", percent: nullableNumber(effect.percent), schools };
  if (effect.type === "absorb") return { type: "absorb", amount: nullableNumber(effect.amount), allocation: effect.allocation === "shared" ? "shared" : "perTarget", schools };
  if (effect.type === "maxHealth") return { type: "maxHealth", percent: nullableNumber(effect.percent) };
  if (effect.type === "immunity") return { type: "immunity", schools };
  return null;
}

function normalizeCooldown(value: Record<string, unknown>, legacy = false): CooldownDefinition {
  const oldCategory = String(value.category ?? "自定义");
  const category = legacy && oldCategory === "减伤" ? "团队减伤" : oldCategory;
  return {
    id: String(value.id ?? makeId("spell")),
    ...(value.spellId == null ? {} : { spellId: Number(value.spellId) }),
    name: String(value.name ?? "未命名技能"),
    description: String(value.description ?? ""),
    classSlug: String(value.classSlug ?? "Warrior"),
    specSlugs: Array.isArray(value.specSlugs) ? value.specSlugs.map(String) : [],
    scope: value.scope === "personal" || value.scope === "external" ? value.scope : "team",
    cooldownMs: nullableNumber(value.cooldownMs),
    castTimeMs: legacy ? 0 : nullableNumber(value.castTimeMs),
    durationMs: nullableNumber(value.durationMs),
    triggersGcd: typeof value.triggersGcd === "boolean" ? value.triggersGcd : null,
    maxTargets: nullableNumber(value.maxTargets),
    effects: Array.isArray(value.effects) ? value.effects.map(normalizeEffect).filter((item): item is CooldownEffect => Boolean(item)) : [],
    category: (["团队减伤", "外部减伤", "个人减伤", "治疗", "免疫", "位移", "自定义"].includes(category) ? category : "自定义") as CooldownDefinition["category"],
    color: String(value.color ?? WOW_CLASS_COLORS[String(value.classSlug)] ?? "#7b8490"),
    catalogVersion: String(value.catalogVersion ?? (legacy ? "legacy-v1" : "custom")),
    dataStatus: legacy ? "legacy" : value.dataStatus === "unconfigured" || value.dataStatus === "legacy" ? value.dataStatus : "custom",
  };
}

export function normalizePlanDocument(value: unknown): RaidPlanDocument {
  if (!value || typeof value !== "object") throw new Error("计划内容不是有效对象");
  const source = structuredClone(value) as Record<string, unknown>;
  const legacy = source.schemaVersion === 1;
  if (!legacy && source.schemaVersion !== 2) throw new Error("不支持的计划版本");
  const encounter = (source.encounter ?? {}) as Record<string, unknown>;
  const oldSettings = (source.settings ?? {}) as Record<string, unknown>;
  const rawMechanics = Array.isArray(source.mechanics) ? source.mechanics as Array<Record<string, unknown>> : [];
  const mechanics: RaidMechanic[] = rawMechanics.map((item) => ({
    id: String(item.id ?? makeId("mechanic")),
    name: String(item.name ?? "未命名机制"),
    description: String(item.description ?? ""),
    atMs: Math.max(0, nullableNumber(item.atMs, 0) ?? 0),
    castTimeMs: legacy ? 0 : nullableNumber(item.castTimeMs),
    durationMs: nullableNumber(item.durationMs),
    damage: {
      school: (item.damage as Record<string, unknown> | undefined)?.school === "physical" ? "physical" : "magic",
      directAmount: nullableNumber((item.damage as Record<string, unknown> | undefined)?.directAmount),
      periodicAmount: nullableNumber((item.damage as Record<string, unknown> | undefined)?.periodicAmount),
      periodicIntervalMs: nullableNumber((item.damage as Record<string, unknown> | undefined)?.periodicIntervalMs),
      tickOnStart: Boolean((item.damage as Record<string, unknown> | undefined)?.tickOnStart),
    },
    targets: normalizedTarget(item.targets, ALL_TARGETS),
    ...(item.spellId == null ? {} : { spellId: Number(item.spellId) }),
    severity: item.severity === "info" || item.severity === "danger" ? item.severity : "warning",
    ...(item.phaseId ? { phaseId: String(item.phaseId) } : {}),
    source: item.source === "wcl" || item.source === "preset" ? item.source : "manual",
    note: String(item.note ?? ""),
  }));
  const mechanicMap = new Map(mechanics.map((item) => [item.id, item]));
  const cooldowns = (Array.isArray(source.cooldowns) ? source.cooldowns as Array<Record<string, unknown>> : []).map((item) => normalizeCooldown(item, legacy));
  const assignments: RaidAssignment[] = (Array.isArray(source.assignments) ? source.assignments as Array<Record<string, unknown>> : []).map((item) => {
    const mechanic = item.mechanicId ? mechanicMap.get(String(item.mechanicId)) : undefined;
    const atMs = Math.max(0, nullableNumber(item.atMs, 0) ?? 0);
    return {
      id: String(item.id ?? makeId("assignment")),
      memberId: String(item.memberId ?? ""),
      cooldownId: String(item.cooldownId ?? ""),
      ...(item.mechanicId ? { mechanicId: String(item.mechanicId) } : {}),
      atMs,
      ...(item.offsetMs != null ? { offsetMs: Number(item.offsetMs) } : mechanic ? { offsetMs: atMs - mechanicImpactMs(mechanic) } : {}),
      targets: normalizedTarget(item.targets, item.mechanicId ? INHERIT_TARGETS : ALL_TARGETS),
      note: String(item.note ?? ""),
      source: item.source === "wcl" ? "wcl" : "manual",
    };
  });
  const document: RaidPlanDocument = {
    schemaVersion: 2,
    encounter: {
      name: String(encounter.name ?? "未命名排轴"),
      difficulty: String(encounter.difficulty ?? "未设置"),
      durationMs: nullableNumber(encounter.durationMs, 480_000) ?? 480_000,
      ...(encounter.source ? { source: encounter.source as RaidPlanDocument["encounter"]["source"] } : {}),
    },
    groups: (Array.isArray(source.groups) ? source.groups as Array<Record<string, unknown>> : []).map((group) => ({
      id: String(group.id ?? makeId("group")), name: String(group.name ?? "未命名分组"), color: String(group.color ?? "#7b8490"),
    })),
    roster: (Array.isArray(source.roster) ? source.roster as Array<Record<string, unknown>> : []).map((member) => ({
      id: String(member.id ?? makeId("member")), name: String(member.name ?? "未命名成员"),
      classSlug: String(member.classSlug ?? "Warrior"), specSlug: String(member.specSlug ?? "未知专精"),
      role: member.role === "tank" || member.role === "healer" ? member.role : "damage",
      color: String(member.color ?? WOW_CLASS_COLORS[String(member.classSlug)] ?? "#7b8490"),
      ...(member.groupId ? { groupId: String(member.groupId) } : {}),
    })),
    phases: (Array.isArray(source.phases) ? source.phases as Array<Record<string, unknown>> : []).map((phase) => ({
      id: String(phase.id ?? makeId("phase")), name: String(phase.name ?? "阶段"), atMs: Math.max(0, nullableNumber(phase.atMs, 0) ?? 0),
    })),
    mechanics,
    cooldowns,
    assignments,
    settings: {
      snapMs: Math.max(100, nullableNumber(oldSettings.snapMs, 1000) ?? 1000),
      showMinorMechanics: oldSettings.showMinorMechanics !== false,
      referenceMaxHealth: legacy ? null : nullableNumber(oldSettings.referenceMaxHealth),
      pressureResetMs: legacy ? 10_000 : Math.max(0, nullableNumber(oldSettings.pressureResetMs, 10_000) ?? 10_000),
      defensiveLeadMs: legacy ? 3000 : Math.max(0, nullableNumber(oldSettings.defensiveLeadMs, 3000) ?? 3000),
    },
  };
  assertPlanDocument(document);
  return document;
}

export function assertPlanDocument(value: unknown): asserts value is RaidPlanDocument {
  if (!value || typeof value !== "object") throw new Error("计划内容不是有效对象");
  const plan = value as Partial<RaidPlanDocument>;
  if (plan.schemaVersion !== 2) throw new Error("不支持的计划版本");
  if (!plan.encounter || typeof plan.encounter.name !== "string" || !Number.isFinite(plan.encounter.durationMs)) throw new Error("战斗信息不完整");
  const arrays: Array<[keyof RaidPlanDocument, number]> = [
    ["groups", PLAN_LIMITS.groups], ["roster", PLAN_LIMITS.roster], ["phases", PLAN_LIMITS.phases],
    ["mechanics", PLAN_LIMITS.mechanics], ["cooldowns", PLAN_LIMITS.cooldowns], ["assignments", PLAN_LIMITS.assignments],
  ];
  for (const [key, limit] of arrays) {
    if (!Array.isArray(plan[key])) throw new Error(`计划缺少 ${key}`);
    if ((plan[key] as unknown[]).length > limit) throw new Error(`${key} 超出数量限制`);
  }
  if (plan.encounter.durationMs < 10_000 || plan.encounter.durationMs > 7_200_000) throw new Error("战斗时长需在 10 秒到 120 分钟之间");
  if (!plan.settings || plan.settings.referenceMaxHealth != null && plan.settings.referenceMaxHealth <= 0) throw new Error("参考最大生命必须大于 0 或留空");
  for (const mechanic of plan.mechanics ?? []) {
    for (const value of [mechanic.atMs, mechanic.castTimeMs, mechanic.durationMs, mechanic.damage.directAmount, mechanic.damage.periodicAmount, mechanic.damage.periodicIntervalMs]) {
      if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error("机制时间和伤害不能为负数");
    }
  }
  for (const cooldown of plan.cooldowns ?? []) {
    for (const value of [cooldown.cooldownMs, cooldown.castTimeMs, cooldown.durationMs, cooldown.maxTargets]) {
      if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error("技能时间和人数不能为负数");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > PLAN_LIMITS.bytes) throw new Error("计划内容超过 1 MB 限制");
}

export function mechanicImpactMs(mechanic: RaidMechanic) {
  return mechanic.atMs + (mechanic.castTimeMs ?? 0);
}

export function isDefensiveCooldown(cooldown: CooldownDefinition) {
  return cooldown.effects.some((effect) => effect.type !== "maxHealth" || effect.percent != null)
    || cooldown.category === "团队减伤" || cooldown.category === "外部减伤" || cooldown.category === "个人减伤" || cooldown.category === "免疫";
}

export function defaultAssignmentStart(plan: RaidPlanDocument, cooldown: CooldownDefinition, mechanic: RaidMechanic) {
  const impact = mechanicImpactMs(mechanic);
  return Math.max(0, isDefensiveCooldown(cooldown) ? impact - plan.settings.defensiveLeadMs : impact - (cooldown.castTimeMs ?? 0));
}

export function syncLinkedAssignments(plan: RaidPlanDocument, mechanicId: string) {
  const mechanic = plan.mechanics.find((item) => item.id === mechanicId);
  if (!mechanic) return;
  const impact = mechanicImpactMs(mechanic);
  for (const assignment of plan.assignments) {
    if (assignment.mechanicId === mechanicId && assignment.offsetMs != null) assignment.atMs = Math.max(0, impact + assignment.offsetMs);
  }
}

export function resolveTargetMemberIds(
  plan: RaidPlanDocument,
  target: TargetSelection,
  assignment?: RaidAssignment,
  mechanic?: RaidMechanic,
) {
  if (target.mode === "inherit") return resolveTargetMemberIds(plan, mechanic?.targets ?? ALL_TARGETS, assignment, mechanic);
  if (target.mode === "all") return plan.roster.map((member) => member.id);
  if (target.mode === "groups") {
    const groups = new Set(target.groupIds ?? []);
    return plan.roster.filter((member) => member.groupId && groups.has(member.groupId)).map((member) => member.id);
  }
  if (target.mode === "roles") {
    const roles = new Set(target.roles ?? []);
    return plan.roster.filter((member) => roles.has(member.role)).map((member) => member.id);
  }
  const members = new Set(target.memberIds ?? []);
  return plan.roster.filter((member) => members.has(member.id)).map((member) => member.id);
}

export interface DamageEvent {
  mechanicId: string;
  atMs: number;
  amount: number;
  school: DamageSchool;
}

export function buildMechanicDamageEvents(mechanic: RaidMechanic): DamageEvent[] {
  const events: DamageEvent[] = [];
  // null 表示机制读条长度未知；在用户明确填写前不能猜测伤害落点。
  if (mechanic.castTimeMs == null) return events;
  const impact = mechanicImpactMs(mechanic);
  if (mechanic.damage.directAmount != null && mechanic.damage.directAmount > 0) events.push({ mechanicId: mechanic.id, atMs: impact, amount: mechanic.damage.directAmount, school: mechanic.damage.school });
  const amount = mechanic.damage.periodicAmount;
  const interval = mechanic.damage.periodicIntervalMs;
  const duration = mechanic.durationMs;
  if (amount != null && amount > 0 && interval != null && interval > 0 && duration != null && duration > 0) {
    for (let offset = mechanic.damage.tickOnStart ? 0 : interval; offset <= duration; offset += interval) {
      events.push({ mechanicId: mechanic.id, atMs: impact + offset, amount, school: mechanic.damage.school });
    }
  }
  return events.sort((left, right) => left.atMs - right.atMs);
}

interface ResolvedEffect {
  assignment: RaidAssignment;
  cooldown: CooldownDefinition;
  effect: CooldownEffect;
  startMs: number;
  endMs: number;
  targetIds: string[];
  remaining?: Map<string, number>;
  sharedRemaining?: number;
}

export interface MemberPressureResult {
  memberId: string;
  currentDamage: number;
  previousDamage: number;
  pressure: number;
  effectiveMaxHealth: number | null;
  lethal: boolean | null;
}

export interface MechanicPressureResult {
  mechanicId: string;
  configured: boolean;
  firstDamageAtMs: number | null;
  lastDamageAtMs: number | null;
  rawPerTarget: number | null;
  averageDps: number | null;
  headlinePressure: number | null;
  teamCurrentDamage: number;
  teamPressure: number;
  members: MemberPressureResult[];
  missing: string[];
}

function effectApplies(effect: CooldownEffect, school: DamageSchool) {
  return effect.type === "maxHealth" || effect.schools.includes(school);
}

function resolveEffects(plan: RaidPlanDocument): ResolvedEffect[] {
  const cooldownMap = new Map(plan.cooldowns.map((item) => [item.id, item]));
  const mechanicMap = new Map(plan.mechanics.map((item) => [item.id, item]));
  const resolved: ResolvedEffect[] = [];
  for (const assignment of plan.assignments) {
    const cooldown = cooldownMap.get(assignment.cooldownId);
    // null 是未知而非瞬发；缺少施法或持续时间时不生成可能误导的效果区间。
    if (!cooldown || cooldown.castTimeMs == null || cooldown.durationMs == null) continue;
    const mechanic = assignment.mechanicId ? mechanicMap.get(assignment.mechanicId) : undefined;
    let targetIds = cooldown.scope === "personal"
      ? [assignment.memberId]
      : resolveTargetMemberIds(plan, assignment.targets, assignment, mechanic);
    if (cooldown.maxTargets != null) targetIds = targetIds.slice(0, Math.max(0, cooldown.maxTargets));
    const startMs = assignment.atMs + (cooldown.castTimeMs ?? 0);
    const endMs = startMs + cooldown.durationMs;
    for (const effect of cooldown.effects) {
      const entry: ResolvedEffect = { assignment, cooldown, effect, startMs, endMs, targetIds };
      if (effect.type === "absorb" && effect.amount != null) {
        if (effect.allocation === "shared") entry.sharedRemaining = effect.amount;
        else entry.remaining = new Map(targetIds.map((id) => [id, effect.amount ?? 0]));
      }
      resolved.push(entry);
    }
  }
  return resolved;
}

export function calculateMechanicPressure(plan: RaidPlanDocument): MechanicPressureResult[] {
  const effects = resolveEffects(plan);
  const mechanicMap = new Map(plan.mechanics.map((item) => [item.id, item]));
  const events = plan.mechanics.flatMap(buildMechanicDamageEvents).sort((left, right) => left.atMs - right.atMs || left.mechanicId.localeCompare(right.mechanicId));
  const damageByMechanic = new Map<string, Map<string, number>>();
  const timesByMechanic = new Map<string, { first: number; last: number }>();

  for (const event of events) {
    const mechanic = mechanicMap.get(event.mechanicId);
    if (!mechanic) continue;
    const targetIds = resolveTargetMemberIds(plan, mechanic.targets, undefined, mechanic);
    const times = timesByMechanic.get(mechanic.id) ?? { first: event.atMs, last: event.atMs };
    times.first = Math.min(times.first, event.atMs); times.last = Math.max(times.last, event.atMs);
    timesByMechanic.set(mechanic.id, times);
    const memberDamage = damageByMechanic.get(mechanic.id) ?? new Map<string, number>();
    for (const memberId of targetIds) {
      const active = effects.filter((item) => item.targetIds.includes(memberId) && item.startMs <= event.atMs && item.endMs >= event.atMs && effectApplies(item.effect, event.school));
      let damage = active.some((item) => item.effect.type === "immunity") ? 0 : event.amount;
      if (damage > 0) {
        for (const item of active) {
          if (item.effect.type === "damageReduction" && item.effect.percent != null) damage *= 1 - Math.min(100, Math.max(0, item.effect.percent)) / 100;
        }
        for (const item of active) {
          if (item.effect.type !== "absorb") continue;
          const remaining = item.effect.allocation === "shared"
            ? item.sharedRemaining ?? 0
            : item.remaining?.get(memberId) ?? 0;
          const used = Math.min(remaining, damage);
          damage -= used;
          if (item.effect.allocation === "shared") item.sharedRemaining = remaining - used;
          else item.remaining?.set(memberId, remaining - used);
        }
      }
      memberDamage.set(memberId, (memberDamage.get(memberId) ?? 0) + Math.max(0, damage));
    }
    damageByMechanic.set(mechanic.id, memberDamage);
  }

  const ordered = [...plan.mechanics].sort((left, right) => (timesByMechanic.get(left.id)?.first ?? mechanicImpactMs(left)) - (timesByMechanic.get(right.id)?.first ?? mechanicImpactMs(right)));
  const lastByMember = new Map<string, { damage: number; lastMs: number }>();
  const results: MechanicPressureResult[] = [];
  for (const mechanic of ordered) {
    const rawEvents = buildMechanicDamageEvents(mechanic);
    const missing: string[] = [];
    if (mechanic.damage.directAmount == null && mechanic.damage.periodicAmount == null) missing.push("伤害数值未填写");
    if (mechanic.castTimeMs == null) missing.push("机制施法长度未知");
    if (mechanic.durationMs == null) missing.push("机制持续时间未知");
    if (mechanic.damage.periodicAmount != null && (mechanic.damage.periodicIntervalMs == null || mechanic.durationMs == null)) missing.push("持续伤害参数不完整");
    const times = timesByMechanic.get(mechanic.id);
    const currentMap = damageByMechanic.get(mechanic.id) ?? new Map<string, number>();
    const members: MemberPressureResult[] = [];
    if (times) {
      for (const memberId of resolveTargetMemberIds(plan, mechanic.targets, undefined, mechanic)) {
        const currentDamage = currentMap.get(memberId) ?? 0;
        const previous = lastByMember.get(memberId);
        const previousDamage = previous && times.first - previous.lastMs <= plan.settings.pressureResetMs ? previous.damage : 0;
        const pressure = currentDamage + previousDamage;
        let effectiveMaxHealth = plan.settings.referenceMaxHealth;
        if (effectiveMaxHealth != null) {
          for (const item of effects) {
            if (item.effect.type === "maxHealth" && item.effect.percent != null && item.targetIds.includes(memberId) && item.startMs <= times.first && item.endMs >= times.first) {
              effectiveMaxHealth *= 1 + Math.max(0, item.effect.percent) / 100;
            }
          }
        }
        members.push({ memberId, currentDamage, previousDamage, pressure, effectiveMaxHealth, lethal: effectiveMaxHealth == null ? null : pressure >= effectiveMaxHealth });
        lastByMember.set(memberId, { damage: currentDamage, lastMs: times.last });
      }
    }
    const rawPerTarget = rawEvents.length ? rawEvents.reduce((sum, event) => sum + event.amount, 0) : null;
    const duration = mechanic.durationMs ?? 0;
    results.push({
      mechanicId: mechanic.id,
      configured: Boolean(times),
      firstDamageAtMs: times?.first ?? null,
      lastDamageAtMs: times?.last ?? null,
      rawPerTarget,
      averageDps: rawPerTarget != null && duration > 0 ? rawPerTarget / (duration / 1000) : null,
      headlinePressure: members.length ? Math.max(...members.map((item) => item.pressure)) : null,
      teamCurrentDamage: members.reduce((sum, item) => sum + item.currentDamage, 0),
      teamPressure: members.reduce((sum, item) => sum + item.pressure, 0),
      members,
      missing,
    });
  }
  return results;
}

export interface ConflictWarning {
  assignmentId?: string;
  mechanicId?: string;
  type: "cooldown" | "cast" | "gcd" | "bounds" | "missing" | "target" | "ownership" | "coverage" | "configuration";
  message: string;
}

export function detectConflicts(plan: RaidPlanDocument): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  const cooldowns = new Map(plan.cooldowns.map((item) => [item.id, item]));
  const members = new Map(plan.roster.map((item) => [item.id, item]));
  const mechanics = new Map(plan.mechanics.map((item) => [item.id, item]));
  const ordered = [...plan.assignments].sort((left, right) => left.atMs - right.atMs);
  for (const assignment of ordered) {
    const member = members.get(assignment.memberId);
    const cooldown = cooldowns.get(assignment.cooldownId);
    if (!member || !cooldown) {
      warnings.push({ assignmentId: assignment.id, type: "missing", message: "分配引用了已删除的成员或技能" });
      continue;
    }
    if (cooldown.castTimeMs == null) warnings.push({ assignmentId: assignment.id, type: "configuration", message: `${cooldown.name} 的施法长度未知；0 才表示明确瞬发` });
    if (cooldown.durationMs == null) warnings.push({ assignmentId: assignment.id, type: "configuration", message: `${cooldown.name} 的持续时间未知；0 才表示明确无持续` });
    if (cooldown.effects.some((effect) => (effect.type === "damageReduction" || effect.type === "maxHealth") ? effect.percent == null : effect.type === "absorb" && effect.amount == null)) {
      warnings.push({ assignmentId: assignment.id, type: "configuration", message: `${cooldown.name} 的计算效果数值尚未填写` });
    }
    const endMs = assignment.atMs + (cooldown.castTimeMs ?? 0) + (cooldown.durationMs ?? 0);
    if (assignment.atMs < 0 || endMs > plan.encounter.durationMs) warnings.push({ assignmentId: assignment.id, type: "bounds", message: `${member.name} 的 ${cooldown.name} 超出战斗时间` });
    if (cooldown.classSlug && cooldown.classSlug !== member.classSlug) warnings.push({ assignmentId: assignment.id, type: "ownership", message: `${member.name} 的职业与 ${cooldown.name} 不匹配` });
    const mechanic = assignment.mechanicId ? mechanics.get(assignment.mechanicId) : undefined;
    const targetIds = cooldown.scope === "personal" ? [member.id] : resolveTargetMemberIds(plan, assignment.targets, assignment, mechanic);
    if (cooldown.maxTargets != null && targetIds.length > cooldown.maxTargets) warnings.push({ assignmentId: assignment.id, type: "target", message: `${cooldown.name} 目标数 ${targetIds.length} 超过上限 ${cooldown.maxTargets}` });
    if (mechanic && isDefensiveCooldown(cooldown) && cooldown.castTimeMs != null && cooldown.durationMs != null) {
      const damageEvents = buildMechanicDamageEvents(mechanic);
      const first = damageEvents[0]?.atMs ?? mechanicImpactMs(mechanic);
      const last = damageEvents.at(-1)?.atMs ?? first;
      const effectStart = assignment.atMs + cooldown.castTimeMs;
      const effectEnd = effectStart + cooldown.durationMs;
      if (effectStart > first || effectEnd < last) warnings.push({ assignmentId: assignment.id, type: "coverage", message: `${cooldown.name} 未完整覆盖 ${mechanic.name}` });
    }
  }
  const byMember = new Map<string, RaidAssignment[]>();
  const byMemberAndSpell = new Map<string, RaidAssignment[]>();
  for (const assignment of ordered) {
    byMember.set(assignment.memberId, [...(byMember.get(assignment.memberId) ?? []), assignment]);
    const key = `${assignment.memberId}:${assignment.cooldownId}`;
    byMemberAndSpell.set(key, [...(byMemberAndSpell.get(key) ?? []), assignment]);
  }
  for (const assignments of byMemberAndSpell.values()) {
    for (let index = 1; index < assignments.length; index += 1) {
      const current = assignments[index]; const previous = assignments[index - 1];
      const cooldown = cooldowns.get(current.cooldownId);
      if (cooldown?.cooldownMs != null && current.atMs - previous.atMs < cooldown.cooldownMs) warnings.push({ assignmentId: current.id, type: "cooldown", message: `${cooldown.name} 尚未冷却完成` });
    }
  }
  for (const assignments of byMember.values()) {
    for (let index = 1; index < assignments.length; index += 1) {
      const current = assignments[index]; const previous = assignments[index - 1];
      const currentCooldown = cooldowns.get(current.cooldownId); const previousCooldown = cooldowns.get(previous.cooldownId);
      if (!currentCooldown || !previousCooldown) continue;
      const previousEnd = previous.atMs + (previousCooldown.castTimeMs ?? 0);
      if (current.atMs < previousEnd) warnings.push({ assignmentId: current.id, type: "cast", message: `${members.get(current.memberId)?.name ?? "成员"} 的施法区间重叠` });
      if (currentCooldown.triggersGcd === true && previousCooldown.triggersGcd === true && current.atMs - previous.atMs < 1500) warnings.push({ assignmentId: current.id, type: "gcd", message: "两项占用 GCD 的技能相隔不足 1.5 秒" });
    }
  }
  for (const mechanic of plan.mechanics) {
    if (mechanic.damage.directAmount == null && mechanic.damage.periodicAmount == null) warnings.push({ mechanicId: mechanic.id, type: "configuration", message: `${mechanic.name} 尚未填写伤害` });
    if (mechanic.castTimeMs == null) warnings.push({ mechanicId: mechanic.id, type: "configuration", message: `${mechanic.name} 的施法长度未知；0 才表示明确瞬发` });
    if (mechanic.durationMs == null) warnings.push({ mechanicId: mechanic.id, type: "configuration", message: `${mechanic.name} 的持续时间未知；0 才表示明确无持续` });
  }
  return warnings;
}

export function exportMrtNote(plan: RaidPlanDocument) {
  const members = new Map(plan.roster.map((item) => [item.id, item]));
  const cooldowns = new Map(plan.cooldowns.map((item) => [item.id, item]));
  const mechanics = new Map(plan.mechanics.map((item) => [item.id, item]));
  const lines = [`{time:00:00} ${plan.encounter.name} · ${plan.encounter.difficulty}`, ""];
  for (const assignment of [...plan.assignments].sort((left, right) => left.atMs - right.atMs)) {
    const member = members.get(assignment.memberId); const cooldown = cooldowns.get(assignment.cooldownId);
    if (!member || !cooldown) continue;
    const mechanic = assignment.mechanicId ? mechanics.get(assignment.mechanicId) : undefined;
    const suffix = [mechanic?.name, assignment.note].filter(Boolean).join(" · ");
    lines.push(`{time:${formatTime(assignment.atMs)}} ${member.name} — ${cooldown.name}${suffix ? `  # ${suffix}` : ""}`);
  }
  return lines.join("\n");
}

export function memberLabel(member: RosterMember) {
  return `${member.name} · ${member.specSlug}`;
}
