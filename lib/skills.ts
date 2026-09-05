import type { PlayerSkillDefinitionSnapshot, RaidPlanDocument, RosterSlot, SkillAssignment, SkillDataStatus, SkillTargetSelector, SkillVariant } from "./types";

export interface ResolvedSkillDefinition extends PlayerSkillDefinitionSnapshot {
  selectedVariant?: SkillVariant;
}

export type SkillTargetMode = "all" | "self";

export function skillTargetMode(target: SkillTargetSelector, memberId: string): SkillTargetMode | null {
  if (target.kind === "all") return "all";
  if (target.kind === "members" && target.memberIds.length === 1 && target.memberIds[0] === memberId) return "self";
  return null;
}

export function skillTargetsForMode(mode: SkillTargetMode, memberId: string): SkillTargetSelector {
  return mode === "self" ? { kind: "members", memberIds: [memberId] } : { kind: "all" };
}

export function defaultSkillTargets(skill: Pick<PlayerSkillDefinitionSnapshot, "scope">, memberId: string): SkillTargetSelector {
  return skillTargetsForMode(skill.scope === "personal" ? "self" : "all", memberId);
}

export function memberSkillVariantId(plan: RaidPlanDocument, memberId: string, skillDefinitionId: string) {
  return plan.roster.memberSkills.find((item) => item.memberId === memberId && item.skillDefinitionId === skillDefinitionId)?.variantId ?? undefined;
}

export function setMemberSkillVariant(plan: RaidPlanDocument, memberId: string, skillDefinitionId: string, variantId?: string) {
  plan.roster.memberSkills = plan.roster.memberSkills.filter((item) => item.memberId !== memberId || item.skillDefinitionId !== skillDefinitionId);
  plan.roster.memberSkills.push({ memberId, skillDefinitionId, variantId: variantId ?? null });
}

export function resolveSkillVariant(skill: PlayerSkillDefinitionSnapshot, variantId?: string | null): ResolvedSkillDefinition {
  const selectedVariant = skill.variants.find((item) => item.id === variantId);
  if (!selectedVariant) return skill;
  const overrides = selectedVariant.overrides;
  return {
    ...skill,
    ...(selectedVariant.spellId ? { spellId: selectedVariant.spellId } : {}),
    ...(overrides.cooldownMs !== undefined ? { cooldownMs: overrides.cooldownMs } : {}),
    ...(overrides.castType !== undefined ? { castType: overrides.castType } : {}),
    ...(overrides.castTimeMs !== undefined ? { castTimeMs: overrides.castTimeMs } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.triggersGcd !== undefined ? { triggersGcd: overrides.triggersGcd } : {}),
    ...(overrides.maxCharges !== undefined ? { maxCharges: overrides.maxCharges } : {}),
    ...(overrides.maxTargets !== undefined ? { maxTargets: overrides.maxTargets } : {}),
    ...(overrides.effects !== undefined ? { effects: structuredClone(overrides.effects) } : {}),
    limitations: [...skill.limitations, ...selectedVariant.limitations],
    selectedVariant,
  };
}

export function resolveSkillForMember(plan: RaidPlanDocument, memberId: string, skillOrId: PlayerSkillDefinitionSnapshot | string): ResolvedSkillDefinition | undefined {
  const skill = typeof skillOrId === "string" ? plan.definitions.skills.find((item) => item.id === skillOrId) : skillOrId;
  if (!skill) return undefined;
  return resolveSkillVariant(skill, memberSkillVariantId(plan, memberId, skill.id));
}

export function resolveSkillForAssignment(plan: RaidPlanDocument, assignment: SkillAssignment): ResolvedSkillDefinition | undefined {
  const definition = plan.definitions.skills.find(item => item.id === assignment.skillDefinitionId);
  if (!definition) return undefined;
  const skill = resolveSkillVariant(definition, assignment.variantId ?? memberSkillVariantId(plan, assignment.memberId, definition.id));
  return assignment.timing ? { ...skill, castTimeMs: assignment.timing.castTimeMs, durationMs: assignment.timing.durationMs } : skill;
}

export function skillAvailableToMember(skill: PlayerSkillDefinitionSnapshot, member: Pick<RosterSlot, "classSlug" | "specSlug">) {
  if (!member.classSlug || skill.classSlug !== member.classSlug) return false;
  if (!member.specSlug) return skill.specSlugs.length === 0;
  return skill.specSlugs.length === 0 || skill.specSlugs.includes(member.specSlug);
}

export function skillEffectStartMs(atMs: number, skill: Pick<PlayerSkillDefinitionSnapshot, "castType" | "castTimeMs">) {
  return skill.castType === "cast" ? atMs + (skill.castTimeMs ?? 0) : atMs;
}

export function skillBusyEndMs(atMs: number, skill: Pick<PlayerSkillDefinitionSnapshot, "castType" | "castTimeMs">) {
  return skill.castType === "cast" || skill.castType === "channel" ? atMs + (skill.castTimeMs ?? 0) : atMs;
}

export function skillDataStatusLabel(status: SkillDataStatus) {
  return ({
    unconfigured: "数值待补",
    "needs-live-check": "待正式服复核",
    verified: "已核准",
    custom: "计划自定义",
  } as const)[status];
}
