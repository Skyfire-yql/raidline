"use client";

import { useState } from "react";
import { formatTime } from "@/lib/core";
import { RAID_ROLE_BACKGROUNDS, specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import type { WclImportPreview } from "@/lib/wcl-import";

interface Props {
  preview: WclImportPreview;
  memberIds: string[];
  assignmentIds: string[];
  onSelection: (memberIds: string[], assignmentIds: string[]) => void;
}

const roleLabels = { tank: "坦克", healer: "治疗", damage: "DPS" };

export function WclPlayerImportPreview({ preview, memberIds, assignmentIds, onSelection }: Props) {
  const [role, setRole] = useState("");
  const [classSlug, setClassSlug] = useState("");
  const [category, setCategory] = useState("");
  const members = preview.plan.roster.members;
  const visibleMembers = members.filter(member => (!role || member.role === role) && (!classSlug || member.classSlug === classSlug));
  const skills = preview.skills.filter(skill => visibleMembers.some(member => member.id === skill.memberId) && (!category || skill.category === category));
  const assignments = preview.plan.timeline.skillAssignments;
  const selectable = (id: string, selectedMembers: string[]) => {
    const assignment = assignments.find(item => item.id === id)!;
    return selectedMembers.includes(assignment.memberId) && (assignment.targets.kind !== "members" || assignment.targets.memberIds.every(id => selectedMembers.includes(id)));
  };
  function selectMembers(next: string[]) {
    onSelection(next, assignmentIds.filter(id => selectable(id, next)));
  }
  const selectableVisibleIds = skills.filter(skill => selectable(skill.candidateId, memberIds)).map(skill => skill.candidateId);

  return <section className="wcl-player-preview" aria-label="匿名人员与玩家技能预览">
    <p>匿名名称可在建轴后修改。反魔法领域按成功施法导入，其他技能需有施放和生效记录。</p>
    <div className="wcl-player-filters">
      <label>职责<select aria-label="按职责筛选" value={role} onChange={event => setRole(event.target.value)}><option value="">全部职责</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>职业<select aria-label="按职业筛选" value={classSlug} onChange={event => setClassSlug(event.target.value)}><option value="">全部职业</option>{[...new Set(members.map(member => member.classSlug))].filter((value): value is string => Boolean(value)).map(value => <option key={value} value={value}>{WOW_CLASS_LABELS[value]}</option>)}</select></label>
      <label>技能类别<select aria-label="按技能类别筛选" value={category} onChange={event => setCategory(event.target.value)}><option value="">全部类别</option>{[...new Set(preview.skills.map(skill => skill.category))].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="wcl-mechanic-toolbar"><strong>人员 · 已选 {memberIds.length} / {members.length}</strong><button type="button" onClick={() => selectMembers(members.map(member => member.id))}>人员全选</button><button type="button" onClick={() => selectMembers([])}>人员全不选</button></div>
    <p className="field-note">取消成员会取消相关技能；重新选择成员不会自动重新勾选技能。</p>
    <div className="wcl-roster-list">{visibleMembers.map(member => <label key={member.id} style={{ borderLeftColor: member.color, background: member.role ? RAID_ROLE_BACKGROUNDS[member.role] : undefined }}>
      <input type="checkbox" checked={memberIds.includes(member.id)} onChange={event => selectMembers(event.target.checked ? [...memberIds, member.id] : memberIds.filter(id => id !== member.id))} />
      <span><strong>{member.name}</strong><small>{member.role ? roleLabels[member.role] : "职责待补"} · {specializationLabel(member.classSlug ?? "", member.specSlug ?? "")}</small></span>
    </label>)}</div>
    <div className="wcl-mechanic-toolbar"><strong>实际技能 · 已选 {assignmentIds.length} / {preview.skills.length}</strong><button type="button" onClick={() => onSelection(memberIds, [...new Set([...assignmentIds, ...selectableVisibleIds])])}>选中筛选结果</button><button type="button" onClick={() => onSelection(memberIds, assignmentIds.filter(id => !skills.some(skill => skill.candidateId === id)))}>取消筛选结果</button></div>
    <div className="wcl-mechanic-list wcl-skill-list">
      {skills.map(skill => <label key={skill.candidateId}>
        <input type="checkbox" checked={assignmentIds.includes(skill.candidateId)} disabled={!selectable(skill.candidateId, memberIds)} onChange={event => onSelection(memberIds, event.target.checked ? [...assignmentIds, skill.candidateId] : assignmentIds.filter(id => id !== skill.candidateId))} />
        <span><strong>{members.find(member => member.id === skill.memberId)?.name} · {skill.name}</strong><small>{formatTime(skill.startMs)} → {formatTime(skill.endMs)} · {skill.category}</small></span>
      </label>)}
      {!skills.length && <p>当前筛选下没有玩家技能。</p>}
    </div>
    <details><summary>来源与不确定性 · 玩家规则 v{preview.playerSkillProfile.profileVersion}</summary>
      <p>角色名未请求、未读取。计划按整秒保存时间；未观察到结束时使用基础时长。反魔法领域只确认成功施法，不推断实际覆盖目标。诊断只留在此处，不写入技能备注。</p>
      {preview.playerSkillProfile.pendingSkillNames.length > 0 && <p>已纳入技能范围、但自动识别尚待核准：{preview.playerSkillProfile.pendingSkillNames.join("、")}。这些项目没有自动建轴。</p>}
      {preview.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
      {preview.warningCount > preview.warnings.length && <p>另有 {preview.warningCount - preview.warnings.length} 条诊断未展开。</p>}
    </details>
  </section>;
}
