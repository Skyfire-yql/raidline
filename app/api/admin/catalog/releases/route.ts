import { assertSameOrigin, isAdmin } from "@/lib/admin-auth";
import { publishCatalogRelease } from "@/lib/catalog-server";
import { jsonData, jsonError, serverError } from "@/lib/server";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!await isAdmin(request)) return jsonError("UNAUTHORIZED", "请先登录管理后台", 401);
    const release = await publishCatalogRelease(await request.json());
    return jsonData(release, { status: 201 });
  } catch (error) {
    const message = serverError(error, "发布目录失败");
    return jsonError("PUBLISH_CATALOG_FAILED", message, /目录|预设|版本|ID/.test(message) ? 422 : 500);
  }
}
