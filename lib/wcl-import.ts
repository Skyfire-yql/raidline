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
  fetchedEventCount: number;
  retainedEventCount: number;
  discardedEventCount: number;
  pageCount: number;
  warningCount: number;
  unresolvedEventCount: number;
  mechanics: WclImportMechanicPreview[];
  plan: RaidPlanDocument;
}

export function selectWclImportMechanics(planValue: unknown, candidateIds: string[]) {
  const plan = structuredClone(parsePlanDocument(planValue));
  const selected = new Set(candidateIds);
  plan.timeline.mechanics = plan.timeline.mechanics.filter((occurrence) => selected.has(occurrence.id));
  const usedDefinitions = new Set(plan.timeline.mechanics.map((occurrence) => occurrence.definitionId));
  plan.definitions.mechanics = plan.definitions.mechanics.filter((definition) => usedDefinitions.has(definition.id));
  return parsePlanDocument(plan);
}
