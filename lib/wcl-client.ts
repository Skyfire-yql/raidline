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

  async function probeReport(link: WclReportLink) {
    const accessToken = await requestToken();
    const headers = new Headers({
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    const response = await request(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: REPORT_PROBE_QUERY, variables: { code: link.reportCode } }),
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
    if (envelope.data.errors?.length) throw new WclClientError("WCL_GRAPHQL_FAILED", "WCL 暂时无法读取这份报告");
    const root = ReportRootSchema.safeParse(envelope.data.data);
    if (!root.success) throw new WclClientError("WCL_RESPONSE_INVALID", "WCL 返回了无法识别的报告结构");
    const report = root.data.reportData?.report;
    if (!report) throw new WclClientError("WCL_REPORT_NOT_FOUND", "找不到这份公开 WCL 报告", 404);
    return normalizeWclReportProbe(report, link);
  }

  return { probeReport };
}
