import type { PlanSnapshot } from "./types.ts";

export const MAX_SNAPSHOTS_PER_PLAN = 30;
export const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

export function isExpectedRevision(actual: number, expected: number) {
  return Number.isInteger(actual) && actual === expected;
}

export function snapshotIdsToDelete(
  snapshots: Array<Pick<PlanSnapshot, "id" | "planId" | "createdAt" | "bytes">>,
  maxPerPlan = MAX_SNAPSHOTS_PER_PLAN,
  maxBytes = MAX_SNAPSHOT_BYTES,
) {
  const remove = new Set<string>();
  const byPlan = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) byPlan.set(snapshot.planId, [...(byPlan.get(snapshot.planId) ?? []), snapshot]);
  for (const planSnapshots of byPlan.values()) {
    planSnapshots.sort((a, b) => b.createdAt - a.createdAt);
    for (const snapshot of planSnapshots.slice(maxPerPlan)) remove.add(snapshot.id);
  }
  const retained = snapshots.filter((snapshot) => !remove.has(snapshot.id)).sort((a, b) => a.createdAt - b.createdAt);
  let retainedBytes = retained.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  while (retainedBytes > maxBytes && retained.length) {
    const oldest = retained.shift()!;
    remove.add(oldest.id);
    retainedBytes -= oldest.bytes;
  }
  return { ids: remove, retainedBytes };
}
