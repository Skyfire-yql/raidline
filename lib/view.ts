import { MAX_TIMELINE_MS, TIMELINE_SNAP_MS } from "./domain/schema";
import { buildTimelineScene, type TimelineScene, type TimelineSceneMechanic } from "./domain/view-model";
import type { RaidPlanDocument } from "./types";

export type TimelineOrientation = "horizontal" | "vertical";
export type MechanicLaneMode = "compact" | "by-type";

export interface MechanicLane {
  key: string;
  label: string;
  mechanicCount: number;
  crossSizePx: number;
  labelRowCrossSizesPx: number[];
}

export interface MechanicPartMeasurement {
  axisSizePx: number;
  crossSizePx: number;
}

export interface MechanicPartLayout {
  index: number;
  targetAxisPx: number;
  labelStartPx: number;
  labelAxisSizePx: number;
  labelMaxAxisSizePx: number;
  labelCrossSizePx: number;
  labelRow: number;
}

export interface MechanicPresentationLayout {
  axisStartPx: number;
  axisEndPx: number;
  parts: MechanicPartLayout[];
}

export interface MechanicLaneLayout {
  lanes: MechanicLane[];
  laneByMechanicId: ReadonlyMap<string, number>;
  presentationByMechanicId: ReadonlyMap<string, MechanicPresentationLayout>;
  totalCrossSizePx: number;
  axisEndPx: number;
}

export const MIN_ZOOM = 4;
export const MAX_ZOOM = 16;
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

export function mechanicPresentationPartKey(mechanicId: string, partIndex: number) {
  return `${mechanicId}:${partIndex}`;
}

function estimatedLabelWidth(text: string) {
  let width = 16;
  for (const character of text) width += character.charCodeAt(0) > 0xff ? 11.5 : character === " " ? 4 : 6.8;
  return Math.max(24, Math.ceil(width));
}

interface LabelSeed extends MechanicPartLayout {
  originalOrder: number;
}

const LABEL_GAP_PX = 6;
const LABEL_ROW_GAP_PX = 2;
const PREFERRED_LABEL_ROWS = 2;
const MIN_TRUNCATED_LABEL_PX = 28;

function packMechanicLabels(labels: LabelSeed[], orientation: TimelineOrientation) {
  const sorted = [...labels].sort((left, right) => left.targetAxisPx - right.targetAxisPx || left.originalOrder - right.originalOrder);
  const rows: LabelSeed[][] = [];
  for (const label of sorted) {
    label.labelStartPx = label.targetAxisPx;
    label.labelMaxAxisSizePx = label.labelAxisSizePx;
    let row = rows.findIndex((items) => {
      const previous = items.at(-1);
      return !previous || previous.labelStartPx + previous.labelMaxAxisSizePx + LABEL_GAP_PX <= label.targetAxisPx;
    });
    if (row < 0 && rows.length < PREFERRED_LABEL_ROWS) row = rows.length;
    if (row < 0 && orientation === "horizontal") {
      const candidates = rows.flatMap((items, rowIndex) => {
        const previous = items.at(-1)!;
        const available = label.targetAxisPx - previous.labelStartPx - LABEL_GAP_PX;
        return available >= MIN_TRUNCATED_LABEL_PX
          ? [{ rowIndex, previous, available, reduction: Math.max(0, previous.labelMaxAxisSizePx - available) }]
          : [];
      }).sort((left, right) => left.reduction - right.reduction || left.rowIndex - right.rowIndex);
      const candidate = candidates[0];
      if (candidate) {
        candidate.previous.labelMaxAxisSizePx = Math.min(candidate.previous.labelMaxAxisSizePx, candidate.available);
        row = candidate.rowIndex;
      }
    }
    if (row < 0) row = rows.length;
    rows[row] ??= [];
    label.labelRow = row;
    rows[row].push(label);
  }
  return sorted;
}

function mechanicPresentationLayout(
  mechanic: TimelineSceneMechanic,
  orientation: TimelineOrientation,
  pixelsPerSecond: number,
  includeLabels: boolean,
  measurements?: ReadonlyMap<string, MechanicPartMeasurement>,
): MechanicPresentationLayout {
  const labelSeeds = mechanic.presentationParts.map<LabelSeed>((part, originalOrder) => {
    const measurement = measurements?.get(mechanicPresentationPartKey(mechanic.id, part.index));
    const targetMs = part.kind === "interval" ? part.startMs : part.atMs;
    const estimatedWidth = estimatedLabelWidth(part.text);
    return {
      index: part.index,
      originalOrder,
      targetAxisPx: timeAxisPosition(targetMs, pixelsPerSecond),
      labelStartPx: timeAxisPosition(targetMs, pixelsPerSecond),
      labelAxisSizePx: measurement?.axisSizePx ?? (orientation === "horizontal" ? estimatedWidth : 22),
      labelMaxAxisSizePx: measurement?.axisSizePx ?? (orientation === "horizontal" ? estimatedWidth : 22),
      labelCrossSizePx: measurement?.crossSizePx ?? (orientation === "horizontal" ? 22 : estimatedWidth),
      labelRow: 0,
    };
  });
  const labels = includeLabels ? packMechanicLabels(labelSeeds, orientation) : labelSeeds;
  const visualBounds = mechanic.presentationParts.flatMap((part) => {
    if (part.kind === "interval") return [timeAxisPosition(part.startMs, pixelsPerSecond), timeAxisPosition(part.endMs, pixelsPerSecond)];
    const center = timeAxisPosition(part.atMs, pixelsPerSecond);
    return [center - 4, center + 4];
  });
  const labelBounds = includeLabels ? labels.flatMap((label) => [label.labelStartPx, label.labelStartPx + label.labelMaxAxisSizePx]) : [];
  return {
    axisStartPx: Math.max(0, Math.min(...visualBounds, ...labelBounds) - 6),
    axisEndPx: Math.max(0, ...visualBounds, ...labelBounds) + 6,
    parts: labels.sort((left, right) => left.originalOrder - right.originalOrder).map((label) => ({
      index: label.index,
      targetAxisPx: label.targetAxisPx,
      labelStartPx: label.labelStartPx,
      labelAxisSizePx: label.labelAxisSizePx,
      labelMaxAxisSizePx: label.labelMaxAxisSizePx,
      labelCrossSizePx: label.labelCrossSizePx,
      labelRow: label.labelRow,
    })),
  };
}

function compactLaneCrossSizes(
  mechanicIds: readonly string[],
  presentationByMechanicId: ReadonlyMap<string, MechanicPresentationLayout>,
) {
  const sizes: number[] = [];
  for (const id of mechanicIds) {
    for (const part of presentationByMechanicId.get(id)?.parts ?? []) {
      sizes[part.labelRow] = Math.max(sizes[part.labelRow] ?? 0, part.labelCrossSizePx);
    }
  }
  return sizes;
}

function compactLaneCrossSize(orientation: TimelineOrientation, labelRowCrossSizesPx: readonly number[]) {
  const labelsCrossSize = labelRowCrossSizesPx.reduce((total, size) => total + size, 0)
    + Math.max(0, labelRowCrossSizesPx.length - 1) * LABEL_ROW_GAP_PX;
  return Math.max(orientation === "horizontal" ? 46 : 104, labelsCrossSize + 24);
}

export function layoutMechanicLanes(
  mechanics: readonly TimelineSceneMechanic[],
  mode: MechanicLaneMode,
  orientation: TimelineOrientation,
  pixelsPerSecond: number,
  measurements?: ReadonlyMap<string, MechanicPartMeasurement>,
): MechanicLaneLayout {
  const laneByMechanicId = new Map<string, number>();
  const presentationByMechanicId = new Map(mechanics.map((mechanic) => [
    mechanic.id,
    mechanicPresentationLayout(mechanic, orientation, pixelsPerSecond, mode === "compact", measurements),
  ]));
  const byTypeCrossSize = orientation === "horizontal" ? 42 : 112;
  const compactEmptyCrossSize = orientation === "horizontal" ? 46 : 104;
  if (mode === "by-type") {
    const laneByDefinitionId = new Map<string, number>();
    const lanes: MechanicLane[] = [];
    for (const mechanic of mechanics) {
      let lane = laneByDefinitionId.get(mechanic.definitionId);
      if (lane == null) {
        lane = lanes.length;
        laneByDefinitionId.set(mechanic.definitionId, lane);
        lanes.push({ key: mechanic.definitionId, label: mechanic.typeName, mechanicCount: 0, crossSizePx: byTypeCrossSize, labelRowCrossSizesPx: [] });
      }
      lanes[lane].mechanicCount += 1;
      laneByMechanicId.set(mechanic.id, lane);
    }
    const resolvedLanes = lanes.length ? lanes : [{ key: "empty", label: "BOSS 机制", mechanicCount: 0, crossSizePx: byTypeCrossSize, labelRowCrossSizesPx: [] }];
    return {
      lanes: resolvedLanes,
      laneByMechanicId,
      presentationByMechanicId,
      totalCrossSizePx: resolvedLanes.reduce((total, lane) => total + lane.crossSizePx, 0),
      axisEndPx: Math.max(0, ...[...presentationByMechanicId.values()].map((layout) => layout.axisEndPx)),
    };
  }

  const intervals = mechanics.map((mechanic, order) => ({ mechanic, order, ...presentationByMechanicId.get(mechanic.id)! }))
    .sort((left, right) => left.axisStartPx - right.axisStartPx || left.order - right.order);
  const laneEnds: number[] = [];
  const counts: number[] = [];
  for (const interval of intervals) {
    let lane = laneEnds.findIndex((end) => end <= interval.axisStartPx);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(interval.axisEndPx);
      counts.push(0);
    } else laneEnds[lane] = interval.axisEndPx;
    counts[lane] += 1;
    laneByMechanicId.set(interval.mechanic.id, lane);
  }
  const lanes = counts.map((mechanicCount, index) => {
    const mechanicIds = [...laneByMechanicId].filter(([, lane]) => lane === index).map(([id]) => id);
    const labelRowCrossSizesPx = compactLaneCrossSizes(mechanicIds, presentationByMechanicId);
    return {
      key: `compact-${index}`,
      label: "BOSS 机制",
      mechanicCount,
      crossSizePx: compactLaneCrossSize(orientation, labelRowCrossSizesPx),
      labelRowCrossSizesPx,
    };
  });
  const resolvedLanes = lanes.length ? lanes : [{ key: "empty", label: "BOSS 机制", mechanicCount: 0, crossSizePx: compactEmptyCrossSize, labelRowCrossSizesPx: [] }];
  return {
    lanes: resolvedLanes,
    laneByMechanicId,
    presentationByMechanicId,
    totalCrossSizePx: resolvedLanes.reduce((total, lane) => total + lane.crossSizePx, 0),
    axisEndPx: Math.max(0, ...[...presentationByMechanicId.values()].map((layout) => layout.axisEndPx)),
  };
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
