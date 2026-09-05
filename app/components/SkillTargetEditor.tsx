"use client";

import { skillTargetMode, skillTargetsForMode } from "@/lib/skills";
import type { SkillTargetSelector } from "@/lib/types";

export function SkillTargetEditor({ target, memberId, onChange }: {
  target: SkillTargetSelector;
  memberId: string;
  onChange: (target: SkillTargetSelector) => void;
}) {
  const mode = skillTargetMode(target, memberId);
  return <div className="target-editor"><select aria-label="技能目标" value={mode ?? "preserved"} onChange={event => {
    const value = event.target.value;
    if (value === "all" || value === "self") onChange(skillTargetsForMode(value, memberId));
  }}>
    {mode === null && <option value="preserved" disabled hidden>保留原目标</option>}
    <option value="all">全团</option>
    <option value="self">自己</option>
  </select></div>;
}
