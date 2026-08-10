import { publicPublication, readPublication, SHARE_ID_PATTERN } from "@/lib/publications";
import { jsonData, jsonError, serverError } from "@/lib/server";
import { UnsupportedDocumentVersionError } from "@/lib/types";

type RouteContext = { params: Promise<{ shareId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { shareId } = await context.params;
    if (!SHARE_ID_PATTERN.test(shareId)) return jsonError("NOT_FOUND", "分享链接无效", 404);
    const publication = await readPublication(shareId);
    if (!publication) return jsonError("NOT_FOUND", "分享内容不存在", 404);
    return jsonData(publicPublication(publication));
  } catch (error) {
    if (error instanceof UnsupportedDocumentVersionError) return jsonError("UNSUPPORTED_DOCUMENT_VERSION", "该分享使用了已停止支持的计划格式", 410);
    return jsonError("READ_PUBLICATION_FAILED", serverError(error, "读取分享内容失败"), 500);
  }
}
