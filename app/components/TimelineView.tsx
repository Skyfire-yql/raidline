"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { formatTime, MAX_TIMELINE_MS } from "@/lib/core";
import { specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import type { TimelineScene, TimelineSceneMechanic, TimelineSceneMechanicPart } from "@/lib/domain/view-model";
import { adaptiveTickMs, clampZoom, layoutMechanicLanes, mechanicPresentationPartKey, timeAxisPosition, timelineTimeFromDrag, type MechanicLane, type MechanicLaneMode, type MechanicPartMeasurement, type TimelineOrientation } from "@/lib/view";

export type TimelineSelectionKey = `mechanic:${string}` | `assignment:${string}` | `phase:${string}` | `directive:${string}` | null;
type DragKind = "mechanic" | "assignment" | "phase" | "directive";

interface TimelineViewProps {
  scene: TimelineScene;
  orientation: TimelineOrientation;
  mechanicLaneMode?: MechanicLaneMode;
  zoom: number;
  selected?: TimelineSelectionKey;
  warningIds?: Set<string>;
  readOnly?: boolean;
  scrollOffset?: { left: number; top: number };
  onSelect?: (key: TimelineSelectionKey) => void;
  onSelectMember?: (id: string) => void;
  onOpenMemberSkills?: (id: string, atMs: number) => void;
  onAddMember?: () => void;
  onAddPhase?: (atMs: number) => void;
  onAddDirective?: (kind: "task" | "note", atMs: number) => void;
  onAddMechanic?: (atMs: number) => void;
  onMovePhase?: (id: string, atMs: number) => void;
  onMoveDirective?: (id: string, atMs: number) => void;
  onMoveMechanic?: (id: string, atMs: number) => void;
  onMoveAssignment?: (id: string, atMs: number) => void;
}

interface ActiveDrag {
  kind: DragKind;
  id: string;
  pointerId: number;
  startAxis: number;
  startAtMs: number;
  moved: boolean;
}

const LABEL = 148;
const HEADER = 52;
const LANE = 62;
const COLUMN = 150;
const END_GUTTER_HORIZONTAL = 42;
const END_GUTTER_VERTICAL = 24;

function lengthStyle(orientation: TimelineOrientation, start: number, length: number, crossStart: number, pixelsPerSecond: number): CSSProperties {
  const startPx = timeAxisPosition(start, pixelsPerSecond);
  const lengthPx = Math.max(2, timeAxisPosition(length, pixelsPerSecond));
  return orientation === "horizontal"
    ? { left: LABEL + startPx, top: HEADER + crossStart + 15, width: lengthPx }
    : { top: HEADER + startPx, left: LABEL + crossStart + 18, height: lengthPx };
}

function pointStyle(orientation: TimelineOrientation, atMs: number, crossStart: number, pixelsPerSecond: number, crossOffset = 0): CSSProperties {
  const axis = timeAxisPosition(atMs, pixelsPerSecond);
  return orientation === "horizontal"
    ? { left: LABEL + axis, top: HEADER + crossStart + 24 + crossOffset }
    : { top: HEADER + axis, left: LABEL + crossStart + 27 + crossOffset };
}

function mechanicBarCenter(crossSize: number, mode: MechanicLaneMode) {
  if (mode === "by-type") return crossSize / 2;
  return crossSize - 11;
}

function mechanicIntervalStyle(orientation: TimelineOrientation, part: Extract<TimelineSceneMechanicPart, { kind: "interval" }>, crossStart: number, crossSize: number, mode: MechanicLaneMode, pixelsPerSecond: number): CSSProperties {
  const startPx = timeAxisPosition(part.startMs, pixelsPerSecond);
  const lengthPx = Math.max(2, timeAxisPosition(part.endMs - part.startMs, pixelsPerSecond));
  const center = mechanicBarCenter(crossSize, mode);
  return orientation === "horizontal"
    ? { left: LABEL + startPx, top: HEADER + crossStart + center - 5, width: lengthPx, height: 10 }
    : { top: HEADER + startPx, left: LABEL + crossStart + center - 5, width: 10, height: lengthPx };
}

function mechanicMarkerStyle(orientation: TimelineOrientation, part: Extract<TimelineSceneMechanicPart, { kind: "marker" }>, crossStart: number, crossSize: number, mode: MechanicLaneMode, pixelsPerSecond: number): CSSProperties {
  const axis = timeAxisPosition(part.atMs, pixelsPerSecond);
  const center = mechanicBarCenter(crossSize, mode);
  const crossLength = part.tone === "judgment" ? 18 : 14;
  return orientation === "horizontal"
    ? { left: LABEL + axis - 4, top: HEADER + crossStart + center - crossLength / 2, width: 8, height: crossLength }
    : { top: HEADER + axis - 4, left: LABEL + crossStart + center - crossLength / 2, width: crossLength, height: 8 };
}

function mechanicLabelRowCrossOffset(lane: MechanicLane, row: number) {
  return 2 + lane.labelRowCrossSizesPx.slice(0, row).reduce((total, size) => total + size, 0) + row * 2;
}

function mechanicStageLabelStyle(orientation: TimelineOrientation, labelStartPx: number, crossStart: number, labelCrossOffset: number): CSSProperties {
  return orientation === "horizontal"
    ? { left: LABEL + labelStartPx, top: HEADER + crossStart + labelCrossOffset }
    : { top: HEADER + labelStartPx, left: LABEL + crossStart + labelCrossOffset };
}

function shiftedMechanic(mechanic: TimelineSceneMechanic, atMs: number): TimelineSceneMechanic {
  const delta = atMs - mechanic.atMs;
  return {
    ...mechanic,
    atMs,
    impactMs: mechanic.impactMs + delta,
    endMs: mechanic.endMs + delta,
    presentationParts: mechanic.presentationParts.map((part) => part.kind === "interval"
      ? { ...part, startMs: part.startMs + delta, endMs: part.endMs + delta }
      : { ...part, atMs: part.atMs + delta }),
  };
}

function mechanicPartTiming(part: TimelineSceneMechanicPart) {
  return part.kind === "interval"
    ? `${part.text} ${formatTime(part.startMs)}–${formatTime(part.endMs)}`
    : `${part.text} ${formatTime(part.atMs)}`;
}

function sameMeasurements(left: ReadonlyMap<string, MechanicPartMeasurement>, right: ReadonlyMap<string, MechanicPartMeasurement>) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const candidate = right.get(key);
    if (!candidate || Math.abs(candidate.axisSizePx - value.axisSizePx) > 0.5 || Math.abs(candidate.crossSizePx - value.crossSizePx) > 0.5) return false;
  }
  return true;
}

export function MechanicLaneModeControl({ value, onChange }: { value: MechanicLaneMode; onChange: (value: MechanicLaneMode) => void }) {
  return <div className="mechanic-lane-mode-control" role="group" aria-label="BOSS 机制子轨道布局">
    <button type="button" aria-pressed={value === "compact"} className={value === "compact" ? "active" : ""} onClick={() => onChange("compact")} title="按当前缩放下的可见碰撞自动使用最少子轨道">紧凑</button>
    <button type="button" aria-pressed={value === "by-type"} className={value === "by-type" ? "active" : ""} onClick={() => onChange("by-type")} title="每种机制定义固定使用自己的子轨道">宽松</button>
  </div>;
}

export function TimelineView({
  scene,
  orientation,
  mechanicLaneMode = "compact",
  zoom,
  selected = null,
  warningIds = new Set(),
  readOnly = false,
  scrollOffset = { left: 0, top: 0 },
  onSelect,
  onSelectMember,
  onOpenMemberSkills,
  onAddMember,
  onAddPhase,
  onAddDirective,
  onAddMechanic,
  onMovePhase,
  onMoveDirective,
  onMoveMechanic,
  onMoveAssignment,
}: TimelineViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mechanicLabelRefs = useRef(new Map<string, HTMLButtonElement>());
  const [viewport, setViewport] = useState({ width: 920, height: 620 });
  const [mechanicPartMeasurements, setMechanicPartMeasurements] = useState<ReadonlyMap<string, MechanicPartMeasurement>>(() => new Map());
  const dragRef = useRef<ActiveDrag | null>(null);
  const suppressedClickRef = useRef<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ kind: DragKind; id: string; atMs: number } | null>(null);
  const durationMs = scene.durationMs;
  const timeViewport = orientation === "horizontal"
    ? Math.max(320, viewport.width - LABEL - END_GUTTER_HORIZONTAL)
    : Math.max(320, viewport.height - HEADER - END_GUTTER_VERTICAL);
  const fitPixelsPerSecond = timeViewport / Math.max(1, durationMs / 1000);
  const pixelsPerSecond = fitPixelsPerSecond * clampZoom(zoom);
  const durationPx = timeAxisPosition(durationMs, pixelsPerSecond);
  const displayedMechanics = scene.mechanics.map((mechanic) => {
    const atMs = dragPreview?.kind === "mechanic" && dragPreview.id === mechanic.id ? dragPreview.atMs : mechanic.atMs;
    return shiftedMechanic(mechanic, atMs);
  });
  const mechanicLanes = layoutMechanicLanes(displayedMechanics, mechanicLaneMode, orientation, pixelsPerSecond, mechanicPartMeasurements);
  const standardCrossSize = orientation === "horizontal" ? LANE : COLUMN;
  const mechanicLaneCrossStarts: number[] = [];
  let crossCursor = standardCrossSize;
  for (const lane of mechanicLanes.lanes) {
    mechanicLaneCrossStarts.push(crossCursor);
    crossCursor += lane.crossSizePx;
  }
  const memberLaneStart = crossCursor;
  const totalCrossSize = memberLaneStart + (scene.members.length + (readOnly ? 0 : 1)) * standardCrossSize;
  const laneBoundaryCrossPositions = [
    standardCrossSize,
    ...mechanicLanes.lanes.map((lane, index) => mechanicLaneCrossStarts[index] + lane.crossSizePx),
    ...Array.from({ length: scene.members.length + (readOnly ? 0 : 1) }, (_, index) => memberLaneStart + (index + 1) * standardCrossSize),
  ];
  const axisContentPx = Math.max(durationPx, mechanicLanes.axisEndPx) + (orientation === "horizontal" ? END_GUTTER_HORIZONTAL : END_GUTTER_VERTICAL);
  const canvasStyle: CSSProperties = orientation === "horizontal"
    ? { width: Math.max(viewport.width, LABEL + axisContentPx), height: Math.max(viewport.height, HEADER + totalCrossSize) }
    : { width: Math.max(viewport.width, LABEL + totalCrossSize), height: Math.max(viewport.height, HEADER + axisContentPx) };
  const tickMs = adaptiveTickMs(pixelsPerSecond);
  const ticks = Array.from({ length: Math.floor(durationMs / tickMs) + 1 }, (_, index) => index * tickMs);
  if (ticks.at(-1) !== durationMs) ticks.push(durationMs);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    const update = () => setViewport({ width: parent.clientWidth, height: parent.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (mechanicLaneMode !== "compact") return;
    const measure = () => {
      const next = new Map<string, MechanicPartMeasurement>();
      for (const [key, element] of mechanicLabelRefs.current) {
        const bounds = element.getBoundingClientRect();
        const intrinsicWidth = Math.max(bounds.width, element.scrollWidth);
        next.set(key, orientation === "horizontal"
          ? { axisSizePx: intrinsicWidth, crossSizePx: bounds.height }
          : { axisSizePx: bounds.height, crossSizePx: intrinsicWidth });
      }
      setMechanicPartMeasurements((current) => sameMeasurements(current, next) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const element of mechanicLabelRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [mechanicLaneMode, orientation, scene.mechanics]);

  function visibleCenterTime() {
    const axisScroll = orientation === "horizontal" ? scrollOffset.left : scrollOffset.top;
    const viewportLength = orientation === "horizontal" ? viewport.width : viewport.height;
    const stickySize = orientation === "horizontal" ? LABEL : HEADER;
    const visibleStart = Math.max(0, axisScroll);
    const visibleEnd = Math.min(durationPx, axisScroll + viewportLength - stickySize);
    return Math.min(durationMs, Math.max(0, (visibleStart + Math.max(visibleStart, visibleEnd)) / 2 / pixelsPerSecond * 1000));
  }

  function beginDrag(kind: DragKind, id: string, atMs: number, event: PointerEvent<HTMLElement>) {
    if (readOnly || event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    canvasRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { kind, id, pointerId: event.pointerId, startAxis: orientation === "horizontal" ? event.clientX : event.clientY, startAtMs: atMs, moved: false };
  }

  function continueDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
    const deltaPixels = currentAxis - drag.startAxis;
    if (!drag.moved && Math.abs(deltaPixels) < 4) return;
    drag.moved = true;
    setDragPreview({ kind: drag.kind, id: drag.id, atMs: timelineTimeFromDrag(drag.startAtMs, deltaPixels, pixelsPerSecond, MAX_TIMELINE_MS) });
  }

  function finishDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.moved) {
      const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
      const atMs = timelineTimeFromDrag(drag.startAtMs, currentAxis - drag.startAxis, pixelsPerSecond, MAX_TIMELINE_MS);
      if (drag.kind === "mechanic") onMoveMechanic?.(drag.id, atMs);
      else if (drag.kind === "assignment") onMoveAssignment?.(drag.id, atMs);
      else if (drag.kind === "phase") onMovePhase?.(drag.id, atMs);
      else onMoveDirective?.(drag.id, atMs);
      suppressedClickRef.current = `${drag.kind}:${drag.id}`;
    } else if (!cancelled) {
      onSelect?.(`${drag.kind}:${drag.id}` as Exclude<TimelineSelectionKey, null>);
    }
    dragRef.current = null;
    setDragPreview(null);
  }

  function handleSelect(key: Exclude<TimelineSelectionKey, null>) {
    if (suppressedClickRef.current === key) {
      suppressedClickRef.current = null;
      return;
    }
    onSelect?.(key);
  }

  function displayedTime(kind: DragKind, id: string, atMs: number) {
    return dragPreview?.kind === kind && dragPreview.id === id ? dragPreview.atMs : atMs;
  }

  function laneLabelStyle(crossStart: number, crossSize = standardCrossSize): CSSProperties {
    return orientation === "horizontal"
      ? { top: HEADER + crossStart, left: scrollOffset.left, height: crossSize }
      : { left: LABEL + crossStart, top: scrollOffset.top, width: crossSize };
  }

  return (
    <div
      ref={canvasRef}
      className={`axis-canvas axis-${orientation} mechanic-lanes-${mechanicLaneMode}`}
      data-mechanic-lane-mode={mechanicLaneMode}
      style={canvasStyle}
      onPointerMove={continueDrag}
      onPointerUp={(event) => finishDrag(event)}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      <div className="axis-corner">{orientation === "horizontal" ? "对象 / 时间" : "时间 / 对象"}</div>
      {laneBoundaryCrossPositions.map((crossPosition, index) => <span className="axis-lane-boundary" key={`${crossPosition}-${index}`} style={orientation === "horizontal" ? { top: HEADER + crossPosition } : { left: LABEL + crossPosition }} />)}
      {ticks.map((atMs) => {
        const axis = timeAxisPosition(atMs, pixelsPerSecond);
        const style = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div className="axis-tick" key={atMs} style={style}><span>{formatTime(atMs)}</span></div>;
      })}
      {scene.phases.map((phase) => {
        const atMs = displayedTime("phase", phase.id, phase.atMs);
        const axis = timeAxisPosition(atMs, pixelsPerSecond);
        const lineStyle = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div key={phase.id}><div className="axis-phase" style={lineStyle} /><button data-timeline-key={`phase:${phase.id}`} className={`axis-event phase-event ${selected === `phase:${phase.id}` ? "selected" : ""}`} style={pointStyle(orientation, atMs, 0, pixelsPerSecond, -10)} onPointerDown={(event) => beginDrag("phase", phase.id, phase.atMs, event)} onClick={() => handleSelect(`phase:${phase.id}`)} title={`${formatTime(atMs)} · ${phase.name}`}><strong>{phase.name}</strong></button></div>;
      })}
      {scene.directives.map((directive) => {
        const atMs = displayedTime("directive", directive.id, directive.atMs);
        return <button key={directive.id} data-timeline-key={`directive:${directive.id}`} className={`axis-event ${directive.kind === "task" ? "task-event" : "note-event"} ${selected === `directive:${directive.id}` ? "selected" : ""}`} style={pointStyle(orientation, atMs, 0, pixelsPerSecond, 14)} onPointerDown={(event) => beginDrag("directive", directive.id, directive.atMs, event)} onClick={() => handleSelect(`directive:${directive.id}`)} title={`${formatTime(atMs)} · ${directive.text}`}><strong>{directive.text || (directive.kind === "task" ? "空任务" : "空说明")}</strong></button>;
      })}
      <div className="axis-lane-label phase-note-label" style={laneLabelStyle(0)}><span><b>阶段 / 战术</b></span>{!readOnly && <details className="lane-add-menu"><summary aria-label="添加阶段、任务或说明">＋</summary><div><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddPhase?.(visibleCenterTime()); }}>阶段</button><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddDirective?.("task", visibleCenterTime()); }}>任务</button><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddDirective?.("note", visibleCenterTime()); }}>说明</button></div></details>}</div>
      {mechanicLanes.lanes.map((lane, index) => (
        <div className="axis-lane-label mechanic-label" data-mechanic-lane-index={index} key={lane.key} style={laneLabelStyle(mechanicLaneCrossStarts[index], lane.crossSizePx)}><span><b>{lane.label}</b></span>{!readOnly && index === 0 && <button className="axis-lane-add" onClick={() => onAddMechanic?.(visibleCenterTime())} aria-label="添加机制">＋</button>}</div>
      ))}
      {scene.members.map((member, index) => (
        <div className={`axis-lane-label member-lane-label ${readOnly ? "readonly" : ""}`} key={member.id} style={laneLabelStyle(memberLaneStart + index * standardCrossSize)}>
          {readOnly ? <button className="axis-member-main" onClick={() => onSelectMember?.(member.id)}><i style={{ background: member.color }} /><span><b>{member.name}</b><small>{member.classSlug ? WOW_CLASS_LABELS[member.classSlug] ?? member.classSlug : "待选择职业"} · {specializationLabel(member.classSlug ?? "", member.specSlug ?? "")}</small></span></button> : <>
            <button className="axis-member-main" onClick={() => onSelectMember?.(member.id)} title={`编辑成员：${member.name}`}><i style={{ background: member.color }} /><span><b>{member.name}</b><small>{member.classSlug ? WOW_CLASS_LABELS[member.classSlug] ?? member.classSlug : "待选择职业"} · {specializationLabel(member.classSlug ?? "", member.specSlug ?? "")}</small></span></button>
            <button className="axis-member-skill" onClick={() => onOpenMemberSkills?.(member.id, visibleCenterTime())} title={`为 ${member.name} 安排技能`} aria-label={`为 ${member.name} 安排技能`}>＋</button>
          </>}
        </div>
      ))}
      {!readOnly && <div className="axis-lane-label add-member-label" style={laneLabelStyle(memberLaneStart + scene.members.length * standardCrossSize)}><button onClick={onAddMember}>＋ 添加成员</button></div>}
      {displayedMechanics.map((mechanic) => {
        const laneIndex = mechanicLanes.laneByMechanicId.get(mechanic.id) ?? 0;
        const lane = mechanicLanes.lanes[laneIndex];
        const crossStart = mechanicLaneCrossStarts[laneIndex];
        const presentation = mechanicLanes.presentationByMechanicId.get(mechanic.id)!;
        const layoutByIndex = new Map(presentation.parts.map((part) => [part.index, part]));
        const selectedClass = selected === `mechanic:${mechanic.id}` ? "selected" : "";
        const colorStyle = { "--mechanic-color": mechanic.color } as CSSProperties;
        return <div className="mechanic-object" key={mechanic.id} data-mechanic-lane={laneIndex}>
          {mechanic.presentationParts.map((part, partOrder) => {
            const partLayout = layoutByIndex.get(part.index)!;
            const partTooltip = mechanicPartTiming(part);
            const partStyle = part.kind === "interval"
              ? mechanicIntervalStyle(orientation, part, crossStart, lane.crossSizePx, mechanicLaneMode, pixelsPerSecond)
              : mechanicMarkerStyle(orientation, part, crossStart, lane.crossSizePx, mechanicLaneMode, pixelsPerSecond);
            const labelCrossOffset = mechanicLabelRowCrossOffset(lane, partLayout.labelRow);
            const truncated = orientation === "horizontal" && partLayout.labelMaxAxisSizePx < partLayout.labelAxisSizePx - 0.5;
            const key = mechanicPresentationPartKey(mechanic.id, part.index);
            return <span className="mechanic-part-group" key={key}>
              {mechanicLaneMode === "compact" && <button
                ref={(element) => { if (element) mechanicLabelRefs.current.set(key, element); else mechanicLabelRefs.current.delete(key); }}
                type="button"
                tabIndex={partOrder === 0 ? 0 : -1}
                aria-label={partTooltip}
                data-timeline-key={`mechanic:${mechanic.id}`}
                data-mechanic-stage-text={part.text}
                data-mechanic-label-row={partLayout.labelRow}
                data-mechanic-label-truncated={truncated || undefined}
                className={`mechanic-stage-label ${selectedClass}`}
                style={{ ...mechanicStageLabelStyle(orientation, partLayout.labelStartPx, crossStart, labelCrossOffset), ...(truncated ? { maxWidth: partLayout.labelMaxAxisSizePx } : {}), ...colorStyle }}
                onPointerDown={(event) => beginDrag("mechanic", mechanic.id, mechanic.atMs, event)}
                onClick={() => handleSelect(`mechanic:${mechanic.id}`)}
                title={partTooltip}
              >{part.text}</button>}
              <button
                type="button"
                tabIndex={mechanicLaneMode === "by-type" && partOrder === 0 ? 0 : -1}
                aria-label={partTooltip}
                data-timeline-key={`mechanic:${mechanic.id}`}
                data-mechanic-part-kind={part.kind}
                data-mechanic-part-tone={part.tone}
                className={`mechanic-part mechanic-${part.kind} tone-${part.tone} ${selectedClass}`}
                style={{ ...partStyle, ...colorStyle }}
                onPointerDown={(event) => beginDrag("mechanic", mechanic.id, mechanic.atMs, event)}
                onClick={() => handleSelect(`mechanic:${mechanic.id}`)}
                title={partTooltip}
              />
            </span>;
          })}
        </div>;
      })}
      {scene.assignments.map((assignment) => {
        const memberIndex = scene.members.findIndex((item) => item.id === assignment.memberId);
        if (memberIndex < 0) return null;
        const crossStart = memberLaneStart + memberIndex * standardCrossSize;
        const atMs = displayedTime("assignment", assignment.id, assignment.atMs);
        return <div key={assignment.id}>{assignment.castTimeMs > 0 && (assignment.castType === "cast" || assignment.castType === "channel") && <span className="axis-segment cast-segment" style={lengthStyle(orientation, atMs, assignment.castTimeMs, crossStart, pixelsPerSecond)} />}{assignment.durationMs > 0 && <span className="axis-segment effect-segment" style={{ ...lengthStyle(orientation, assignment.effectStartMs, assignment.durationMs, crossStart, pixelsPerSecond), background: assignment.color }} />}<button data-timeline-key={`assignment:${assignment.id}`} className={`axis-event assignment-event ${selected === `assignment:${assignment.id}` ? "selected" : ""} ${warningIds.has(assignment.id) ? "warning" : ""}`} style={{ ...pointStyle(orientation, atMs, crossStart, pixelsPerSecond), borderColor: assignment.color }} onPointerDown={(event) => beginDrag("assignment", assignment.id, assignment.atMs, event)} onClick={() => handleSelect(`assignment:${assignment.id}`)} title={`${formatTime(atMs)} 开始 · ${assignment.name}`}><i style={{ background: assignment.color }} /><strong>{assignment.name}</strong>{warningIds.has(assignment.id) && <b>!</b>}</button></div>;
      })}
    </div>
  );
}
