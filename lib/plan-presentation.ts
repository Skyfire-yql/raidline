import type { PlayerSkillDefinition } from "./types";

export function skillEffectText(skill: PlayerSkillDefinition) {
  return skill.description.split("\n")[0].trim() || "暂无效果说明";
}
