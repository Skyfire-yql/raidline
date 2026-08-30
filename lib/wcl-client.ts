import { z } from "zod";
import {
  normalizeWclReportProbe,
  WclClientError,
  type WclReportLink,
  type WclReportProbeResult,
} from "./wcl-report";

export { WclClientError } from "./wcl-report";

const REPORT_PROBE_QUERY = `
  query RaidlineReportProbe($code: String!) {
    reportData {
      report(code: $code, allowUnlisted: false) {
        code
        title
        visibility
        revision
        startTime
        endTime
        zone { id name }
        fights(translate: true) {
          id
          encounterID
          name
          difficulty
          kill
          startTime
          endTime
          bossPercentage
          fightPercentage
          phaseTransitions { id startTime }
        }
      }
    }
  }
`;

const FIGHT_METADATA_QUERY = `
  query RaidlineFightMetadata($code: String!, $fightIDs: [Int]!) {
    reportData {
      report(code: $code, allowUnlisted: false) {
        code
        visibility
        revision
        startTime
        zone { id }
        masterData(translate: false) {
          gameVersion
          logVersion
          lang
          actors { id gameID type subType petOwner }
        }
        fights(fightIDs: $fightIDs, translate: true) {
          id
          encounterID
          name
          difficulty
          kill
          startTime
          endTime
          phaseTransitions { id startTime }
          friendlyPlayers
          enemyPlayers
          friendlyNPCs { id gameID petOwner }
          enemyNPCs { id gameID petOwner }
          friendlyPets { id gameID petOwner }
          enemyPets { id gameID petOwner }
        }
      }
    }
  }
`;

const FIGHT_EVENTS_QUERY = `
  query RaidlineFightEvents(
    $code: String!
    $fightIDs: [Int]!
    $dataType: EventDataType!
    $hostilityType: HostilityType
    $startTime: Float!
    $endTime: Float!
  ) {
    reportData {
      report(code: $code, allowUnlisted: false) {
        events(
          fightIDs: $fightIDs
          dataType: $dataType
          hostilityType: $hostilityType
          startTime: $startTime
          endTime: $endTime
          limit: 10000
          translate: false
          useAbilityIDs: true
          useActorIDs: true
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().default(3600),
});

const GraphQlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
}).passthrough();

const ReportRootSchema = z.strictObject({
  reportData: z.strictObject({ report: z.unknown().nullable() }).nullable(),
});

const ActorReferenceSchema = z.strictObject({
  id: z.number().int(),
  gameID: z.number().finite().nullable(),
  type: z.string().nullable(),
  subType: z.string().nullable(),
  petOwner: z.number().int().positive().nullable(),
});

const FightNpcReferenceSchema = z.strictObject({
  id: z.number().int().positive(),
  gameID: z.number().finite().nullable(),
  petOwner: z.number().int().positive().nullable(),
});

const FightMetadataReportSchema = z.strictObject({
  code: z.string().min(1).max(32),
  visibility: z.string().min(1).max(40),
  revision: z.number().int().nonnegative(),
  startTime: z.number().finite(),
  zone: z.strictObject({ id: z.number().int().positive() }).nullable(),
  masterData: z.strictObject({
    gameVersion: z.number().int().nonnegative().nullable(),
    logVersion: z.number().int().nonnegative(),
    lang: z.string().min(1).max(20).nullable(),
    actors: z.array(ActorReferenceSchema).max(20_000).nullable(),
  }).nullable(),
  fights: z.array(z.strictObject({
    id: z.number().int().positive(),
    encounterID: z.number().int().positive(),
    name: z.string().min(1).max(300),
    difficulty: z.number().int().nullable(),
    kill: z.boolean().nullable(),
    startTime: z.number().finite(),
    endTime: z.number().finite(),
    phaseTransitions: z.array(z.strictObject({
      id: z.number().int().positive(),
      startTime: z.number().finite(),
    })).max(500).nullable(),
    friendlyPlayers: z.array(z.number().int().positive()).max(500).nullable(),
    enemyPlayers: z.array(z.number().int().positive()).max(500).nullable(),
    friendlyNPCs: z.array(FightNpcReferenceSchema).max(2_000).nullable(),
    enemyNPCs: z.array(FightNpcReferenceSchema).max(2_000).nullable(),
    friendlyPets: z.array(FightNpcReferenceSchema).max(2_000).nullable(),
    enemyPets: z.array(FightNpcReferenceSchema).max(2_000).nullable(),
  })).max(1).nullable(),
});

const EventPaginatorSchema = z.object({
  data: z.array(z.unknown()).max(20_000).nullable(),
  nextPageTimestamp: z.number().finite().nullable(),
}).passthrough();

const MAX_EVENT_PAGES_PER_QUERY = 100;
const MAX_FETCHED_EVENTS = 1_000_000;

export type WclEventDataType = "Buffs" | "Casts" | "DamageDone" | "Deaths" | "Debuffs" | "Dispels" | "Healing" | "Interrupts";
export type WclEventHostility = "Enemies" | "Friendlies";

export interface WclEventRequest {
  dataType: WclEventDataType;
  hostilityType?: WclEventHostility;
}

export interface WclActorReference {
  id: number;
  gameID: number | null;
  type: string | null;
  subType: string | null;
  petOwner: number | null;
}

export interface WclFightNpcReference {
  id: number;
  gameID: number | null;
  petOwner: number | null;
}

export interface WclFightEventBundle {
  report: {
    code: string;
    revision: number;
    startTime: number;
    zoneId: number | null;
  };
  masterData: {
    gameVersion: number | null;
    logVersion: number;
    lang: string | null;
    actors: WclActorReference[];
  };
  fight: {
    id: number;
    encounterID: number;
    name: string;
    difficulty: number | null;
    kill: boolean;
    startTime: number;
    endTime: number;
    phaseTransitions: Array<{ id: number; startTime: number }>;
    friendlyPlayers: number[];
    enemyPlayers: number[];
    friendlyNPCs: WclFightNpcReference[];
    enemyNPCs: WclFightNpcReference[];
    friendlyPets: WclFightNpcReference[];
    enemyPets: WclFightNpcReference[];
  };
  series: Array<{
    request: WclEventRequest;
    events: unknown[];
    pageCount: number;
  }>;
  fetchedEventCount: number;
  pageCount: number;
}

export interface WclClientConfiguration {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  apiUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (durationMs: number) => Promise<void>;
}

export interface WclClient {
  probeReport(link: WclReportLink): Promise<WclReportProbeResult>;
  readFightEvents(reportCode: string, fightId: number, requests: WclEventRequest[]): Promise<WclFightEventBundle>;
}

function encodedBasicCredentials(clientId: string, clientSecret: string) {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function checkedEndpoint(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 配置无效`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${label} 必须使用 HTTPS`);
  }
  return url.toString();
}

function retryDelay(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2000) : 250;
}

export function createWclClient(configuration: WclClientConfiguration): WclClient {
  const clientId = configuration.clientId.trim();
  const clientSecret = configuration.clientSecret.trim();
  if (!clientId || !clientSecret) throw new Error("WCL 客户端凭据未配置");
  const tokenUrl = checkedEndpoint(configuration.tokenUrl, "WCL token URL");
  const apiUrl = checkedEndpoint(configuration.apiUrl, "WCL API URL");
  const fetchImpl = configuration.fetchImpl ?? fetch;
  const sleep = configuration.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const timeoutMs = configuration.timeoutMs ?? 15_000;
  let token: { value: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<string> | null = null;

  async function request(url: string, init: RequestInit) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await sleep(retryDelay(response));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt === 0) {
          await sleep(250);
          continue;
        }
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new WclClientError(
          "WCL_NETWORK_FAILED",
          timedOut ? "连接 WCL 超时，请稍后重试" : "无法连接 WCL，请稍后重试",
          502,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new WclClientError("WCL_NETWORK_FAILED", "无法连接 WCL，请稍后重试", 502, true);
  }

  async function readJson(response: Response) {
    try {
      return await response.json();
    } catch {
      throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法解析的响应");
    }
  }

  async function requestToken() {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const headers = new Headers({
        authorization: `Basic ${encodedBasicCredentials(clientId, clientSecret)}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      });
      const response = await request(tokenUrl, { method: "POST", headers, body: "grant_type=client_credentials" });
      if (!response.ok) {
        if (response.status === 429) throw new WclClientError("WCL_RATE_LIMITED", "WCL 请求额度暂时不足，请稍后重试", 429, true);
        throw new WclClientError("WCL_AUTH_FAILED", "WCL 服务端认证失败，请检查本地配置", 503);
      }
      const parsed = TokenResponseSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new WclClientError("WCL_AUTH_FAILED", "WCL 服务端认证返回异常", 503);
      token = {
        value: parsed.data.access_token,
        expiresAt: Date.now() + parsed.data.expires_in * 1000,
      };
      return token.value;
    })();
    try {
      return await tokenRequest;
    } finally {
      tokenRequest = null;
    }
  }

  async function graphQl(query: string, variables: Record<string, unknown>) {
    const accessToken = await requestToken();
    const response = await request(apiUrl, {
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      }),
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        token = null;
        throw new WclClientError("WCL_AUTH_FAILED", "WCL 服务端认证已失效，请稍后重试", 503, true);
      }
      if (response.status === 429) throw new WclClientError("WCL_RATE_LIMITED", "WCL 请求额度暂时不足，请稍后重试", 429, true);
      throw new WclClientError("WCL_NETWORK_FAILED", "WCL 暂时无法读取这份报告", 502, response.status >= 500);
    }

    const envelope = GraphQlEnvelopeSchema.safeParse(await readJson(response));
    if (!envelope.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的响应");
    if (envelope.data.errors?.length) throw new WclClientError("WCL_GRAPHQL_FAILED", "WCL 无法按当前查询读取这份报告");
    return envelope.data.data;
  }

  function reportFromRoot(value: unknown) {
    const root = ReportRootSchema.safeParse(value);
    if (!root.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的报告结构");
    const report = root.data.reportData?.report;
    if (!report) throw new WclClientError("WCL_REPORT_NOT_FOUND", "找不到这份公开 WCL 报告", 404);
    return report;
  }

  async function probeReport(link: WclReportLink) {
    const report = reportFromRoot(await graphQl(REPORT_PROBE_QUERY, { code: link.reportCode }));
    return normalizeWclReportProbe(report, link);
  }

  async function readFightEvents(reportCode: string, fightId: number, requests: WclEventRequest[]) {
    if (!Number.isSafeInteger(fightId) || fightId < 1 || requests.length < 1) {
      throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 事件请求无效", 422);
    }
    const metadataValue = reportFromRoot(await graphQl(FIGHT_METADATA_QUERY, { code: reportCode, fightIDs: [fightId] }));
    const metadata = FightMetadataReportSchema.safeParse(metadataValue);
    if (!metadata.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的战斗元数据");
    if (metadata.data.code !== reportCode || metadata.data.visibility !== "public") {
      throw new WclClientError("WCL_REPORT_NOT_FOUND", "找不到这份公开 WCL 报告", 404);
    }
    const fight = metadata.data.fights?.[0];
    if (!fight || fight.id !== fightId) throw new WclClientError("WCL_FIGHT_NOT_FOUND", "WCL 链接指定的战斗不存在", 404);
    if (!metadata.data.masterData) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 报告缺少 master data");
    if (fight.endTime < fight.startTime) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无效的战斗时间");

    const series: WclFightEventBundle["series"] = [];
    let fetchedEventCount = 0;
    let totalPageCount = 0;
    for (const eventRequest of requests) {
      let cursor = fight.startTime;
      let pageCount = 0;
      const events: unknown[] = [];
      while (true) {
        if (pageCount >= MAX_EVENT_PAGES_PER_QUERY) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 事件分页超过安全上限");
        const pageReport = reportFromRoot(await graphQl(FIGHT_EVENTS_QUERY, {
          code: reportCode,
          fightIDs: [fightId],
          dataType: eventRequest.dataType,
          hostilityType: eventRequest.hostilityType ?? null,
          startTime: cursor,
          endTime: fight.endTime,
        }));
        const pageRoot = z.strictObject({ events: z.unknown().nullable() }).safeParse(pageReport);
        if (!pageRoot.success || !pageRoot.data.events) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的事件页");
        const page = EventPaginatorSchema.safeParse(pageRoot.data.events);
        if (!page.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的事件页");
        const pageEvents = page.data.data ?? [];
        events.push(...pageEvents);
        fetchedEventCount += pageEvents.length;
        pageCount += 1;
        totalPageCount += 1;
        if (fetchedEventCount > MAX_FETCHED_EVENTS) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 事件数量超过安全上限");
        const next = page.data.nextPageTimestamp;
        if (next == null) break;
        if (next <= cursor || next > fight.endTime) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无效的事件分页游标");
        cursor = next;
      }
      series.push({ request: eventRequest, events, pageCount });
    }

    return {
      report: {
        code: metadata.data.code,
        revision: metadata.data.revision,
        startTime: Math.round(metadata.data.startTime),
        zoneId: metadata.data.zone?.id ?? null,
      },
      masterData: {
        gameVersion: metadata.data.masterData.gameVersion,
        logVersion: metadata.data.masterData.logVersion,
        lang: metadata.data.masterData.lang,
        actors: metadata.data.masterData.actors ?? [],
      },
      fight: {
        id: fight.id,
        encounterID: fight.encounterID,
        name: fight.name,
        difficulty: fight.difficulty,
        kill: fight.kill === true,
        startTime: Math.round(fight.startTime),
        endTime: Math.round(fight.endTime),
        phaseTransitions: fight.phaseTransitions ?? [],
        friendlyPlayers: fight.friendlyPlayers ?? [],
        enemyPlayers: fight.enemyPlayers ?? [],
        friendlyNPCs: fight.friendlyNPCs ?? [],
        enemyNPCs: fight.enemyNPCs ?? [],
        friendlyPets: fight.friendlyPets ?? [],
        enemyPets: fight.enemyPets ?? [],
      },
      series,
      fetchedEventCount,
      pageCount: totalPageCount,
    } satisfies WclFightEventBundle;
  }

  return { probeReport, readFightEvents };
}
