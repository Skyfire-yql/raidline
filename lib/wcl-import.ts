import { parsePlanDocument, type RaidPlanDocument } from "./types";

export interface WclImportMechanicPreview {
  candidateId: string;
  definitionId: string;
  name: string;
  startMs: number;
  impactMs: number;
  endMs: number;
  displayLabel?: string;
}

export interface WclImportPreview {
  reportCode: string;
  fightId: number;
  encounterId: number;
  encounterName: string;
  difficulty: "mythic";
  durationMs: number;
  gameVersion: string;
  encounterProfile: {
    id: string;
    profileVersion: number;
  };
  playerSkillProfile: { id: string; profileVersion: number; pendingSkillNames: string[] };
  fetchedEventCount: number;
  retainedEventCount: number;
  discardedEventCount: number;
  pageCount: number;
  warningCount: number;
  unresolvedEventCount: number;
  warnings: Array<{ code: string; message: string; objectId?: string }>;
  skills: Array<{ candidateId: string; memberId: string; definitionId: string; name: string; category: string; startMs: number; endMs: number }>;
  mechanics: WclImportMechanicPreview[];
  plan: RaidPlanDocument;
}

export function selectWclImportContent(planValue: unknown, selection: { mechanicIds: string[]; memberIds: string[]; assignmentIds: string[]; directiveIds?: string[] }) {
  const original = parsePlanDocument(planValue);
  for (const [selected, available] of [[selection.mechanicIds, original.timeline.mechanics.map(item => item.id)], [selection.memberIds, original.roster.members.map(item => item.id)], [selection.assignmentIds, original.timeline.skillAssignments.map(item => item.id)], [selection.directiveIds ?? [], original.timeline.directives.map(item => item.id)]]) {
    if (new Set(selected).size !== selected.length || selected.some(id => !available.includes(id))) throw new Error("导入选择已失效，请重新选择当前预览中的内容。");
  }
  const plan = selectWclImportMechanics(planValue, selection.mechanicIds);
  const members = new Set(selection.memberIds);
  const assignments = new Set(selection.assignmentIds);
  plan.timeline.directives = plan.timeline.directives.filter(note => selection.directiveIds?.includes(note.id));
  plan.roster.members = plan.roster.members.filter(member => members.has(member.id));
  plan.timeline.skillAssignments = plan.timeline.skillAssignments.filter(assignment => assignments.has(assignment.id));
  for (const assignment of plan.timeline.skillAssignments) {
    if (!members.has(assignment.memberId) || assignment.targets.kind === "members" && assignment.targets.memberIds.some(id => !members.has(id))) throw new Error("选中的技能依赖尚未选择的成员，请保留该成员或取消相关技能。");
  }
  const usedDefinitions = new Set(plan.timeline.skillAssignments.map(assignment => assignment.skillDefinitionId));
  plan.definitions.skills = plan.definitions.skills.filter(skill => usedDefinitions.has(skill.id));
  plan.roster.memberSkills = plan.roster.memberSkills.filter(selection => members.has(selection.memberId) && plan.timeline.skillAssignments.some(assignment => assignment.memberId === selection.memberId && assignment.skillDefinitionId === selection.skillDefinitionId));
  return parsePlanDocument(plan);
}

export function selectWclImportMechanics(planValue: unknown, candidateIds: string[]) {
  const plan = structuredClone(parsePlanDocument(planValue));
  const selected = new Set(candidateIds);
  plan.timeline.mechanics = plan.timeline.mechanics.filter((occurrence) => selected.has(occurrence.id));
  const usedDefinitions = new Set(plan.timeline.mechanics.map((occurrence) => occurrence.definitionId));
  plan.definitions.mechanics = plan.definitions.mechanics.filter((definition) => usedDefinitions.has(definition.id));
  return parsePlanDocument(plan);
}
