import { z } from "zod";

export const PLAN_SCHEMA_VERSION = 1 as const;
export const CATALOG_SCHEMA_VERSION = 1 as const;
export const COMBAT_LOG_SCHEMA_VERSION = 1 as const;
export const CONVERSION_PROFILE_SCHEMA_VERSION = 1 as const;
export const MAX_PLAN_BYTES = 1024 * 1024;
export const MAX_TIMELINE_MS = 7_200_000;
export const TIMELINE_SNAP_MS = 1000;

const Id = z.uuid();
const ShortText = z.string().max(120);
const LongText = z.string().max(10_000);
const Timestamp = z.number().int().nonnegative();
const Duration = z.number().int().nonnegative().max(MAX_TIMELINE_MS).nullable();
const WholeSecond = z.number().int().min(0).max(MAX_TIMELINE_MS).multipleOf(TIMELINE_SNAP_MS);
const RelativeWholeSecond = z.number().int().min(-MAX_TIMELINE_MS).max(MAX_TIMELINE_MS).multipleOf(TIMELINE_SNAP_MS);
const UniqueStrings = z.array(z.string().min(1).max(200)).max(500);

export const RaidRoleSchema = z.enum(["tank", "healer", "damage"]);
export const CooldownScopeSchema = z.enum(["team", "external", "personal"]);
export const SkillCastTypeSchema = z.enum(["unknown", "instant", "cast", "channel"]);
export const DataStatusSchema = z.enum(["unconfigured", "needs-live-check", "verified", "custom"]);
export const CooldownCategorySchema = z.enum(["团队减伤", "外部减伤", "个人减伤", "治疗", "免疫", "位移", "自定义"]);

export const EncounterExternalIdsSchema = z.strictObject({
  wclEncounterId: z.number().int().positive().optional(),
  wclZoneId: z.number().int().positive().optional(),
  blizzardJournalId: z.number().int().positive().optional(),
});

export const EncounterSnapshotSchema = z.strictObject({
  id: Id,
  name: ShortText,
  gameVersion: z.string().min(1).max(80),
  instance: z.strictObject({ id: Id, name: ShortText }).optional(),
  externalIds: EncounterExternalIdsSchema.optional(),
});

const CatalogPlanSourceSchema = z.strictObject({
  id: Id,
  kind: z.literal("catalog"),
  catalogVersion: z.string().min(1).max(80),
  presetId: Id.optional(),
  importedAt: Timestamp,
  contentHash: z.string().min(1).max(128).optional(),
});

const CombatLogPlanSourceSchema = z.strictObject({
  id: Id,
  kind: z.literal("combat-log"),
  provider: z.literal("wcl"),
  snapshotId: Id,
  reportCode: z.string().min(1).max(32),
  fightId: z.number().int().positive(),
  importedAt: Timestamp,
  normalizedDataHash: z.string().min(1).max(128),
  conversionProfiles: z.array(z.strictObject({ kind: z.enum(["encounter", "player-skill"]), id: Id, profileVersion: z.number().int().positive() })).max(2).optional(),
});

export const PlanSourceRecordSchema = z.discriminatedUnion("kind", [CatalogPlanSourceSchema, CombatLogPlanSourceSchema]);

export const ObjectOriginSchema = z.strictObject({
  sourceId: Id,
  sourceActorKeys: UniqueStrings.optional(),
  sourceEventKeys: UniqueStrings.optional(),
  conversionRuleIds: z.array(Id).max(100).optional(),
});

export const MemberSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("members"), memberIds: z.array(Id).max(100) }),
]);

export const SkillTargetSelectorSchema = MemberSelectorSchema;

export const TimelineAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pull"), offsetMs: WholeSecond }),
  z.strictObject({ kind: z.literal("phase"), phaseId: Id, offsetMs: RelativeWholeSecond }),
]);

export const RuntimeTriggerSchema = z.strictObject({
  event: z.enum(["cast-start", "cast-success", "aura-applied", "aura-removed"]),
  abilityGameId: z.number().int().positive(),
  occurrence: z.number().int().positive(),
});

export const RosterSlotSchema = z.strictObject({
  id: Id,
  name: ShortText,
  classSlug: z.string().min(1).max(40).nullable(),
  specSlug: z.string().min(1).max(80).nullable(),
  role: RaidRoleSchema.nullable(),
  color: z.string().min(1).max(32),
  origin: ObjectOriginSchema.optional(),
});

export const RaidPhaseSchema = z.strictObject({
  id: Id,
  name: ShortText,
  ordinal: z.number().int().positive().max(100),
  estimatedStartMs: WholeSecond,
  runtimeTrigger: RuntimeTriggerSchema.optional(),
  origin: ObjectOriginSchema.optional(),
});

export const DefinitionSourceSchema = z.strictObject({
  kind: z.enum(["blizzard", "in-game", "community"]),
  label: z.string().min(1).max(200),
  url: z.url().optional(),
  note: LongText.optional(),
});

export const DefinitionVerificationSchema = z.strictObject({
  gameVersion: z.string().min(1).max(80),
  checkedAt: Timestamp.nullable(),
  clientBuild: z.string().min(1).max(80).optional(),
  sources: z.array(DefinitionSourceSchema).max(30),
});

export const MechanicTimelinePointSchema = z.enum(["cast-start", "impact", "end"]);
export const MechanicTimelinePresentationPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("interval"),
    from: MechanicTimelinePointSchema,
    to: MechanicTimelinePointSchema,
    tone: z.enum(["context", "warning", "active"]),
    text: z.string().min(1).max(120),
  }),
  z.strictObject({
    kind: z.literal("marker"),
    at: MechanicTimelinePointSchema,
    tone: z.enum(["point", "judgment"]),
    text: z.string().min(1).max(120),
  }),
]);

const MECHANIC_TIMELINE_POINT_ORDER = { "cast-start": 0, impact: 1, end: 2 } as const;

export const MechanicTimelinePresentationSchema = z.strictObject({
  parts: z.array(MechanicTimelinePresentationPartSchema).min(1).max(8),
}).superRefine((presentation, context) => {
  const intervals = new Set<string>();
  const markers = new Set<string>();
  presentation.parts.forEach((part, index) => {
    if (part.kind === "interval") {
      if (MECHANIC_TIMELINE_POINT_ORDER[part.from] >= MECHANIC_TIMELINE_POINT_ORDER[part.to]) {
        context.addIssue({ code: "custom", path: ["parts", index, "to"], message: "机制展示区间的终点必须晚于起点" });
      }
      const key = `${part.from}:${part.to}`;
      if (intervals.has(key)) context.addIssue({ code: "custom", path: ["parts", index], message: "同一机制展示区间不能重复" });
      intervals.add(key);
      return;
    }
    if (markers.has(part.at)) context.addIssue({ code: "custom", path: ["parts", index], message: "同一机制展示时点不能重复" });
    markers.add(part.at);
  });
});

export const MechanicDefinitionSnapshotSchema = z.strictObject({
  id: Id,
  name: ShortText,
  description: LongText,
  gameVersion: z.string().min(1).max(80),
  abilityGameIds: z.array(z.number().int().positive()).max(20),
  castTimeMs: Duration,
  durationMs: Duration,
  timelinePresentation: MechanicTimelinePresentationSchema,
  color: z.string().min(1).max(32),
  dataStatus: DataStatusSchema,
  limitations: z.array(z.string().min(1).max(500)).max(30),
  verification: DefinitionVerificationSchema.optional(),
  origin: ObjectOriginSchema.optional(),
});

export const MechanicOccurrenceSchema = z.strictObject({
  id: Id,
  definitionId: Id,
  anchor: TimelineAnchorSchema,
  displayLabel: ShortText.optional(),
  timing: z.strictObject({
    castTimeMs: WholeSecond,
    durationMs: WholeSecond,
  }).optional(),
  runtimeTrigger: RuntimeTriggerSchema.optional(),
  origin: ObjectOriginSchema.optional(),
});

export const PlayerSkillDefinitionSchema = z.strictObject({
  id: Id,
  spellId: z.number().int().positive().optional(),
  name: ShortText,
  description: LongText,
  gameVersion: z.string().min(1).max(80),
  classSlug: z.string().min(1).max(40),
  specSlugs: z.array(z.string().min(1).max(80)).max(10),
  scope: CooldownScopeSchema,
  cooldownMs: Duration,
  castType: SkillCastTypeSchema,
  castTimeMs: Duration,
  durationMs: Duration,
  maxCharges: z.number().int().min(1).max(10),
  observedSpells: z.array(z.strictObject({
    spellId: z.number().int().positive(),
    castTimeMs: Duration.optional(),
    durationMs: Duration.optional(),
  })).max(20),
  limitations: z.array(z.string().min(1).max(500)).max(30),
  verification: DefinitionVerificationSchema.optional(),
  category: CooldownCategorySchema,
  color: z.string().min(1).max(32),
  dataStatus: DataStatusSchema,
});

const TimedDirectiveScopeSchema = z.strictObject({ kind: z.literal("timed"), anchor: TimelineAnchorSchema });
const PhaseDirectiveScopeSchema = z.strictObject({ kind: z.literal("phase"), phaseId: Id });
const PlanDirectiveScopeSchema = z.strictObject({ kind: z.literal("plan") });

export const TacticalTaskSchema = z.strictObject({
  id: Id,
  kind: z.literal("task"),
  text: LongText,
  scope: z.union([TimedDirectiveScopeSchema, PhaseDirectiveScopeSchema]),
  assignees: MemberSelectorSchema,
  durationMs: Duration,
  origin: ObjectOriginSchema.optional(),
});

export const TacticalNoteSchema = z.strictObject({
  id: Id,
  kind: z.literal("note"),
  text: LongText,
  scope: z.union([TimedDirectiveScopeSchema, PhaseDirectiveScopeSchema, PlanDirectiveScopeSchema]),
  durationMs: Duration,
  timelinePresentation: z.literal("team-buff-window").optional(),
  origin: ObjectOriginSchema.optional(),
});

export const TacticalDirectiveSchema = z.discriminatedUnion("kind", [TacticalTaskSchema, TacticalNoteSchema]);

export const SkillAssignmentSchema = z.strictObject({
  id: Id,
  memberId: Id,
  skillDefinitionId: Id,
  anchor: TimelineAnchorSchema,
  targets: SkillTargetSelectorSchema,
  note: LongText,
  observedDurationMs: WholeSecond.optional(),
  origin: ObjectOriginSchema.optional(),
});

export const RaidPlanDocumentSchema = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  metadata: z.strictObject({ title: ShortText }),
  encounter: EncounterSnapshotSchema,
  sources: z.array(PlanSourceRecordSchema).max(100),
  definitions: z.strictObject({
    mechanics: z.array(MechanicDefinitionSnapshotSchema).max(500),
  }),
  roster: z.strictObject({
    members: z.array(RosterSlotSchema).max(100),
  }),
  timeline: z.strictObject({
    phases: z.array(RaidPhaseSchema).min(1).max(100),
    mechanics: z.array(MechanicOccurrenceSchema).max(1000),
    directives: z.array(TacticalDirectiveSchema).max(2000),
    skillAssignments: z.array(SkillAssignmentSchema).max(2000),
  }),
  templateSourceId: Id.optional(),
});

export const CatalogSkillDefinitionSchema = PlayerSkillDefinitionSchema.extend({ enabled: z.boolean() }).strict();
export const CatalogMechanicDefinitionSchema = MechanicDefinitionSnapshotSchema.extend({ encounterId: Id, enabled: z.boolean() }).strict();

export const TimelinePresetSchema = z.strictObject({
  id: Id,
  name: ShortText,
  description: LongText,
  enabled: z.boolean(),
  encounter: EncounterSnapshotSchema,
  phases: z.array(RaidPhaseSchema).min(1).max(100),
  mechanics: z.array(MechanicOccurrenceSchema).max(1000),
  notes: z.array(TacticalNoteSchema).max(1000),
});

export const CatalogManifestSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/),
  gameVersion: z.string().min(1).max(80),
  title: ShortText,
  publishedAt: Timestamp,
  counts: z.strictObject({ playerSkills: z.number().int().nonnegative(), bossMechanics: z.number().int().nonnegative(), timelinePresets: z.number().int().nonnegative() }),
});

export const CatalogReleaseSchema = z.strictObject({
  manifest: CatalogManifestSchema,
  playerSkills: z.array(CatalogSkillDefinitionSchema).max(5000),
  bossMechanics: z.array(CatalogMechanicDefinitionSchema).max(5000),
  timelinePresets: z.array(TimelinePresetSchema).max(1000),
});

export const ObservedActorSchema = z.strictObject({
  actorKey: z.string().min(1).max(100),
  reportActorId: z.number().int().positive(),
  gameId: z.number().int().positive().optional(),
  type: z.enum(["player", "pet", "npc", "other"]),
  name: ShortText,
  server: ShortText.optional(),
  classSlug: z.string().min(1).max(40).optional(),
  specSlug: z.string().min(1).max(80).optional(),
  ownerActorKey: z.string().min(1).max(100).optional(),
});

export const ObservedPhaseSchema = z.strictObject({
  id: Id,
  semanticPhaseId: z.number().int().nonnegative(),
  occurrenceIndex: z.number().int().positive(),
  atMs: Timestamp,
});

export const ObservedEventSchema = z.strictObject({
  eventKey: z.string().min(1).max(200),
  atMs: Timestamp,
  type: z.enum(["cast-start", "cast-success", "aura-applied", "aura-removed", "damage", "healing", "absorb", "interrupt", "dispel", "death", "resurrection"]),
  abilityGameId: z.number().int().positive().optional(),
  sourceActorKey: z.string().min(1).max(100).optional(),
  targetActorKey: z.string().min(1).max(100).optional(),
  amount: z.number().nonnegative().optional(),
  durationMs: Timestamp.optional(),
  stack: z.number().int().nonnegative().optional(),
});

export const CombatLogSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(COMBAT_LOG_SCHEMA_VERSION),
  id: Id,
  provider: z.literal("wcl"),
  normalizerVersion: z.string().min(1).max(80),
  importedAt: Timestamp,
  source: z.strictObject({
    reportCode: z.string().min(1).max(32),
    fightId: z.number().int().positive(),
    reportRevision: z.number().int().nonnegative(),
    reportStartEpochMs: Timestamp,
    fightStartReportMs: Timestamp,
    fightEndReportMs: Timestamp,
    gameVersionKey: z.string().min(1).max(80),
    logVersion: z.number().int().nonnegative().optional(),
    gameVersion: z.number().int().nonnegative().optional(),
    language: z.string().min(1).max(20).optional(),
  }),
  encounter: z.strictObject({
    encounterId: z.number().int().positive(),
    zoneId: z.number().int().positive().optional(),
    journalId: z.number().int().positive().optional(),
    name: ShortText,
    kill: z.boolean(),
    durationMs: Timestamp,
  }),
  actors: z.array(ObservedActorSchema).max(500),
  phases: z.array(ObservedPhaseSchema).max(100),
  events: z.array(ObservedEventSchema).max(200_000),
  contentHash: z.string().min(1).max(128),
});

export const EventCollectionRuleSchema = z.strictObject({
  id: Id,
  enabled: z.boolean(),
  dataType: z.enum(["casts", "buffs", "debuffs", "deaths", "damage", "healing", "interrupts", "dispels", "combatant-info"]),
  eventTypes: z.array(ObservedEventSchema.shape.type).min(1).max(20).optional(),
  hostility: z.enum(["friendly", "enemy", "any"]),
  abilityGameIds: z.array(z.number().int().positive()).max(500).optional(),
  uses: z.array(z.enum(["timeline", "relationship", "validation", "replay"])).min(1).max(4),
  purpose: z.string().min(1).max(500),
});

const RuleVerificationSchema = z.strictObject({
  reviewedAt: Timestamp,
  sourceReportCodes: z.array(z.string().min(1).max(32)).min(1).max(100),
});

const EventRuleMatchSchema = z.strictObject({
  eventTypes: z.array(ObservedEventSchema.shape.type).min(1).max(20),
  abilityGameIds: z.array(z.number().int().positive()).min(1).max(500),
  sourceNpcGameIds: z.array(z.number().int().positive()).max(500).optional(),
  sourceActorType: z.enum(["player", "pet", "npc"]).optional(),
});

const EventDeduplicationSchema = z.strictObject({
  windowMs: Timestamp,
  groupBy: z.array(z.enum(["source", "target", "ability"])).min(1).max(3),
});

const OccurrenceDisplaySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stack"),
    prefix: z.string().max(40),
    missingValue: z.number().int().nonnegative().optional(),
  }),
]);

export const EventConversionRuleSchema = z.strictObject({
  id: Id,
  enabled: z.boolean(),
  match: EventRuleMatchSchema,
  convertTo: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("phase"), definitionId: Id }),
    z.strictObject({
      kind: z.literal("mechanic"),
      definitionId: Id,
      timingPoint: z.enum(["cast-start", "impact", "end"]),
      display: OccurrenceDisplaySchema.optional(),
    }),
  ]),
  deduplication: EventDeduplicationSchema.optional(),
  notes: LongText,
  verification: RuleVerificationSchema,
});

export const EncounterConversionProfileSchema = z.strictObject({
  schemaVersion: z.literal(CONVERSION_PROFILE_SCHEMA_VERSION),
  id: Id,
  encounterId: z.number().int().positive(),
  gameVersion: z.string().min(1).max(80),
  profileVersion: z.number().int().positive(),
  status: z.enum(["draft", "published", "retired"]),
  mechanicDefinitions: z.array(MechanicDefinitionSnapshotSchema).max(500),
  collectionRules: z.array(EventCollectionRuleSchema).max(1000),
  conversionRules: z.array(EventConversionRuleSchema).max(1000),
  notes: LongText,
});

export const PlayerSkillExtractionRuleSchema = z.strictObject({
  id: Id,
  enabled: z.boolean(),
  definitionId: Id,
  match: EventRuleMatchSchema.extend({ sourceActorType: z.enum(["player", "pet"]) }).strict(),
  timingPoint: z.enum(["cast-start", "impact", "end"]),
  deduplication: EventDeduplicationSchema.optional(),
  confirmation: z.union([z.strictObject({ kind: z.literal("cast-success") }), z.strictObject({
    eventTypes: z.array(z.enum(["aura-applied", "healing", "absorb", "dispel"])).min(1).max(4),
    abilityGameIds: z.array(z.number().int().positive()).min(1).max(50),
    windowMs: Timestamp.max(30000),
    target: z.enum(["self", "friendly", "cast-target"]),
    minimumTargets: z.number().int().min(1).max(100),
  })]),
  notes: LongText,
  verification: z.strictObject({
    reviewedAt: Timestamp,
    sourceReportCodes: z.array(z.string().min(1).max(32)).max(100),
    status: z.enum(["pending", "fixture-verified", "live-verified"]),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(30),
  }),
});

export const PlayerSkillExtractionProfileSchema = z.strictObject({
  schemaVersion: z.literal(CONVERSION_PROFILE_SCHEMA_VERSION),
  id: Id,
  gameVersion: z.string().min(1).max(80),
  profileVersion: z.number().int().positive(),
  status: z.enum(["draft", "published", "retired"]),
  collectionRules: z.array(EventCollectionRuleSchema).max(1000),
  extractionRules: z.array(PlayerSkillExtractionRuleSchema).max(1000),
  backgroundWindowRules: z.array(z.strictObject({
    id: Id, enabled: z.boolean(), kind: z.literal("bloodlust"),
    abilityGameIds: z.array(z.number().int().positive()).min(1).max(20),
    maximumDurationMs: z.number().int().min(1000).max(60000),
    minimumTargets: z.number().int().min(2).max(40),
    verification: PlayerSkillExtractionRuleSchema.shape.verification,
  })).max(10).optional(),
  notes: LongText,
});

const ImportCandidateBaseSchema = z.strictObject({
  id: Id,
  sourceEventKeys: UniqueStrings,
  conversionRuleIds: z.array(Id).max(100),
});

export const PlanImportDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: Id,
  snapshotId: Id,
  conversionProfileId: Id,
  conversionProfileVersion: z.number().int().positive(),
  playerSkillProfile: z.strictObject({ id: Id, profileVersion: z.number().int().positive() }).optional(),
  noteCandidates: z.array(ImportCandidateBaseSchema.extend({ note: TacticalNoteSchema }).strict()).max(100).optional(),
  rosterCandidates: z.array(ImportCandidateBaseSchema.extend({ actorKey: z.string().min(1).max(100), slot: RosterSlotSchema }).strict()).max(100),
  phaseCandidates: z.array(ImportCandidateBaseSchema.extend({ phase: RaidPhaseSchema }).strict()).max(100),
  mechanicCandidates: z.array(ImportCandidateBaseSchema.extend({
    definition: MechanicDefinitionSnapshotSchema,
    observed: z.strictObject({
      startMs: Timestamp,
      impactMs: Timestamp,
      endMs: Timestamp,
      displayLabel: ShortText.optional(),
    }),
      runtimeTrigger: RuntimeTriggerSchema.optional(),
  }).strict()).max(1000),
  skillAssignmentCandidates: z.array(ImportCandidateBaseSchema.extend({ assignment: SkillAssignmentSchema,
    observed: z.strictObject({ startMs: Timestamp, impactMs: Timestamp, endMs: Timestamp }).optional(),
  }).strict()).max(5000),
  unresolvedEvents: z.array(z.strictObject({ eventKey: z.string().min(1).max(200), reason: LongText })).max(10_000),
  warnings: z.array(z.strictObject({ code: z.string().min(1).max(80), message: LongText, objectId: Id.optional() })).max(10_000),
});

export const ComparisonRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: Id,
  planId: Id,
  planRevisionHash: z.string().min(1).max(128),
  snapshotId: Id,
  conversionProfileId: Id,
  conversionProfileVersion: z.number().int().positive(),
  createdAt: Timestamp,
  results: z.array(z.strictObject({
    id: Id,
    plannedObjectId: Id.optional(),
    observedEventKeys: UniqueStrings,
    status: z.enum(["matched", "early", "late", "missed", "extra", "wrong-member", "wrong-target", "ambiguous", "unverifiable"]),
    offsetMs: z.number().int().optional(),
    message: LongText,
  })).max(20_000),
});

export type RaidRole = z.infer<typeof RaidRoleSchema>;
export type CooldownScope = z.infer<typeof CooldownScopeSchema>;
export type SkillCastType = z.infer<typeof SkillCastTypeSchema>;
export type SkillDataStatus = z.infer<typeof DataStatusSchema>;
export type CooldownCategory = z.infer<typeof CooldownCategorySchema>;
export type EncounterSnapshot = z.infer<typeof EncounterSnapshotSchema>;
export type PlanSourceRecord = z.infer<typeof PlanSourceRecordSchema>;
export type ObjectOrigin = z.infer<typeof ObjectOriginSchema>;
export type MemberSelector = z.infer<typeof MemberSelectorSchema>;
export type SkillTargetSelector = z.infer<typeof SkillTargetSelectorSchema>;
export type TimelineAnchor = z.infer<typeof TimelineAnchorSchema>;
export type RuntimeTrigger = z.infer<typeof RuntimeTriggerSchema>;
export type RosterSlot = z.infer<typeof RosterSlotSchema>;
export type RaidPhase = z.infer<typeof RaidPhaseSchema>;
export type DefinitionSource = z.infer<typeof DefinitionSourceSchema>;
export type DefinitionVerification = z.infer<typeof DefinitionVerificationSchema>;
export type MechanicTimelinePoint = z.infer<typeof MechanicTimelinePointSchema>;
export type MechanicTimelinePresentationPart = z.infer<typeof MechanicTimelinePresentationPartSchema>;
export type MechanicTimelinePresentation = z.infer<typeof MechanicTimelinePresentationSchema>;
export type MechanicDefinitionSnapshot = z.infer<typeof MechanicDefinitionSnapshotSchema>;
export type MechanicOccurrence = z.infer<typeof MechanicOccurrenceSchema>;
export type PlayerSkillDefinition = z.infer<typeof PlayerSkillDefinitionSchema>;
export type TacticalTask = z.infer<typeof TacticalTaskSchema>;
export type TacticalNote = z.infer<typeof TacticalNoteSchema>;
export type TacticalDirective = z.infer<typeof TacticalDirectiveSchema>;
export type SkillAssignment = z.infer<typeof SkillAssignmentSchema>;
export type RaidPlanDocument = z.infer<typeof RaidPlanDocumentSchema>;
export type CatalogSkillDefinition = z.infer<typeof CatalogSkillDefinitionSchema>;
export type CatalogMechanicDefinition = z.infer<typeof CatalogMechanicDefinitionSchema>;
export type TimelinePreset = z.infer<typeof TimelinePresetSchema>;
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>;
export type CatalogRelease = z.infer<typeof CatalogReleaseSchema>;
export type ObservedActor = z.infer<typeof ObservedActorSchema>;
export type ObservedPhase = z.infer<typeof ObservedPhaseSchema>;
export type ObservedEvent = z.infer<typeof ObservedEventSchema>;
export type CombatLogSnapshot = z.infer<typeof CombatLogSnapshotSchema>;
export type EventCollectionRule = z.infer<typeof EventCollectionRuleSchema>;
export type EventConversionRule = z.infer<typeof EventConversionRuleSchema>;
export type EncounterConversionProfile = z.infer<typeof EncounterConversionProfileSchema>;
export type PlayerSkillExtractionRule = z.infer<typeof PlayerSkillExtractionRuleSchema>;
export type PlayerSkillExtractionProfile = z.infer<typeof PlayerSkillExtractionProfileSchema>;
export type PlanImportDraft = z.infer<typeof PlanImportDraftSchema>;
export type ComparisonRun = z.infer<typeof ComparisonRunSchema>;

export class UnsupportedDocumentVersionError extends Error {
  constructor(public readonly receivedVersion: unknown) {
    super(`不支持的计划版本：${String(receivedVersion)}`);
    this.name = "UnsupportedDocumentVersionError";
  }
}

export function parsePlanDocument(value: unknown): RaidPlanDocument {
  const version = value && typeof value === "object" ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== PLAN_SCHEMA_VERSION) throw new UnsupportedDocumentVersionError(version);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_PLAN_BYTES) throw new Error("计划内容超过 1 MB 限制");
  const document = RaidPlanDocumentSchema.parse(value);
  const ids = [
    ...document.sources.map((item) => item.id),
    ...document.definitions.mechanics.map((item) => item.id),
    ...document.roster.members.map((item) => item.id),
    ...document.timeline.phases.map((item) => item.id),
    ...document.timeline.mechanics.map((item) => item.id),
    ...document.timeline.directives.map((item) => item.id),
    ...document.timeline.skillAssignments.map((item) => item.id),
  ];
  if (new Set(ids).size !== ids.length) throw new Error("计划内存在重复的实体 ID");
  return document;
}

export function assertPlanDocument(value: unknown): asserts value is RaidPlanDocument {
  parsePlanDocument(value);
}

export function parseCatalogRelease(value: unknown): CatalogRelease {
  return CatalogReleaseSchema.parse(value);
}

export function parseCombatLogSnapshot(value: unknown): CombatLogSnapshot {
  const snapshot = CombatLogSnapshotSchema.parse(value);
  const actorKeys = snapshot.actors.map((item) => item.actorKey);
  const eventKeys = snapshot.events.map((item) => item.eventKey);
  const phaseIds = snapshot.phases.map((item) => item.id);
  if (new Set(actorKeys).size !== actorKeys.length || new Set(eventKeys).size !== eventKeys.length || new Set(phaseIds).size !== phaseIds.length) throw new Error("战斗快照包含重复的稳定标识");
  return snapshot;
}

export function parseConversionProfile(value: unknown): EncounterConversionProfile {
  const profile = EncounterConversionProfileSchema.parse(value);
  const ids = [...profile.mechanicDefinitions.map((item) => item.id), ...profile.collectionRules.map((item) => item.id), ...profile.conversionRules.map((item) => item.id)];
  if (new Set(ids).size !== ids.length) throw new Error("转换规则包含重复的实体 ID");
  const definitionIds = new Set(profile.mechanicDefinitions.map((item) => item.id));
  for (const rule of profile.conversionRules) {
    if (rule.convertTo.kind === "mechanic" && !definitionIds.has(rule.convertTo.definitionId)) throw new Error("转换规则引用了不存在的机制定义");
  }
  return profile;
}

export function parsePlayerSkillExtractionProfile(value: unknown): PlayerSkillExtractionProfile {
  const profile = PlayerSkillExtractionProfileSchema.parse(value);
  const ids = [...profile.collectionRules.map((item) => item.id), ...profile.extractionRules.map((item) => item.id), ...(profile.backgroundWindowRules ?? []).map(item => item.id)];
  if (new Set(ids).size !== ids.length) throw new Error("玩家技能提取规则包含重复的实体 ID");
  return profile;
}

export function parsePlanImportDraft(value: unknown): PlanImportDraft {
  return PlanImportDraftSchema.parse(value);
}

export function parseComparisonRun(value: unknown): ComparisonRun {
  return ComparisonRunSchema.parse(value);
}
