import type { ApiError } from "./types";

export function jsonData<T>(data: T, init?: ResponseInit) {
  return Response.json({ data }, init);
}

export function jsonError(code: string, message: string, status = 400, details?: unknown) {
  const error: ApiError = { code, message, ...(details === undefined ? {} : { details }) };
  return Response.json({ error }, { status });
}

export function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function serverError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
