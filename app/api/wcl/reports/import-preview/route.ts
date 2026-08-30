import { z } from "zod";
import { jsonData, jsonError } from "@/lib/server";
import { WclClientError } from "@/lib/wcl-client";
import {
  EncounterProfileNotConfiguredError,
  PlayerSkillProfileNotConfiguredError,
} from "@/lib/wcl-conversion";
import { UnsupportedDifficultyError } from "@/lib/wcl-contract";
import {
  createWclImportPreview,
  WclGameVersionNotConfiguredError,
} from "@/lib/wcl-import-server";
import {
  InvalidWclReportUrlError,
  parseWclReportUrl,
} from "@/lib/wcl-report";
import { getWclClient, WclConfigurationError } from "@/lib/wcl-server";

const RequestSchema = z.strictObject({
  url: z.string().min(1).max(2000),
  fightId: z.number().int().positive(),
});

export async function POST(request: Request) {
  try {
    const payload = RequestSchema.parse(await request.json());
    const link = parseWclReportUrl(payload.url);
    if (typeof link.fight === "number" && link.fight !== payload.fightId) {
      return jsonError("WCL_FIGHT_MISMATCH", "链接中的 fight 与当前选择不一致，请重新读取报告", 422);
    }
    return jsonData(await createWclImportPreview(getWclClient(), link, payload.fightId));
  } catch (error) {
    if (error instanceof InvalidWclReportUrlError || error instanceof z.ZodError) {
      return jsonError("INVALID_WCL_IMPORT", error instanceof Error ? error.message : "WCL 导入请求无效", 422);
    }
    if (error instanceof WclConfigurationError) return jsonError(error.code, error.message, 503);
    if (error instanceof WclClientError) return jsonError(error.code, error.message, error.status, { retryable: error.retryable });
    if (error instanceof UnsupportedDifficultyError) return jsonError(error.code, error.message, 422);
    if (error instanceof EncounterProfileNotConfiguredError) return jsonError(error.code, error.message, 422, error.selector);
    if (error instanceof PlayerSkillProfileNotConfiguredError) return jsonError(error.code, error.message, 422, error.selector);
    if (error instanceof WclGameVersionNotConfiguredError) return jsonError(error.code, error.message, 422);
    return jsonError("WCL_IMPORT_FAILED", "解析 WCL 事件并生成导入预览失败", 500);
  }
}
