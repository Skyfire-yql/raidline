import { assertSameOrigin, clearAdminCookie, createAdminCookie, isAdmin, verifyAdminPassword } from "@/lib/admin-auth";
import { jsonData, jsonError, serverError } from "@/lib/server";

export async function GET(request: Request) {
  return jsonData({ authenticated: await isAdmin(request) });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const payload = await request.json() as { password?: string };
    if (!await verifyAdminPassword(String(payload.password ?? ""))) return jsonError("INVALID_ADMIN_PASSWORD", "管理员口令不正确", 401);
    return jsonData({ authenticated: true }, { headers: { "set-cookie": await createAdminCookie(request) } });
  } catch (error) {
    return jsonError("ADMIN_LOGIN_FAILED", serverError(error, "登录失败"), 500);
  }
}

export async function DELETE(request: Request) {
  assertSameOrigin(request);
  return jsonData({ authenticated: false }, { headers: { "set-cookie": clearAdminCookie(request) } });
}
