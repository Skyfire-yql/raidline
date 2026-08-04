"use client";

import type { RaidPlanPreset } from "@/lib/presets";

const DB_NAME = "raidline-presets";
const STORE_NAME = "presets";

function openPresetDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地预设库"));
  });
}

export async function listPersonalPresets() {
  const db = await openPresetDb();
  return new Promise<RaidPlanPreset[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as RaidPlanPreset[]).sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error ?? new Error("读取本地预设失败"));
  }).finally(() => db.close());
}

export async function savePersonalPreset(preset: RaidPlanPreset) {
  const db = await openPresetDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(preset);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("保存本地预设失败"));
  }).finally(() => db.close());
}

export async function deletePersonalPreset(id: string) {
  const db = await openPresetDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("删除本地预设失败"));
  }).finally(() => db.close());
}
