import { z } from "zod";
import { jsonData, jsonError } from "@/lib/server";
import { InvalidWclReportUrlError, parseWclReportUrl, WclClientError } from "@/lib/wcl-report";
import { getWclClient, WclConfigurationError } from "@/lib/wcl-server";

const RequestSchema = z.strictObject({ url: z.string().min(1).max(2000) });

export async function POST(request: Request) {
  try {
    const payload = RequestSchema.parse(await request.json());
    const link = parseWclReportUrl(payload.url);
    return jsonData(await getWclClient().probeReport(link));
  } catch (error) {
    if (error instanceof InvalidWclReportUrlError || error instanceof z.ZodError) {
      return jsonError("INVALID_WCL_LINK", error instanceof Error ? error.message : "WCL 链接无效", 422);
    }
    if (error instanceof WclConfigurationError) return jsonError(error.code, error.message, 503);
    if (error instanceof WclClientError) return jsonError(error.code, error.message, error.status, { retryable: error.retryable });
    return jsonError("WCL_PROBE_FAILED", "读取 WCL 报告失败", 500);
  }
}
