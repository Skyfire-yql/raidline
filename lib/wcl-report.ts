import { z } from "zod";

const REPORT_CODE = /^[0-9A-Za-z]{16}$/;
const OFFICIAL_RETAIL_HOSTS = new Set([
  "warcraftlogs.com",
  "www.warcraftlogs.com",
  "br.warcraftlogs.com",
  "cn.warcraftlogs.com",
  "de.warcraftlogs.com",
  "es.warcraftlogs.com",
  "fr.warcraftlogs.com",
  "it.warcraftlogs.com",
  "ja.warcraftlogs.com",
  "ko.warcraftlogs.com",
  "ru.warcraftlogs.com",
  "tw.warcraftlogs.com",
]);

export type WclDifficulty = "mythic" | "heroic" | "normal" | "raid-finder" | "unknown";
export type WclFightSelector = number | "last" | null;

export interface WclReportLink {
  reportCode: string;
  fight: WclFightSelector;
}

export interface WclPhaseProbe {
  semanticPhaseId: number;
  occurrenceIndex: number;
  atMs: number;
}

export interface WclFightSummary {
  id: number;
  encounterId: number;
  encounterName: string;
  difficulty: WclDifficulty;
  supported: boolean;
  kill: boolean;
  startReportMs: number;
  endReportMs: number;
  durationMs: number;
  bossPercentage: number | null;
  fightPercentage: number | null;
  hasOfficialPhases: boolean;
  phases: WclPhaseProbe[];
}

export interface WclReportProbeResult {
  report: {
    code: string;
    title: string;
    revision: number;
    startEpochMs: number;
    endEpochMs: number;
    zone: { id: number; name: string } | null;
  };
  requestedFight: WclFightSelector;
  selectedFightId: number | null;
  fights: WclFightSummary[];
}

export type WclClientErrorCode =
  | "WCL_AUTH_FAILED"
  | "WCL_FIGHT_NOT_FOUND"
  | "WCL_GRAPHQL_FAILED"
  | "WCL_NETWORK_FAILED"
  | "WCL_RATE_LIMITED"
  | "WCL_REPORT_NOT_FOUND"
  | "WCL_REPORT_CHANGED"
  | "WCL_RESPONSE_INVALID";

export class InvalidWclReportUrlError extends Error {
  readonly code = "INVALID_WCL_LINK";

  constructor(message = "请粘贴有效的 Warcraft Logs 公开报告链接") {
    super(message);
    this.name = "InvalidWclReportUrlError";
  }
}

export class WclClientError extends Error {
  constructor(
    readonly code: WclClientErrorCode,
    message: string,
    readonly status = 502,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WclClientError";
  }
}

const PhaseTransitionDtoSchema = z.strictObject({
  id: z.number().int().positive(),
  startTime: z.number().finite(),
});

const ReportFightDtoSchema = z.strictObject({
  id: z.number().int().positive(),
  encounterID: z.number().int().nonnegative(),
  name: z.string().min(1).max(300),
  difficulty: z.number().int().nullable(),
  kill: z.boolean().nullable(),
  startTime: z.number().finite(),
  endTime: z.number().finite(),
  bossPercentage: z.number().finite().nullable(),
  fightPercentage: z.number().finite().nullable(),
  phaseTransitions: z.array(PhaseTransitionDtoSchema).max(500).nullable(),
});

const ReportDtoSchema = z.strictObject({
  code: z.string().regex(REPORT_CODE),
  title: z.string().min(1).max(500),
  visibility: z.string().min(1).max(40),
  revision: z.number().int().nonnegative(),
  startTime: z.number().finite(),
  endTime: z.number().finite(),
  zone: z.strictObject({ id: z.number().int().positive(), name: z.string().min(1).max(300) }).nullable(),
  fights: z.array(ReportFightDtoSchema).max(10_000).nullable(),
});

export function parseWclReportUrl(value: string): WclReportLink {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidWclReportUrlError();
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !OFFICIAL_RETAIL_HOSTS.has(url.hostname.toLowerCase())
  ) throw new InvalidWclReportUrlError();

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "reports" || !REPORT_CODE.test(segments[1])) {
    throw new InvalidWclReportUrlError();
  }
  const fightValues = url.searchParams.getAll("fight");
  if (fightValues.length > 1) throw new InvalidWclReportUrlError("WCL 链接包含多个 fight 参数");
  const fightValue = fightValues[0];
  let fight: WclFightSelector = null;
  if (fightValue === "last") fight = "last";
  else if (fightValue !== undefined) {
    if (!/^[1-9]\d*$/.test(fightValue)) throw new InvalidWclReportUrlError("WCL fight 参数无效");
    fight = Number(fightValue);
    if (!Number.isSafeInteger(fight)) throw new InvalidWclReportUrlError("WCL fight 参数无效");
  }
  return { reportCode: segments[1], fight };
}

export function wclDifficulty(value: number | null): WclDifficulty {
  if (value === 5) return "mythic";
  if (value === 4) return "heroic";
  if (value === 3) return "normal";
  if (value === 1) return "raid-finder";
  return "unknown";
}

function normalizedPhases(
  fightStartMs: number,
  fightEndMs: number,
  transitions: z.infer<typeof PhaseTransitionDtoSchema>[] | null,
): WclPhaseProbe[] {
  const durationMs = Math.round(fightEndMs - fightStartMs);
  const sorted = [...(transitions ?? [])].sort((left, right) => left.startTime - right.startTime);
  const values = sorted.map((transition) => ({
    semanticPhaseId: transition.id,
    atMs: Math.round(transition.startTime - fightStartMs),
  }));
  if (values.some((phase) => phase.atMs < 0 || phase.atMs > durationMs)) {
    throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了战斗范围之外的阶段时间");
  }
  if (!values.some((phase) => phase.atMs === 0)) values.unshift({ semanticPhaseId: 1, atMs: 0 });

  const occurrences = new Map<number, number>();
  return values.map((phase) => {
    const occurrenceIndex = (occurrences.get(phase.semanticPhaseId) ?? 0) + 1;
    occurrences.set(phase.semanticPhaseId, occurrenceIndex);
    return { ...phase, occurrenceIndex };
  });
}

export function normalizeWclReportProbe(value: unknown, link: WclReportLink): WclReportProbeResult {
  const parsed = ReportDtoSchema.safeParse(value);
  if (!parsed.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的报告结构");
  const report = parsed.data;
  if (report.code !== link.reportCode) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了错误的报告");
  if (report.visibility !== "public") throw new WclClientError("WCL_REPORT_NOT_FOUND", "这份 WCL 报告不是公开报告", 404);

  const fights = (report.fights ?? []).filter((fight) => fight.encounterID > 0).map((fight) => {
    const startReportMs = Math.round(fight.startTime);
    const endReportMs = Math.round(fight.endTime);
    if (endReportMs < startReportMs) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无效的战斗时间");
    const difficulty = wclDifficulty(fight.difficulty);
    return {
      id: fight.id,
      encounterId: fight.encounterID,
      encounterName: fight.name,
      difficulty,
      supported: difficulty === "mythic",
      kill: fight.kill === true,
      startReportMs,
      endReportMs,
      durationMs: endReportMs - startReportMs,
      bossPercentage: fight.bossPercentage,
      fightPercentage: fight.fightPercentage,
      hasOfficialPhases: Boolean(fight.phaseTransitions?.length),
      phases: normalizedPhases(startReportMs, endReportMs, fight.phaseTransitions),
    } satisfies WclFightSummary;
  });

  let selectedFightId: number | null = null;
  if (link.fight === "last") selectedFightId = fights.at(-1)?.id ?? null;
  else if (typeof link.fight === "number") selectedFightId = link.fight;
  if (selectedFightId !== null && !fights.some((fight) => fight.id === selectedFightId)) {
    throw new WclClientError("WCL_FIGHT_NOT_FOUND", "WCL 链接指定的战斗不存在", 404);
  }

  return {
    report: {
      code: report.code,
      title: report.title,
      revision: report.revision,
      startEpochMs: Math.round(report.startTime),
      endEpochMs: Math.round(report.endTime),
      zone: report.zone,
    },
    requestedFight: link.fight,
    selectedFightId,
    fights,
  };
}
