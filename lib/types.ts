export type RaidRole = "tank" | "healer" | "damage";
export type MechanicSeverity = "info" | "warning" | "danger";
export type CooldownCategory = "减伤" | "治疗" | "免疫" | "位移" | "自定义";

export interface WclSource {
  provider: "wcl";
  reportCode: string;
  fightId: number;
  reportRevision: number;
  importedAt: number;
}

export interface EncounterInfo {
  name: string;
  difficulty: string;
  durationMs: number;
  source?: WclSource;
}

export interface RosterMember {
  id: string;
  name: string;
  classSlug: string;
  specSlug: string;
  role: RaidRole;
  color: string;
}

export interface RaidPhase {
  id: string;
  name: string;
  atMs: number;
}

export interface RaidMechanic {
  id: string;
  name: string;
  atMs: number;
  durationMs?: number;
  spellId?: number;
  severity: MechanicSeverity;
  phaseId?: string;
  source: "manual" | "wcl";
  note: string;
}

export interface CooldownDefinition {
  id: string;
  spellId?: number;
  name: string;
  classSlug: string;
  cooldownMs: number;
  durationMs: number;
  category: CooldownCategory;
  color: string;
}

export interface RaidAssignment {
  id: string;
  memberId: string;
  cooldownId: string;
  mechanicId?: string;
  atMs: number;
  note: string;
  source: "manual" | "wcl";
}

export interface RaidPlanSettings {
  snapMs: number;
  zoom: number;
  showMinorMechanics: boolean;
}

export interface RaidPlanDocument {
  schemaVersion: 1;
  encounter: EncounterInfo;
  roster: RosterMember[];
  phases: RaidPhase[];
  mechanics: RaidMechanic[];
  cooldowns: CooldownDefinition[];
  assignments: RaidAssignment[];
  settings: RaidPlanSettings;
}

export interface StoredPlan {
  id: string;
  shareSlug: string;
  title: string;
  version: number;
  document: RaidPlanDocument;
  createdAt: number;
  updatedAt: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface WclFightSummary {
  id: number;
  name: string;
  encounterId: number;
  difficulty: number | null;
  difficultyLabel: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  kill: boolean;
  size: number | null;
}

export interface WclPreview {
  reportCode: string;
  title: string;
  visibility: string;
  revision: number;
  fights: WclFightSummary[];
  rateLimit?: {
    limitPerHour: number;
    pointsSpentThisHour: number;
    pointsResetIn: number;
  };
}

export interface WclAbilityGroup {
  spellId: number;
  name: string;
  count: number;
  timestamps: number[];
}

export interface WclImportAnalysis {
  reportCode: string;
  reportRevision: number;
  fight: WclFightSummary;
  roster: RosterMember[];
  phases: RaidPhase[];
  abilityGroups: WclAbilityGroup[];
  suggestedAssignments: RaidAssignment[];
  detectedCooldowns: CooldownDefinition[];
}
