"use client";

import { createBlankPlan, makeId, normalizePlanDocument } from "../../lib/core.ts";
import { validateCatalogRelease } from "../../lib/catalog.ts";
import { hashPlanDocument, sha256 } from "../../lib/hashing.ts";
import { isExpectedRevision, snapshotIdsToDelete } from "../../lib/local-policy.ts";
import type { CatalogRelease, LocalPlanRecord, PlanSnapshot, PublicationBinding, RaidPlanDocument, SnapshotReason } from "../../lib/types.ts";

const DB_NAME = "raidline-local";
const DB_VERSION = 1;

export class LocalRevisionConflictError extends Error {
  latest: LocalPlanRecord;
  constructor(latest: LocalPlanRecord) {
    super("此计划已在另一个标签页更新");
    this.name = "LocalRevisionConflictError";
    this.latest = latest;
  }
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已取消"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
  });
}

let databasePromise: Promise<IDBDatabase> | null = null;

async function normalizeLocalRecord(record: LocalPlanRecord, persist = false) {
  const schemaVersion = (record.document as unknown as { schemaVersion?: number }).schemaVersion;
  const document = normalizePlanDocument(record.document);
  if (schemaVersion === 4) return { ...record, document };
  let activePublication = record.activePublication;
  if (activePublication) {
    const legacyHash = await sha256(JSON.stringify(record.document));
    if (legacyHash === activePublication.contentHash) {
      activePublication = { ...activePublication, contentHash: await hashPlanDocument(document) };
    }
  }
  const migrated: LocalPlanRecord = { ...record, document, ...(activePublication ? { activePublication } : {}) };
  if (persist) {
    const db = await database();
    const transaction = db.transaction("plans", "readwrite");
    transaction.objectStore("plans").put(migrated);
    await transactionDone(transaction);
  }
  return migrated;
}

function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("plans")) db.createObjectStore("plans", { keyPath: "id" });
        if (!db.objectStoreNames.contains("snapshots")) {
          const store = db.createObjectStore("snapshots", { keyPath: "id" });
          store.createIndex("planId", "planId", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("catalogCache")) db.createObjectStore("catalogCache", { keyPath: "key" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库"));
    });
  }
  return databasePromise;
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* The browser may deny persistence silently. */ }
  return false;
}

export async function createLocalPlan(document: RaidPlanDocument = createBlankPlan(), activePublication?: PublicationBinding) {
  const normalized = normalizePlanDocument(document);
  const now = Date.now();
  const record: LocalPlanRecord = {
    id: crypto.randomUUID(),
    title: normalized.encounter.name.trim().slice(0, 80) || "未命名排轴",
    document: normalized,
    localRevision: 1,
    createdAt: now,
    updatedAt: now,
    ...(activePublication ? { activePublication } : {}),
  };
  const db = await database();
  const transaction = db.transaction("plans", "readwrite");
  transaction.objectStore("plans").add(record);
  await transactionDone(transaction);
  return record;
}

export async function getLocalPlan(id: string) {
  const db = await database();
  const transaction = db.transaction("plans", "readonly");
  const record = await requestValue(transaction.objectStore("plans").get(id) as IDBRequest<LocalPlanRecord | undefined>);
  await transactionDone(transaction);
  if (!record) return null;
  return normalizeLocalRecord(record, true);
}

export async function listLocalPlans() {
  const db = await database();
  const transaction = db.transaction("plans", "readonly");
  const records = await requestValue(transaction.objectStore("plans").getAll() as IDBRequest<LocalPlanRecord[]>);
  await transactionDone(transaction);
  const normalized = await Promise.all(records.map((record) => normalizeLocalRecord(record)));
  return normalized.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveLocalPlan(id: string, document: RaidPlanDocument, expectedRevision: number) {
  const normalized = normalizePlanDocument(document);
  const db = await database();
  const transaction = db.transaction("plans", "readwrite");
  const store = transaction.objectStore("plans");
  const current = await requestValue(store.get(id) as IDBRequest<LocalPlanRecord | undefined>);
  if (!current) {
    transaction.abort();
    throw new Error("本地计划不存在");
  }
  if (!isExpectedRevision(current.localRevision, expectedRevision)) {
    transaction.abort();
    throw new LocalRevisionConflictError({ ...current, document: normalizePlanDocument(current.document) });
  }
  const next: LocalPlanRecord = {
    ...current,
    title: normalized.encounter.name.trim().slice(0, 80) || "未命名排轴",
    document: normalized,
    localRevision: current.localRevision + 1,
    updatedAt: Date.now(),
  };
  store.put(next);
  await transactionDone(transaction);
  return next;
}

export async function setPlanPublication(id: string, publication: PublicationBinding | undefined, expectedRevision: number) {
  const db = await database();
  const transaction = db.transaction("plans", "readwrite");
  const store = transaction.objectStore("plans");
  const current = await requestValue(store.get(id) as IDBRequest<LocalPlanRecord | undefined>);
  if (!current) {
    transaction.abort();
    throw new Error("本地计划不存在");
  }
  const revisionConflict = !isExpectedRevision(current.localRevision, expectedRevision);
  const next: LocalPlanRecord = {
    ...current,
    localRevision: current.localRevision + 1,
    updatedAt: Date.now(),
    ...(publication ? { activePublication: publication } : {}),
  };
  if (!publication) delete next.activePublication;
  store.put(next);
  await transactionDone(transaction);
  if (revisionConflict) throw new LocalRevisionConflictError({ ...next, document: normalizePlanDocument(next.document) });
  return next;
}

export async function duplicateLocalPlan(source: LocalPlanRecord, title = `${source.document.encounter.name}（副本）`) {
  const document = structuredClone(source.document);
  document.encounter.name = title;
  return createLocalPlan(document);
}

export async function deleteLocalPlan(id: string) {
  const db = await database();
  const transaction = db.transaction(["plans", "snapshots"], "readwrite");
  transaction.objectStore("plans").delete(id);
  const snapshotStore = transaction.objectStore("snapshots");
  const snapshots = await requestValue(snapshotStore.index("planId").getAll(id) as IDBRequest<PlanSnapshot[]>);
  for (const snapshot of snapshots) snapshotStore.delete(snapshot.id);
  await transactionDone(transaction);
}

export async function createPlanSnapshot(planId: string, reason: SnapshotReason, document?: RaidPlanDocument, localRevision?: number) {
  const current = document ? null : await getLocalPlan(planId);
  const normalized = normalizePlanDocument(document ?? current?.document);
  const serialized = JSON.stringify(normalized);
  const snapshot: PlanSnapshot = {
    id: makeId("snapshot"),
    planId,
    localRevision: localRevision ?? current?.localRevision ?? 0,
    reason,
    createdAt: Date.now(),
    bytes: new TextEncoder().encode(serialized).byteLength,
    document: normalized,
  };
  const db = await database();
  const transaction = db.transaction("snapshots", "readwrite");
  transaction.objectStore("snapshots").put(snapshot);
  await transactionDone(transaction);
  await pruneSnapshots();
  return snapshot;
}

export async function listPlanSnapshots(planId: string) {
  const db = await database();
  const transaction = db.transaction("snapshots", "readonly");
  const records = await requestValue(transaction.objectStore("snapshots").index("planId").getAll(planId) as IDBRequest<PlanSnapshot[]>);
  await transactionDone(transaction);
  const migrated = records.map((snapshot) => ({ ...snapshot, document: normalizePlanDocument(snapshot.document) }));
  const changed = migrated.filter((snapshot, index) => (records[index].document as unknown as { schemaVersion?: number }).schemaVersion !== 4);
  if (changed.length) {
    const write = db.transaction("snapshots", "readwrite");
    const store = write.objectStore("snapshots");
    for (const snapshot of changed) store.put(snapshot);
    await transactionDone(write);
  }
  return migrated.sort((a, b) => b.createdAt - a.createdAt);
}

export async function pruneSnapshots() {
  const db = await database();
  const transaction = db.transaction("snapshots", "readwrite");
  const store = transaction.objectStore("snapshots");
  const all = await requestValue(store.getAll() as IDBRequest<PlanSnapshot[]>);
  const policy = snapshotIdsToDelete(all);
  for (const id of policy.ids) store.delete(id);
  await transactionDone(transaction);
  return { removed: policy.ids.size, retainedBytes: policy.retainedBytes };
}

export async function cacheCatalog(release: CatalogRelease) {
  const normalized = validateCatalogRelease(release);
  const db = await database();
  const transaction = db.transaction("catalogCache", "readwrite");
  transaction.objectStore("catalogCache").put({ key: "current", release: normalized, cachedAt: Date.now() });
  await transactionDone(transaction);
}

export async function getCachedCatalog() {
  const db = await database();
  const transaction = db.transaction("catalogCache", "readonly");
  const record = await requestValue(transaction.objectStore("catalogCache").get("current") as IDBRequest<{ key: string; release: CatalogRelease } | undefined>);
  await transactionDone(transaction);
  if (!record) return null;
  const normalized = validateCatalogRelease(record.release);
  if ((record.release.manifest as unknown as { schemaVersion?: number }).schemaVersion !== 2) await cacheCatalog(normalized);
  return normalized;
}

export async function setLocalSetting<T>(key: string, value: T) {
  const db = await database();
  const transaction = db.transaction("settings", "readwrite");
  transaction.objectStore("settings").put({ key, value });
  await transactionDone(transaction);
}

export async function getLocalSetting<T>(key: string) {
  const db = await database();
  const transaction = db.transaction("settings", "readonly");
  const record = await requestValue(transaction.objectStore("settings").get(key) as IDBRequest<{ key: string; value: T } | undefined>);
  await transactionDone(transaction);
  return record?.value;
}
