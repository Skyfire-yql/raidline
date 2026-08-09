import { env } from "cloudflare:workers";
import { sha256 } from "./hashing";
import { readCookie, safeEqual } from "./server";

const COOKIE_NAME = "raidline_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;

function configuration() {
  const bindings = env as unknown as { ADMIN_PASSWORD_HASH?: string; ADMIN_SESSION_SECRET?: string };
  if (!bindings.ADMIN_PASSWORD_HASH || !bindings.ADMIN_SESSION_SECRET) throw new Error("管理后台尚未配置");
  return { passwordHash: bindings.ADMIN_PASSWORD_HASH, sessionSecret: bindings.ADMIN_SESSION_SECRET };
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signed));
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Error("请求来源无效");
}

export async function verifyAdminPassword(password: string) {
  const { passwordHash } = configuration();
  if (password.length > 200) return false;
  return safeEqual(await sha256(password), passwordHash.toLowerCase());
}

export async function createAdminCookie(request: Request) {
  const { sessionSecret } = configuration();
  const expires = Date.now() + SESSION_MS;
  const value = `${expires}.${await signature(String(expires), sessionSecret)}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`;
}

export function clearAdminCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function isAdmin(request: Request) {
  try {
    const { sessionSecret } = configuration();
    const value = readCookie(request, COOKIE_NAME);
    const [expiresText, candidate] = value.split(".");
    const expires = Number(expiresText);
    if (!candidate || !Number.isFinite(expires) || expires <= Date.now()) return false;
    return safeEqual(candidate, await signature(expiresText, sessionSecret));
  } catch {
    return false;
  }
}
