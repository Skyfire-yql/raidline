import { normalizePlanDocument } from "./core";
import { hashPlanDocument } from "./hashing";
import { objectStore, type ObjectStore } from "./object-store";
import { assertEditId, assertShareId, randomBase62 } from "./publication-ids";
import type { PublishedPlan, PublicPublication, RaidPlanDocument } from "./types";

export { EDIT_ID_PATTERN, SHARE_ID_PATTERN } from "./publication-ids";

export function publicationKey(shareId: string) {
  return `shares/${shareId}.json`;
}

export async function buildPublication(shareId: string, editId: string, input: unknown): Promise<PublishedPlan> {
  assertShareId(shareId);
  assertEditId(editId);
  const document = normalizePlanDocument(input);
  return {
    shareId,
    editId,
    revisionId: crypto.randomUUID(),
    publishedAt: Date.now(),
    contentHash: await hashPlanDocument(document),
    document,
  };
}

export async function createPublication(input: unknown, store: ObjectStore = objectStore, requested?: { shareId: string; editId: string }) {
  if (requested) {
    assertShareId(requested.shareId);
    assertEditId(requested.editId);
    if (await store.exists(publicationKey(requested.shareId))) throw new Error("分享 ID 已存在");
    const publication = await buildPublication(requested.shareId, requested.editId, input);
    await store.putJson(publicationKey(requested.shareId), publication);
    return publication;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const shareId = randomBase62(16);
    if (await store.exists(publicationKey(shareId))) continue;
    const publication = await buildPublication(shareId, randomBase62(4), input);
    await store.putJson(publicationKey(shareId), publication);
    return publication;
  }
  throw new Error("无法生成唯一分享 ID，请重试");
}

export async function readPublication(shareId: string, store: ObjectStore = objectStore) {
  assertShareId(shareId);
  const value = await store.getJson<PublishedPlan>(publicationKey(shareId));
  if (!value) return null;
  return { ...value, document: normalizePlanDocument(value.document) };
}

export async function replacePublication(shareId: string, editId: string, input: unknown, store: ObjectStore = objectStore) {
  assertShareId(shareId);
  assertEditId(editId);
  const current = await readPublication(shareId, store);
  if (!current || current.editId !== editId) return null;
  const publication = await buildPublication(shareId, editId, input);
  await store.putJson(publicationKey(shareId), publication);
  return publication;
}

export async function deletePublication(shareId: string, editId: string, store: ObjectStore = objectStore) {
  assertShareId(shareId);
  assertEditId(editId);
  const current = await readPublication(shareId, store);
  if (!current || current.editId !== editId) return false;
  await store.delete(publicationKey(shareId));
  return true;
}

export function publicPublication(publication: PublishedPlan) {
  const visible = structuredClone(publication) as Partial<PublishedPlan>;
  delete visible.editId;
  return visible as PublicPublication;
}

export function publicationBinding(publication: PublishedPlan) {
  const { shareId, editId, revisionId, publishedAt, contentHash } = publication;
  return { shareId, editId, revisionId, publishedAt, contentHash };
}

export async function confirmPublishedHash(shareId: string, expectedHash: string, store: ObjectStore = objectStore) {
  const publication = await readPublication(shareId, store);
  return publication?.contentHash === expectedHash ? publication : null;
}

export function clonePublicationDocument(document: RaidPlanDocument) {
  return structuredClone(document);
}
