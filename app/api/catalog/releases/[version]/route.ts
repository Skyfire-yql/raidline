import { readCatalogRelease } from "@/lib/catalog-server";
import { jsonData, jsonError, serverError } from "@/lib/server";

type RouteContext = { params: Promise<{ version: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { version } = await context.params;
    const release = await readCatalogRelease(version);
    if (!release) return jsonError("NOT_FOUND", "目录版本不存在", 404);
    return jsonData(release);
  } catch (error) {
    const message = serverError(error, "读取目录版本失败");
    return jsonError("READ_CATALOG_RELEASE_FAILED", message, /版本标识/.test(message) ? 404 : 500);
  }
}
