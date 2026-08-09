import type { RaidPlanDocument } from "./types";

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function serializePlan(document: RaidPlanDocument) {
  return JSON.stringify(document);
}

export function hashPlanDocument(document: RaidPlanDocument) {
  return sha256(serializePlan(document));
}
