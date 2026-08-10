"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { formatTime, MAX_TIMELINE_MS } from "@/lib/core";
import { specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import type { RaidPlanDocument } from "@/lib/types";
import { adaptiveTickMs, timeAxisPosition, timelineRangeMs, timelineTimeFromDrag, type TimelineOrientation } from "@/lib/view";

export type TimelineSelectionKey = `mechanic:${string}` | `assignment:${string}` | `phase:${string}` | `note:${string}` | null;
type DragKind = "mechanic" | "assignment" | "phase" | "note";

interface TimelineViewProps {
  plan: RaidPlanDocument;
  orientation: TimelineOrientation;
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
  onAddTimelineNote?: (atMs: number) => void;
  onAddMechanic?: (atMs: number) => void;
  onMovePhase?: (id: string, atMs: number) => void;
  onMoveTimelineNote?: (id: string, atMs: number) => void;
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

function lengthStyle(orientation: TimelineOrientation, start: number, length: number, lane: number, pixelsPerSecond: number): CSSProperties {
  const startPx = timeAxisPosition(start, pixelsPerSecond);
  const lengthPx = Math.max(2, timeAxisPosition(length, pixelsPerSecond));
  return orientation === "horizontal"
    ? { left: LABEL + startPx, top: HEADER + lane * LANE + 15, width: lengthPx }
    : { top: HEADER + startPx, left: LABEL + lane * COLUMN + 18, height: lengthPx };
}

function pointStyle(orientation: TimelineOrientation, atMs: number, lane: number, pixelsPerSecond: number, crossOffset = 0): CSSProperties {
  const axis = timeAxisPosition(atMs, pixelsPerSecond);
  return orientation === "horizontal"
    ? { left: LABEL + axis, top: HEADER + lane * LANE + 24 + crossOffset }
    : { top: HEADER + axis, left: LABEL + lane * COLUMN + 27 + crossOffset };
}

export function TimelineView({
  plan,
  orientation,
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
  onAddTimelineNote,
  onAddMechanic,
  onMovePhase,
  onMoveTimelineNote,
  onMoveMechanic,
  onMoveAssignment,
}: TimelineViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 920, height: 620 });
  const durationMs = timelineRangeMs(plan);
  const timeViewport = orientation === "horizontal"
    ? Math.max(320, viewport.width - LABEL - END_GUTTER_HORIZONTAL)
    : Math.max(320, viewport.height - HEADER - END_GUTTER_VERTICAL);
  const fitPixelsPerSecond = timeViewport / Math.max(1, durationMs / 1000);
  const pixelsPerSecond = fitPixelsPerSecond * Math.max(1, zoom);
  const durationPx = timeAxisPosition(durationMs, pixelsPerSecond);
  const laneCount = plan.roster.length + 2 + (readOnly ? 0 : 1);
  const canvasStyle: CSSProperties = orientation === "horizontal"
    ? { width: Math.max(viewport.width, LABEL + durationPx), height: Math.max(viewport.height, HEADER + laneCount * LANE) }
    : { width: Math.max(viewport.width, LABEL + laneCount * COLUMN), height: Math.max(viewport.height, HEADER + durationPx) };
  const tickMs = adaptiveTickMs(pixelsPerSecond);
  const ticks = Array.from({ length: Math.floor(durationMs / tickMs) + 1 }, (_, index) => index * tickMs);
  if (ticks.at(-1) !== durationMs) ticks.push(durationMs);
  const dragRef = useRef<ActiveDrag | null>(null);
  const suppressedClickRef = useRef<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ kind: DragKind; id: string; atMs: number } | null>(null);

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

  function visibleCenterTime() {
    const axisScroll = orientation === "horizontal" ? scrollOffset.left : scrollOffset.top;
    const viewportLength = orientation === "horizontal" ? viewport.width : viewport.height;
    const stickySize = orientation === "horizontal" ? LABEL : HEADER;
    const visibleStart = Math.max(0, axisScroll);
    const visibleEnd = Math.min(durationPx, axisScroll + viewportLength - stickySize);
    return Math.min(durationMs, Math.max(0, (visibleStart + Math.max(visibleStart, visibleEnd)) / 2 / pixelsPerSecond * 1000));
  }

  function beginDrag(kind: DragKind, id: string, atMs: number, event: PointerEvent<HTMLButtonElement>) {
    if (readOnly || event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind, id, pointerId: event.pointerId, startAxis: orientation === "horizontal" ? event.clientX : event.clientY, startAtMs: atMs, moved: false };
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
    const deltaPixels = currentAxis - drag.startAxis;
    if (!drag.moved && Math.abs(deltaPixels) < 4) return;
    drag.moved = true;
    setDragPreview({ kind: drag.kind, id: drag.id, atMs: timelineTimeFromDrag(drag.startAtMs, deltaPixels, pixelsPerSecond, MAX_TIMELINE_MS) });
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.moved) {
      const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
      const atMs = timelineTimeFromDrag(drag.startAtMs, currentAxis - drag.startAxis, pixelsPerSecond, MAX_TIMELINE_MS);
      if (drag.kind === "mechanic") onMoveMechanic?.(drag.id, atMs);
      else if (drag.kind === "assignment") onMoveAssignment?.(drag.id, atMs);
      else if (drag.kind === "phase") onMovePhase?.(drag.id, atMs);
      else onMoveTimelineNote?.(drag.id, atMs);
      suppressedClickRef.current = `${drag.kind}:${drag.id}`;
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

  function laneLabelStyle(index: number): CSSProperties {
    return orientation === "horizontal"
      ? { top: HEADER + index * LANE, left: scrollOffset.left }
      : { left: LABEL + index * COLUMN, top: scrollOffset.top };
  }

  return (
    <div ref={canvasRef} className={`axis-canvas axis-${orientation}`} style={canvasStyle}>
      <div className="axis-corner">{orientation === "horizontal" ? "对象 / 时间" : "时间 / 对象"}</div>
      {ticks.map((atMs) => {
        const axis = timeAxisPosition(atMs, pixelsPerSecond);
        const style = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div className="axis-tick" key={atMs} style={style}><span>{formatTime(atMs)}</span></div>;
      })}
      {plan.phases.map((phase) => {
        const atMs = displayedTime("phase", phase.id, phase.atMs);
        const axis = timeAxisPosition(atMs, pixelsPerSecond);
        const lineStyle = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div key={phase.id}><div className="axis-phase" style={lineStyle} /><button data-timeline-key={`phase:${phase.id}`} className={`axis-event phase-event ${selected === `phase:${phase.id}` ? "selected" : ""}`} style={pointStyle(orientation, atMs, 0, pixelsPerSecond, -10)} onPointerDown={(event) => beginDrag("phase", phase.id, phase.atMs, event)} onPointerMove={continueDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onClick={() => handleSelect(`phase:${phase.id}`)} title={`${formatTime(atMs)} · ${phase.name}`}><strong>{phase.name}</strong></button></div>;
      })}
      {plan.timelineNotes.map((note) => {
        const atMs = displayedTime("note", note.id, note.atMs);
        return <button key={note.id} data-timeline-key={`note:${note.id}`} className={`axis-event note-event ${selected === `note:${note.id}` ? "selected" : ""}`} style={pointStyle(orientation, atMs, 0, pixelsPerSecond, 14)} onPointerDown={(event) => beginDrag("note", note.id, note.atMs, event)} onPointerMove={continueDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onClick={() => handleSelect(`note:${note.id}`)} title={`${formatTime(atMs)} · ${note.text}`}><strong>{note.text || "空注释"}</strong></button>;
      })}
      <div className="axis-lane-label phase-note-label" style={laneLabelStyle(0)}><span><b>阶段 / 注释</b></span>{!readOnly && <details className="lane-add-menu"><summary aria-label="添加阶段或注释">＋</summary><div><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddPhase?.(visibleCenterTime()); }}>阶段</button><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddTimelineNote?.(visibleCenterTime()); }}>注释</button></div></details>}</div>
      <div className="axis-lane-label mechanic-label" style={laneLabelStyle(1)}><span><b>BOSS 机制</b></span>{!readOnly && <button className="axis-lane-add" onClick={() => onAddMechanic?.(visibleCenterTime())} aria-label="添加机制">＋</button>}</div>
      {plan.roster.map((member, index) => (
        <div className={`axis-lane-label member-lane-label ${readOnly ? "readonly" : ""}`} key={member.id} style={laneLabelStyle(index + 2)}>
          {readOnly ? <button className="axis-member-main" onClick={() => onSelectMember?.(member.id)}><i style={{ background: member.color }} /><span><b>{member.name}</b><small>{WOW_CLASS_LABELS[member.classSlug] ?? "待选择职业"} · {specializationLabel(member.classSlug, member.specSlug)}</small></span></button> : <>
            <button className="axis-member-main" onClick={() => onSelectMember?.(member.id)} title={`编辑成员：${member.name}`}><i style={{ background: member.color }} /><span><b>{member.name}</b><small>{WOW_CLASS_LABELS[member.classSlug] ?? "待选择职业"} · {specializationLabel(member.classSlug, member.specSlug)}</small></span></button>
            <button className="axis-member-skill" onClick={() => onOpenMemberSkills?.(member.id, visibleCenterTime())} title={`为 ${member.name} 安排技能`} aria-label={`为 ${member.name} 安排技能`}>＋</button>
          </>}
        </div>
      ))}
      {!readOnly && <div className="axis-lane-label add-member-label" style={laneLabelStyle(plan.roster.length + 2)}><button onClick={onAddMember}>＋ 添加成员</button></div>}
      {plan.mechanics.map((mechanic) => {
        const atMs = displayedTime("mechanic", mechanic.id, mechanic.atMs);
        return <button key={mechanic.id} data-timeline-key={`mechanic:${mechanic.id}`} className={`axis-event mechanic-event ${selected === `mechanic:${mechanic.id}` ? "selected" : ""}`} style={pointStyle(orientation, atMs, 1, pixelsPerSecond)} onPointerDown={(event) => beginDrag("mechanic", mechanic.id, mechanic.atMs, event)} onPointerMove={continueDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onClick={() => handleSelect(`mechanic:${mechanic.id}`)} title={`${formatTime(atMs)} · ${mechanic.name}${mechanic.description ? `\n${mechanic.description}` : "\n暂无说明"}`}><strong>{mechanic.name}</strong></button>;
      })}
      {plan.assignments.map((assignment) => {
        const memberIndex = plan.roster.findIndex((item) => item.id === assignment.memberId);
        const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId);
        if (memberIndex < 0 || !cooldown) return null;
        const lane = memberIndex + 2;
        const atMs = displayedTime("assignment", assignment.id, assignment.atMs);
        const cast = cooldown.castTimeMs;
        const duration = cooldown.durationMs;
        const effectAt = atMs + (cast ?? 0);
        return <div key={assignment.id}>{cast != null && cast > 0 && <span className="axis-segment cast-segment" style={lengthStyle(orientation, atMs, cast, lane, pixelsPerSecond)} />}{duration != null && duration > 0 && <span className="axis-segment effect-segment" style={{ ...lengthStyle(orientation, effectAt, duration, lane, pixelsPerSecond), background: cooldown.color }} />}<button data-timeline-key={`assignment:${assignment.id}`} className={`axis-event assignment-event ${selected === `assignment:${assignment.id}` ? "selected" : ""} ${warningIds.has(assignment.id) ? "warning" : ""}`} style={{ ...pointStyle(orientation, atMs, lane, pixelsPerSecond), borderColor: cooldown.color }} onPointerDown={(event) => beginDrag("assignment", assignment.id, assignment.atMs, event)} onPointerMove={continueDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onClick={() => handleSelect(`assignment:${assignment.id}`)} title={`${formatTime(atMs)} 开始 · ${cooldown.name}`}><i style={{ background: cooldown.color }} /><strong>{cooldown.name}</strong>{warningIds.has(assignment.id) && <b>!</b>}</button></div>;
      })}
    </div>
  );
}
