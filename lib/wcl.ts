import { env } from "cloudflare:workers";
import { and, eq, gt } from "drizzle-orm";
import { getDb, ensureDbSchema } from "@/db";
import { wclCache } from "@/db/schema";
import { COOLDOWN_BY_SPELL_ID, WOW_CLASS_COLORS } from "./cooldowns";
import { makeId } from "./core";
import { collectCastPages, groupCastEvents, parseWclSourceInput, WclInputError } from "./wcl-core";
import type {
  RaidAssignment,
  RaidPhase,
  RaidRole,
  RosterMember,
  WclFightSummary,
  WclImportAnalysis,
  WclPreview,
} from "./types";

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CAST_EVENTS = 50_000;

let tokenCache: { token: string; expiresAt: number } | undefined;

export class WclError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function parseWclSource(input: string) {
  try {
    return parseWclSourceInput(input);
  } catch (error) {
    if (error instanceof WclInputError) throw new WclError("INVALID_WCL_URL", error.message, 400);
    throw error;
  }
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const { WCL_CLIENT_ID: clientId, WCL_CLIENT_SECRET: clientSecret } = runtimeEnv();
  if (!clientId || !clientSecret) {
    throw new WclError("WCL_NOT_CONFIGURED", "站点尚未配置 WCL 凭据，手动排轴仍可正常使用", 503);
  }
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!response.ok) throw new WclError("WCL_AUTH_FAILED", "WCL 授权失败，请检查客户端凭据", 502);
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new WclError("WCL_AUTH_FAILED", "WCL 未返回访问令牌", 502);
  tokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(WCL_GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 429) throw new WclError("WCL_RATE_LIMIT", "WCL 查询额度暂时用尽，请稍后再试", 429);
  const payload = (await response.json().catch(() => null)) as { data?: T; errors?: Array<{ message?: string }> } | null;
  if (!response.ok || !payload?.data || payload.errors?.length) {
    const detail = payload?.errors?.[0]?.message ?? "WCL 暂时无法返回这份战报";
    if (/private|permission|access/i.test(detail)) {
      throw new WclError("WCL_PRIVATE_REPORT", "首版只支持公开 WCL 战报", 403);
    }
    throw new WclError("WCL_QUERY_FAILED", detail, 502);
  }
  return payload.data;
}

function difficultyLabel(value: number | null | undefined) {
  return ({ 1: "随机", 3: "普通", 4: "英雄", 5: "史诗" } as Record<number, string>)[value ?? -1] ?? "未知难度";
}

function toFightSummary(fight: Record<string, unknown>): WclFightSummary {
  const startTime = Number(fight.startTime ?? 0);
  const endTime = Number(fight.endTime ?? startTime);
  const difficulty = fight.difficulty == null ? null : Number(fight.difficulty);
  return {
    id: Number(fight.id),
    name: String(fight.name ?? "未知首领"),
    encounterId: Number(fight.encounterID ?? 0),
    difficulty,
    difficultyLabel: difficultyLabel(difficulty),
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    kill: Boolean(fight.kill),
    size: fight.size == null ? null : Number(fight.size),
  };
}

const PREVIEW_QUERY = `query RaidlinePreview($code: String!) {
  reportData {
    report(code: $code) {
      code title visibility revision archiveStatus
      fights { id name encounterID difficulty startTime endTime kill size }
    }
  }
  rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }
}`;

export async function previewWclReport(input: string): Promise<WclPreview> {
  const { reportCode } = parseWclSource(input);
  const data = await graphql<{
    reportData: { report: Record<string, unknown> | null };
    rateLimitData?: WclPreview["rateLimit"];
  }>(PREVIEW_QUERY, { code: reportCode });
  const report = data.reportData.report;
  if (!report) throw new WclError("WCL_REPORT_NOT_FOUND", "找不到这份 WCL 战报", 404);
  if (String(report.archiveStatus ?? "").toLowerCase().includes("archived")) {
    throw new WclError("WCL_REPORT_ARCHIVED", "这份战报已归档，当前 WCL 凭据无法读取事件", 410);
  }
  const fights = ((report.fights as Record<string, unknown>[]) ?? [])
    .map(toFightSummary)
    .filter((fight) => fight.encounterId > 0)
    .sort((a, b) => a.startTime - b.startTime);
  return {
    reportCode,
    title: String(report.title ?? reportCode),
    visibility: String(report.visibility ?? "public"),
    revision: Number(report.revision ?? 0),
    fights,
    rateLimit: data.rateLimitData,
  };
}

const ANALYSIS_META_QUERY = `query RaidlineFight($code: String!) {
  reportData {
    report(code: $code) {
      code title visibility revision archiveStatus
      masterData(translate: true) {
        actors { id name type subType }
        abilities { gameID name }
      }
      fights {
        id name encounterID difficulty startTime endTime kill size
        friendlyPlayers friendlySpecs
        phaseTransitions { id startTime }
      }
    }
  }
}`;

const CASTS_QUERY = `query RaidlineCasts($code: String!, $fightIDs: [Int], $start: Float, $hostility: HostilityType) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: Casts, startTime: $start, hostilityType: $hostility, limit: 10000, useAbilityIDs: true, useActorIDs: true) {
        data nextPageTimestamp
      }
    }
  }
}`;

async function readCastEvents(reportCode: string, fightId: number, hostility: "Enemies" | "Friendlies") {
  try {
    return await collectCastPages(async (start) => {
    const data = await graphql<{
      reportData: { report: { events: { data: unknown; nextPageTimestamp?: number | null } } | null };
    }>(CASTS_QUERY, { code: reportCode, fightIDs: [fightId], start, hostility });
    const page = data.reportData.report?.events;
    if (!page) throw new WclError("WCL_REPORT_NOT_FOUND", "找不到选定的战斗场次", 404);
      return page;
    }, MAX_CAST_EVENTS);
  } catch (error) {
    if (error instanceof WclError) throw error;
    if (error instanceof Error && error.message.includes("事件超过")) throw new WclError("WCL_EVENT_LIMIT", "该场战斗施法事件超过 50,000 条，请选择更短的场次", 422);
    throw error;
  }
}

function roleFromSpec(spec: string): RaidRole {
  if (/Blood|Vengeance|Guardian|Brewmaster|Protection/i.test(spec)) return "tank";
  if (/Restoration|Holy|Discipline|Mistweaver|Preservation/i.test(spec)) return "healer";
  return "damage";
}

function normalizeAnalysis(
  reportCode: string,
  report: Record<string, unknown>,
  rawFight: Record<string, unknown>,
  enemyEvents: Array<Record<string, unknown>>,
  friendlyEvents: Array<Record<string, unknown>>,
): WclImportAnalysis {
  const fight = toFightSummary(rawFight);
  const masterData = (report.masterData as Record<string, unknown>) ?? {};
  const actors = (masterData.actors as Array<Record<string, unknown>>) ?? [];
  const abilities = (masterData.abilities as Array<Record<string, unknown>>) ?? [];
  const abilityNames = new Map<number, string>();
  for (const ability of abilities) abilityNames.set(Number(ability.gameID), String(ability.name ?? `技能 ${ability.gameID}`));
  const actorById = new Map(actors.map((actor) => [Number(actor.id), actor]));
  const playerIds = (rawFight.friendlyPlayers as number[]) ?? [];
  const specs = (rawFight.friendlySpecs as string[]) ?? [];

  const roster: RosterMember[] = playerIds.map((actorId, index) => {
    const actor = actorById.get(Number(actorId)) ?? {};
    const classSlug = String(actor.subType ?? "Warrior");
    const specSlug = String(specs[index] ?? "未知专精");
    return {
      id: `wcl-member-${actorId}`,
      name: String(actor.name ?? `玩家 ${actorId}`),
      classSlug,
      specSlug,
      role: roleFromSpec(specSlug),
      color: WOW_CLASS_COLORS[classSlug] ?? "#b6ad9a",
    };
  });
  const memberByActor = new Map(playerIds.map((actorId, index) => [Number(actorId), roster[index]]));

  const phaseTransitions = (rawFight.phaseTransitions as Array<Record<string, unknown>>) ?? [];
  const phases: RaidPhase[] = phaseTransitions.length
    ? phaseTransitions.map((phase, index) => ({
        id: `wcl-phase-${index + 1}`,
        name: `P${index + 1}`,
        atMs: Math.max(0, Number(phase.startTime ?? fight.startTime) - fight.startTime),
      }))
    : [{ id: "wcl-phase-1", name: "P1", atMs: 0 }];
  if (!phases.some((phase) => phase.atMs === 0)) phases.unshift({ id: "wcl-phase-0", name: "P1", atMs: 0 });

  const abilityGroups = groupCastEvents(enemyEvents, fight.startTime, fight.durationMs, abilityNames);

  const detectedCooldowns = new Map<number, ReturnType<typeof COOLDOWN_BY_SPELL_ID.get>>();
  const suggestedAssignments: RaidAssignment[] = [];
  for (const event of friendlyEvents) {
    const spellId = Number(event.abilityGameID ?? (event.ability as Record<string, unknown> | undefined)?.gameID ?? 0);
    const cooldown = COOLDOWN_BY_SPELL_ID.get(spellId);
    const member = memberByActor.get(Number(event.sourceID ?? 0));
    const timestamp = Number(event.timestamp ?? 0) - fight.startTime;
    if (!cooldown || !member || timestamp < 0 || timestamp > fight.durationMs + 5000) continue;
    detectedCooldowns.set(spellId, cooldown);
    suggestedAssignments.push({
      id: makeId("wcl-assignment"),
      memberId: member.id,
      cooldownId: cooldown.id,
      atMs: Math.round(timestamp),
      note: "来自 WCL 的实际施放",
      source: "wcl",
    });
  }

  return {
    reportCode,
    reportRevision: Number(report.revision ?? 0),
    fight,
    roster,
    phases,
    abilityGroups,
    suggestedAssignments: suggestedAssignments.sort((a, b) => a.atMs - b.atMs),
    detectedCooldowns: Array.from(detectedCooldowns.values()).filter(Boolean) as WclImportAnalysis["detectedCooldowns"],
  };
}

export async function analyzeWclFight(reportCode: string, fightId: number): Promise<WclImportAnalysis> {
  const meta = await graphql<{ reportData: { report: Record<string, unknown> | null } }>(ANALYSIS_META_QUERY, { code: reportCode });
  const report = meta.reportData.report;
  if (!report) throw new WclError("WCL_REPORT_NOT_FOUND", "找不到这份 WCL 战报", 404);
  const rawFight = ((report.fights as Array<Record<string, unknown>>) ?? []).find((fight) => Number(fight.id) === fightId);
  if (!rawFight) throw new WclError("WCL_FIGHT_NOT_FOUND", "找不到选定的战斗场次", 404);
  const revision = Number(report.revision ?? 0);
  const cacheKey = `analysis:${reportCode}:${fightId}:${revision}`;
  await ensureDbSchema();
  const db = getDb();
  const [cached] = await db.select().from(wclCache).where(and(eq(wclCache.cacheKey, cacheKey), gt(wclCache.expiresAt, Date.now()))).limit(1);
  if (cached) return JSON.parse(cached.payloadJson) as WclImportAnalysis;

  const [enemyEvents, friendlyEvents] = await Promise.all([
    readCastEvents(reportCode, fightId, "Enemies"),
    readCastEvents(reportCode, fightId, "Friendlies"),
  ]);
  const analysis = normalizeAnalysis(reportCode, report, rawFight, enemyEvents, friendlyEvents);
  const now = Date.now();
  await db.insert(wclCache).values({ cacheKey, payloadJson: JSON.stringify(analysis), expiresAt: now + CACHE_TTL_MS, createdAt: now })
    .onConflictDoUpdate({ target: wclCache.cacheKey, set: { payloadJson: JSON.stringify(analysis), expiresAt: now + CACHE_TTL_MS, createdAt: now } });
  return analysis;
}
