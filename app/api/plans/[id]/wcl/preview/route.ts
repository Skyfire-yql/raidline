import { authorizePlan, jsonData, jsonError } from "@/lib/server";
import { previewWclReport, WclError } from "@/lib/wcl";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const auth = await authorizePlan(request, id);
    if (!auth.ok) return jsonError("UNAUTHORIZED", auth.reason, auth.reason === "计划不存在" ? 404 : 401);
    const payload = (await request.json()) as { source?: string };
    if (!payload.source) return jsonError("INVALID_WCL_URL", "请输入 WCL 战报链接或报告代码", 400);
    return jsonData(await previewWclReport(payload.source));
  } catch (error) {
    if (error instanceof WclError) return jsonError(error.code, error.message, error.status);
    return jsonError("WCL_PREVIEW_FAILED", error instanceof Error ? error.message : "读取 WCL 战报失败", 500);
  }
}
