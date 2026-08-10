export type RaidRole = "tank" | "healer" | "damage";
export type MechanicSeverity = "info" | "warning" | "danger";
export type DamageSchool = "physical" | "magic";
export type CooldownScope = "team" | "external" | "personal";
export type CooldownCategory = "团队减伤" | "外部减伤" | "个人减伤" | "治疗" | "免疫" | "位移" | "自定义";
export type SkillCastType = "unknown" | "instant" | "cast" | "channel";
export type SkillDataStatus = "unconfigured" | "needs-live-check" | "verified" | "legacy" | "custom";

export interface WclSource {
  provider: "wcl";
  reportCode: string;
  fightId: number;
  reportRevision: number;
  importedAt: number;
}

export interface EncounterInfo {
  name: string;
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

export interface RaidTimelineNote {
  id: string;
  text: string;
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

export interface SkillVariantOverrides {
  cooldownMs?: number | null;
  castType?: SkillCastType;
  castTimeMs?: number | null;
  durationMs?: number | null;
  triggersGcd?: boolean | null;
  maxCharges?: number;
  maxTargets?: number | null;
  effects?: CooldownEffect[];
}

export interface SkillVariant {
  id: string;
  name: string;
  talentSpellId?: number;
  description: string;
  overrides: SkillVariantOverrides;
  limitations: string[];
}

export interface SkillSource {
  kind: "blizzard" | "in-game" | "community";
  label: string;
  url?: string;
  note?: string;
}

export interface SkillVerification {
  gameVersion: string;
  checkedAt: number | null;
  clientBuild?: string;
  sources: SkillSource[];
}

export interface CooldownDefinition {
  id: string;
  spellId?: number;
  name: string;
  description: string;
  classSlug: string;
  specSlugs: string[];
  scope: CooldownScope;
  cooldownMs: number | null;
  castType: SkillCastType;
  castTimeMs: number | null;
  durationMs: number | null;
  triggersGcd: boolean | null;
  maxCharges: number;
  maxTargets: number | null;
  effects: CooldownEffect[];
  variants: SkillVariant[];
  limitations: string[];
  verification?: SkillVerification;
  category: CooldownCategory;
  color: string;
  catalogVersion: string;
  dataStatus: SkillDataStatus;
}

export interface MemberSkillVariant {
  memberId: string;
  cooldownId: string;
  variantId: string;
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
  showMinorMechanics: boolean;
  referenceMaxHealth: number | null;
  pressureResetMs: number;
  defensiveLeadMs: number;
}

export interface RaidPlanDocument {
  schemaVersion: 5;
  encounter: EncounterInfo;
  groups: RaidGroup[];
  roster: RosterMember[];
  phases: RaidPhase[];
  timelineNotes: RaidTimelineNote[];
  mechanics: RaidMechanic[];
  cooldowns: CooldownDefinition[];
  memberSkillVariants: MemberSkillVariant[];
  assignments: RaidAssignment[];
  settings: RaidPlanSettings;
  catalogSource?: {
    version: string;
    presetId?: string;
    appliedAt: number;
  };
}

export interface PublicationBinding {
  shareId: string;
  editId: string;
  revisionId: string;
  publishedAt: number;
  contentHash: string;
}

export interface LocalPlanRecord {
  id: string;
  title: string;
  document: RaidPlanDocument;
  localRevision: number;
  createdAt: number;
  updatedAt: number;
  activePublication?: PublicationBinding;
}

export type SnapshotReason = "minute" | "publish" | "preset" | "catalog-upgrade" | "destructive" | "manual";

export interface PlanSnapshot {
  id: string;
  planId: string;
  localRevision: number;
  reason: SnapshotReason;
  createdAt: number;
  bytes: number;
  document: RaidPlanDocument;
}

export interface PublishedPlan {
  shareId: string;
  editId: string;
  revisionId: string;
  publishedAt: number;
  contentHash: string;
  document: RaidPlanDocument;
}

export type PublicPublication = Omit<PublishedPlan, "editId">;

export interface PlayerSkill extends CooldownDefinition {
  enabled: boolean;
  gameVersion: string;
}

export interface BossMechanic {
  id: string;
  name: string;
  description: string;
  gameVersion: string;
  raidId: string;
  bossId: string;
  enabled: boolean;
  spellId?: number;
  castTimeMs: number | null;
  durationMs: number | null;
  damage: MechanicDamageProfile;
  targets: TargetSelection;
  severity: MechanicSeverity;
  note: string;
}

export interface TimelinePreset {
  id: string;
  name: string;
  description: string;
  gameVersion: string;
  raidId: string;
  bossId: string;
  enabled: boolean;
  encounter: EncounterInfo;
  phases: RaidPhase[];
  timelineNotes: RaidTimelineNote[];
  mechanics: Array<{ mechanicId: string; atMs: number; phaseId?: string }>;
}

export interface CatalogManifest {
  schemaVersion: 3;
  version: string;
  gameVersion: string;
  title: string;
  publishedAt: number;
  counts: { playerSkills: number; bossMechanics: number; timelinePresets: number };
}

export interface CatalogRelease {
  manifest: CatalogManifest;
  playerSkills: PlayerSkill[];
  bossMechanics: BossMechanic[];
  timelinePresets: TimelinePreset[];
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
