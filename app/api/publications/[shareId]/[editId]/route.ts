import { deletePublication, EDIT_ID_PATTERN, publicationBinding, publicPublication, readPublication, replacePublication, SHARE_ID_PATTERN } from "@/lib/publications";
import { jsonData, jsonError, serverError } from "@/lib/server";

type RouteContext = { params: Promise<{ shareId: string; editId: string }> };

async function authorized(context: RouteContext) {
  const { shareId, editId } = await context.params;
  if (!SHARE_ID_PATTERN.test(shareId) || !EDIT_ID_PATTERN.test(editId)) return { shareId, editId, error: jsonError("NOT_FOUND", "编辑链接无效", 404) };
  const publication = await readPublication(shareId);
  if (!publication) return { shareId, editId, error: jsonError("NOT_FOUND", "分享内容不存在", 404) };
  if (publication.editId !== editId) return { shareId, editId, error: jsonError("EDIT_ID_REJECTED", "编辑 ID 不正确", 403) };
  return { shareId, editId, publication };
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const result = await authorized(context);
    if ("error" in result) return result.error;
    return jsonData({ ...publicPublication(result.publication), editId: result.editId, binding: publicationBinding(result.publication) });
  } catch (error) {
    return jsonError("READ_EDITABLE_PUBLICATION_FAILED", serverError(error, "读取编辑版本失败"), 500);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const result = await authorized(context);
    if ("error" in result) return result.error;
    const payload = await request.json() as { document?: unknown };
    const publication = await replacePublication(result.shareId, result.editId, payload.document);
    if (!publication) return jsonError("EDIT_ID_REJECTED", "编辑 ID 不正确", 403);
    return jsonData({ ...publicPublication(publication), editId: result.editId, binding: publicationBinding(publication) });
  } catch (error) {
    const message = serverError(error, "覆盖发布失败");
    return jsonError("UPDATE_PUBLICATION_FAILED", message, /计划|版本|超出|无效|时长/.test(message) ? 422 : 500);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const result = await authorized(context);
    if ("error" in result) return result.error;
    if (!await deletePublication(result.shareId, result.editId)) return jsonError("EDIT_ID_REJECTED", "编辑 ID 不正确", 403);
    return jsonData({ deleted: true });
  } catch (error) {
    return jsonError("DELETE_PUBLICATION_FAILED", serverError(error, "删除发布失败"), 500);
  }
}
