import type { SkillAssignment, TacticalDirective } from "./types";
import type { ResolvedSkillDefinition } from "./skills";

const generatedSkillNotes = new Set(["", "结束时间采用基础持续时长，并非完整实测覆盖。"].flatMap(duration => ["", "不代表原团队的完整战术计划或所有受益目标。"].map(targets => `来源为 WCL 中已施放且找到生效证据的记录；建轴后的调整不再代表原始日志。${duration}${targets}`)));

/** Presentation only: never rewrites a saved snapshot or a user's own note. */
export function skillAssignmentNoteText(assignment: SkillAssignment): string {
  return assignment.origin?.conversionRuleIds?.length && generatedSkillNotes.has(assignment.note) ? "" : assignment.note;
}

export function tacticalDirectiveText(directive: TacticalDirective): string {
  if (directive.kind === "note" && directive.timelinePresentation === "team-buff-window" && (
    directive.text === "嗜血类增益（实测窗口并集，不代表全员全程覆盖）"
    || /^嗜血类增益（至少 \d+ 人同时生效的实测区间，不代表全员覆盖）$/.test(directive.text)
  )) return "嗜血";
  return directive.text;
}

export function skillEffectText(skill: ResolvedSkillDefinition): string {
  const description = skill.selectedVariant?.overrides.effects !== undefined ? skill.selectedVariant.description : skill.description;
  return description.split("\n")[0].trim();
}
