import { catalogReleaseKeys, SEED_CATALOG, validateCatalogRelease } from "./catalog";
import { objectStore, type ObjectStore } from "./object-store";
import type { CatalogMechanicDefinition, CatalogRelease, CatalogSkillDefinition, TimelinePreset } from "./types";

export async function readCatalogRelease(version: string, store: ObjectStore = objectStore) {
  const keys = catalogReleaseKeys(version);
  const [manifest, playerSkills, bossMechanics, timelinePresets] = await Promise.all([
    store.getJson<CatalogRelease["manifest"]>(keys.manifest),
    store.getJson<CatalogSkillDefinition[]>(keys.playerSkills),
    store.getJson<CatalogMechanicDefinition[]>(keys.bossMechanics),
    store.getJson<TimelinePreset[]>(keys.timelinePresets),
  ]);
  if (!manifest || !playerSkills || !bossMechanics || !timelinePresets) return null;
  return validateCatalogRelease({ manifest, playerSkills, bossMechanics, timelinePresets });
}

export async function readCurrentCatalog(store: ObjectStore = objectStore) {
  const pointer = await store.getJson<{ version: string }>("catalog/current.json");
  if (!pointer?.version) return validateCatalogRelease(SEED_CATALOG);
  try {
    return await readCatalogRelease(pointer.version, store) ?? validateCatalogRelease(SEED_CATALOG);
  } catch {
    return validateCatalogRelease(SEED_CATALOG);
  }
}

export async function publishCatalogRelease(input: unknown, store: ObjectStore = objectStore) {
  const release = validateCatalogRelease(input);
  const now = Date.now();
  release.manifest.publishedAt = now;
  const keys = catalogReleaseKeys(release.manifest.version);
  await Promise.all([
    store.putJson(keys.manifest, release.manifest),
    store.putJson(keys.playerSkills, release.playerSkills),
    store.putJson(keys.bossMechanics, release.bossMechanics),
    store.putJson(keys.timelinePresets, release.timelinePresets),
  ]);
  await store.putJson("catalog/current.json", { version: release.manifest.version, publishedAt: now });
  return release;
}
