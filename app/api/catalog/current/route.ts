import { readCurrentCatalog } from "@/lib/catalog-server";
import { jsonData, jsonError, serverError } from "@/lib/server";

export async function GET() {
  try {
    return jsonData(await readCurrentCatalog());
  } catch (error) {
    return jsonError("READ_CATALOG_FAILED", serverError(error, "读取目录失败"), 500);
  }
}
