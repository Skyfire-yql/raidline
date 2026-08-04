export type RaidRole = "tank" | "healer" | "damage";
export type MechanicSeverity = "info" | "warning" | "danger";
export type DamageSchool = "physical" | "magic";
export type CooldownScope = "team" | "external" | "personal";
export type CooldownCategory = "团队减伤" | "外部减伤" | "个人减伤" | "治疗" | "免疫" | "位移" | "自定义";

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

export interface RaidGroup {
  id: string;
  name: string;
  color: string;
}

export interface RosterMember {
  id: string;
  name: string;
  classSlug: string;
  specSlug: string;
  role: RaidRole;
  color: string;
  groupId?: string;
}

export interface TargetSelection {
  mode: "all" | "groups" | "roles" | "members" | "inherit";
  groupIds?: string[];
  roles?: RaidRole[];
  memberIds?: string[];
}

export interface RaidPhase {
  id: string;
  name: string;
  atMs: number;
}

export interface MechanicDamageProfile {
  school: DamageSchool;
  directAmount: number | null;
  periodicAmount: number | null;
  periodicIntervalMs: number | null;
  tickOnStart: boolean;
}

export interface RaidMechanic {
  id: string;
  name: string;
  description: string;
  atMs: number;
  castTimeMs: number | null;
  durationMs: number | null;
  damage: MechanicDamageProfile;
  targets: TargetSelection;
  spellId?: number;
  severity: MechanicSeverity;
  phaseId?: string;
  source: "manual" | "wcl" | "preset";
  note: string;
}

export type CooldownEffect =
  | { type: "damageReduction"; percent: number | null; schools: DamageSchool[] }
  | { type: "absorb"; amount: number | null; allocation: "perTarget" | "shared"; schools: DamageSchool[] }
  | { type: "maxHealth"; percent: number | null }
  | { type: "immunity"; schools: DamageSchool[] };

export interface CooldownDefinition {
  id: string;
  spellId?: number;
  name: string;
  description: string;
  classSlug: string;
  specSlugs: string[];
  scope: CooldownScope;
  cooldownMs: number | null;
  castTimeMs: number | null;
  durationMs: number | null;
  triggersGcd: boolean | null;
  maxTargets: number | null;
  effects: CooldownEffect[];
  category: CooldownCategory;
  color: string;
  catalogVersion: string;
  dataStatus: "unconfigured" | "legacy" | "custom";
}

export interface RaidAssignment {
  id: string;
  memberId: string;
  cooldownId: string;
  mechanicId?: string;
  atMs: number;
  offsetMs?: number;
  targets: TargetSelection;
  note: string;
  source: "manual" | "wcl";
}

export interface RaidPlanSettings {
  snapMs: number;
  showMinorMechanics: boolean;
  referenceMaxHealth: number | null;
  pressureResetMs: number;
  defensiveLeadMs: number;
}

export interface RaidPlanDocument {
  schemaVersion: 2;
  encounter: EncounterInfo;
  groups: RaidGroup[];
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
