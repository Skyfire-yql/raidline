import { z } from "zod";

import { parseCombatLogSnapshot, parseConversionProfile, type CombatLogSnapshot, type EncounterConversionProfile } from "./types";
import { selectPublishedEncounterProfile, selectPublishedPlayerSkillProfile } from "./wcl-conversion";
import type { WclDifficulty } from "./wcl-report";

export interface WclFightProbe {
  reportCode: string;
  fightId: number;
  difficulty: WclDifficulty;
}

export const WclFightConversionMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportCode: z.string().min(1).max(32),
  fightId: z.number().int().positive(),
  encounterId: z.number().int().positive(),
  encounterName: z.string().min(1).max(120),
  difficulty: z.enum(["mythic", "heroic", "normal", "raid-finder", "unknown"]),
  gameVersion: z.string().min(1).max(80),
  reportRevision: z.number().int().nonnegative(),
  reportStartEpochMs: z.number().int().nonnegative(),
  fightStartReportMs: z.number().int().nonnegative(),
  fightEndReportMs: z.number().int().nonnegative(),
  zoneId: z.number().int().positive().optional(),
});

export type WclFightConversionMetadata = z.infer<typeof WclFightConversionMetadataSchema>;

export class UnsupportedDifficultyError extends Error {
  readonly code = "UNSUPPORTED_DIFFICULTY";
  constructor(readonly difficulty: WclFightProbe["difficulty"]) {
    super("当前只支持史诗难度的 WCL 战斗");
    this.name = "UnsupportedDifficultyError";
  }
}

export function assertMythicFight(probe: WclFightProbe) {
  if (probe.difficulty !== "mythic") throw new UnsupportedDifficultyError(probe.difficulty);
}

export function acceptNormalizedWclSnapshot(probe: WclFightProbe, value: unknown): CombatLogSnapshot {
  assertMythicFight(probe);
  const snapshot = parseCombatLogSnapshot(value);
  if (snapshot.source.reportCode !== probe.reportCode || snapshot.source.fightId !== probe.fightId) throw new Error("WCL 快照与所选战斗不一致");
  return snapshot;
}

export function preparePublishedWclConversion(
  metadataValue: unknown,
  encounterProfileRows: unknown[],
  encounterProfileVersion: number,
  playerProfileRows: unknown[],
  playerProfileVersion: number,
) {
  const metadata = WclFightConversionMetadataSchema.parse(metadataValue);
  if (metadata.fightEndReportMs < metadata.fightStartReportMs) throw new Error("WCL fight 元数据时间范围无效");
  assertMythicFight(metadata);
  const encounterProfile = selectPublishedEncounterProfile(encounterProfileRows, {
    encounterId: metadata.encounterId,
    gameVersion: metadata.gameVersion,
    profileVersion: encounterProfileVersion,
  });
  const playerSkillProfile = selectPublishedPlayerSkillProfile(playerProfileRows, {
    gameVersion: metadata.gameVersion,
    profileVersion: playerProfileVersion,
  });
  return { metadata, encounterProfile, playerSkillProfile };
}

export function acceptSnapshotForConversion(metadataValue: unknown, value: unknown) {
  const metadata = WclFightConversionMetadataSchema.parse(metadataValue);
  const snapshot = acceptNormalizedWclSnapshot(metadata, value);
  if (snapshot.encounter.encounterId !== metadata.encounterId || snapshot.source.gameVersionKey !== metadata.gameVersion) {
    throw new Error("WCL 快照与已确认的 encounter 或游戏版本不一致");
  }
  return snapshot;
}

export function validateConversionProfile(value: unknown): EncounterConversionProfile {
  return parseConversionProfile(value);
}
