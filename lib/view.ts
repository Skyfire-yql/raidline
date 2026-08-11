import { MAX_TIMELINE_MS, TIMELINE_SNAP_MS } from "./domain/schema";
import { buildTimelineScene, type TimelineScene } from "./domain/view-model";
import type { RaidPlanDocument } from "./types";

export type TimelineOrientation = "horizontal" | "vertical";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const MIN_TIMELINE_MS = 120_000;
export const TIMELINE_TAIL_MS = 30_000;

export function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

export function zoomFromWheel(current: number, deltaY: number) {
  return clampZoom(current + (deltaY < 0 ? 0.1 : -0.1));
}

export function shouldInterceptTimelineWheel(ctrlKey: boolean, pointerInTimeline: boolean) {
  return ctrlKey && pointerInTimeline;
}

export function anchoredScroll(currentScroll: number, pointerOffset: number, currentZoom: number, nextZoom: number) {
  if (currentZoom <= 0) return currentScroll;
  const contentPoint = (currentScroll + pointerOffset) / currentZoom;
  return Math.max(0, contentPoint * nextZoom - pointerOffset);
}

export function defaultOrientation(width: number): TimelineOrientation {
  return width < 720 ? "vertical" : "horizontal";
}

export function viewPreferenceKey(scope: "plan" | "shared", id: string, width: number) {
  const device = width < 720 ? "mobile" : "desktop";
  return `raidline:view:${scope}:${device}:${id}`;
}

export function timeAxisPosition(ms: number, pixelsPerSecond: number) {
  return Math.max(0, ms / 1000 * pixelsPerSecond);
}

function scene(value: RaidPlanDocument | TimelineScene) {
  return "schemaVersion" in value ? buildTimelineScene(value) : value;
}

export function timelineContentEnd(value: RaidPlanDocument | TimelineScene) {
  const resolved = scene(value);
  const ends = [
    ...resolved.phases.map((item) => item.atMs),
    ...resolved.directives.map((item) => item.atMs + item.durationMs),
    ...resolved.mechanics.map((item) => item.endMs),
    ...resolved.assignments.map((item) => Math.max(item.atMs + item.castTimeMs, item.effectStartMs + item.durationMs)),
  ];
  return Math.min(MAX_TIMELINE_MS, Math.max(0, ...ends));
}

export function timelineRangeMs(value: RaidPlanDocument | TimelineScene) {
  return scene(value).durationMs;
}

export function adaptiveTickMs(pixelsPerSecond: number) {
  const options = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
  return options.find((value) => value / 1000 * pixelsPerSecond >= 72) ?? options.at(-1)!;
}

export function timelineTimeFromDrag(
  startAtMs: number,
  deltaPixels: number,
  pixelsPerSecond: number,
  maximumMs = MAX_TIMELINE_MS,
) {
  const raw = startAtMs + deltaPixels / Math.max(0.1, pixelsPerSecond) * 1000;
  return Math.min(maximumMs, Math.max(0, Math.round(raw / TIMELINE_SNAP_MS) * TIMELINE_SNAP_MS));
}
