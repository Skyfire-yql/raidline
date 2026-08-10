import { createPublication, publicationBinding, publicPublication } from "@/lib/publications";
import { isInputValidationError, jsonData, jsonError, serverError } from "@/lib/server";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { document?: unknown; shareId?: string; editId?: string };
    const requested = payload.shareId && payload.editId ? { shareId: payload.shareId, editId: payload.editId } : undefined;
    const publication = await createPublication(payload.document, undefined, requested);
    return jsonData({ ...publicPublication(publication), editId: publication.editId, binding: publicationBinding(publication) }, { status: 201 });
  } catch (error) {
    const message = serverError(error, "发布失败");
    return jsonError("CREATE_PUBLICATION_FAILED", message, /已存在/.test(message) ? 409 : isInputValidationError(error) ? 422 : 500);
  }
}
