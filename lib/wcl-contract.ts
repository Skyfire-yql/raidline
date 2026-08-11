import { parseCombatLogSnapshot, parseConversionProfile, type CombatLogSnapshot, type EncounterConversionProfile } from "./types";

export interface WclFightProbe {
  reportCode: string;
  fightId: number;
  difficulty: "mythic" | "heroic" | "normal" | "raid-finder" | "unknown";
}

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

export function validateConversionProfile(value: unknown): EncounterConversionProfile {
  return parseConversionProfile(value);
}
