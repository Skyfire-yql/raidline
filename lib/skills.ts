import { PLAYER_SKILLS } from "./player-skill-library";
import type { PlayerSkillDefinition, RosterSlot, SkillAssignment, SkillDataStatus, SkillTargetSelector } from "./types";

export type SkillTargetMode = "all" | "self";

export function skillTargetMode(target: SkillTargetSelector, memberId: string): SkillTargetMode | null {
  if (target.kind === "all") return "all";
  if (target.memberIds.length === 1 && target.memberIds[0] === memberId) return "self";
  return null;
}

export function skillTargetsForMode(mode: SkillTargetMode, memberId: string): SkillTargetSelector {
  return mode === "self" ? { kind: "members", memberIds: [memberId] } : { kind: "all" };
}

export function defaultSkillTargets(skill: Pick<PlayerSkillDefinition, "scope">, memberId: string): SkillTargetSelector {
  return skillTargetsForMode(skill.scope === "personal" ? "self" : "all", memberId);
}

export function resolveSkillForAssignment(assignment: SkillAssignment, library: readonly PlayerSkillDefinition[] = PLAYER_SKILLS): PlayerSkillDefinition | undefined {
  const skill = library.find(item => item.id === assignment.skillDefinitionId);
  return skill;
}

/** Alternate spell IDs affect observed timing; there is no player talent configuration. */
export function resolveObservedSkill(skill: PlayerSkillDefinition, spellId: number): PlayerSkillDefinition {
  const timing = skill.observedSpells.find(item => item.spellId === spellId);
  return timing ? { ...skill, ...timing } : skill;
}

export function skillAvailableToMember(skill: PlayerSkillDefinition, member: Pick<RosterSlot, "classSlug" | "specSlug">) {
  if (!member.classSlug || skill.classSlug !== member.classSlug) return false;
  if (!member.specSlug) return skill.specSlugs.length === 0;
  return skill.specSlugs.length === 0 || skill.specSlugs.includes(member.specSlug);
}

/** Total timeline span from cast start; it does not assert a healing/damage coverage window. */
export function skillTimelineDurationMs(skill: PlayerSkillDefinition) {
  const castMs = skill.castTimeMs ?? 0;
  return Math.max(castMs, (skill.castType === "cast" ? castMs : 0) + (skill.durationMs ?? 0));
}

export function skillDataStatusLabel(status: SkillDataStatus) {
  return ({ unconfigured: "数值待补", "needs-live-check": "待正式服复核", verified: "已核准", custom: "自定义" } as const)[status];
}
