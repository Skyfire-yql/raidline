export type TimelineOrientation = "horizontal" | "vertical";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;

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
