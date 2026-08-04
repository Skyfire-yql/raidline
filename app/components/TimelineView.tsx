"use client";

import { useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { formatTime } from "@/lib/core";
import { specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import type { RaidPlanDocument } from "@/lib/types";
import { timeAxisPosition, timelineTimeFromDrag, type TimelineOrientation } from "@/lib/view";

type SelectionKey = `mechanic:${string}` | `assignment:${string}` | null;
type DragKind = "mechanic" | "assignment";

interface TimelineViewProps {
  plan: RaidPlanDocument;
  orientation: TimelineOrientation;
  zoom: number;
  selected?: SelectionKey;
  warningIds?: Set<string>;
  readOnly?: boolean;
  scrollOffset?: { left: number; top: number };
  onSelect?: (key: SelectionKey) => void;
  onSelectMember?: (id: string) => void;
  onOpenMemberSkills?: (id: string) => void;
  onAddMechanic?: (atMs: number) => void;
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

const LABEL = 132;
const HEADER = 52;
const LANE = 62;
const COLUMN = 150;

function lengthStyle(orientation: TimelineOrientation, start: number, length: number, lane: number, pixelsPerSecond: number): CSSProperties {
  const startPx = timeAxisPosition(start, pixelsPerSecond);
  const lengthPx = Math.max(2, timeAxisPosition(length, pixelsPerSecond));
  return orientation === "horizontal"
    ? { left: LABEL + startPx, top: HEADER + lane * LANE + 15, width: lengthPx }
    : { top: HEADER + startPx, left: LABEL + lane * COLUMN + 18, height: lengthPx };
}

function pointStyle(orientation: TimelineOrientation, atMs: number, lane: number, pixelsPerSecond: number): CSSProperties {
  const axis = timeAxisPosition(atMs, pixelsPerSecond);
  return orientation === "horizontal"
    ? { left: LABEL + axis, top: HEADER + lane * LANE + 24 }
    : { top: HEADER + axis, left: LABEL + lane * COLUMN + 27 };
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
  onAddMechanic,
  onMoveMechanic,
  onMoveAssignment,
}: TimelineViewProps) {
  const pixelsPerSecond = 5 * zoom;
  const durationPx = timeAxisPosition(plan.encounter.durationMs, pixelsPerSecond);
  const laneCount = plan.roster.length + 1;
  const canvasStyle: CSSProperties = orientation === "horizontal"
    ? { width: Math.max(920, LABEL + durationPx + 100), height: Math.max(360, HEADER + laneCount * LANE) }
    : { width: Math.max(760, LABEL + laneCount * COLUMN), height: Math.max(620, HEADER + durationPx + 100) };
  const ticks = Array.from({ length: Math.floor(plan.encounter.durationMs / 30_000) + 1 }, (_, index) => index * 30_000);
  const dragRef = useRef<ActiveDrag | null>(null);
  const suppressedClickRef = useRef<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ kind: DragKind; id: string; atMs: number } | null>(null);

  function timeFromPointer(event: MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = orientation === "horizontal" ? event.clientX - rect.left - LABEL : event.clientY - rect.top - HEADER;
    return Math.max(0, Math.min(plan.encounter.durationMs, offset / pixelsPerSecond * 1000));
  }

  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (readOnly || (event.target as HTMLElement).closest("button")) return;
    onAddMechanic?.(timeFromPointer(event));
  }

  function beginDrag(kind: DragKind, id: string, atMs: number, event: PointerEvent<HTMLButtonElement>) {
    if (readOnly || event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      id,
      pointerId: event.pointerId,
      startAxis: orientation === "horizontal" ? event.clientX : event.clientY,
      startAtMs: atMs,
      moved: false,
    };
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
    const deltaPixels = currentAxis - drag.startAxis;
    if (!drag.moved && Math.abs(deltaPixels) < 4) return;
    drag.moved = true;
    const atMs = timelineTimeFromDrag(drag.startAtMs, deltaPixels, pixelsPerSecond, plan.encounter.durationMs, plan.settings.snapMs);
    setDragPreview({ kind: drag.kind, id: drag.id, atMs });
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.moved) {
      const currentAxis = orientation === "horizontal" ? event.clientX : event.clientY;
      const atMs = timelineTimeFromDrag(drag.startAtMs, currentAxis - drag.startAxis, pixelsPerSecond, plan.encounter.durationMs, plan.settings.snapMs);
      if (drag.kind === "mechanic") onMoveMechanic?.(drag.id, atMs);
      else onMoveAssignment?.(drag.id, atMs);
      suppressedClickRef.current = `${drag.kind}:${drag.id}`;
    }
    dragRef.current = null;
    setDragPreview(null);
  }

  function handleSelect(key: Exclude<SelectionKey, null>) {
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
    <div className={`axis-canvas axis-${orientation}`} style={canvasStyle} onDoubleClick={handleDoubleClick}>
      <div className="axis-corner">{orientation === "horizontal" ? "成员 / 时间" : "时间 / 成员"}</div>
      {ticks.map((atMs) => {
        const axis = timeAxisPosition(atMs, pixelsPerSecond);
        const style = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div className="axis-tick" key={atMs} style={style}><span>{formatTime(atMs)}</span></div>;
      })}
      {plan.phases.map((phase) => {
        const axis = timeAxisPosition(phase.atMs, pixelsPerSecond);
        const style = orientation === "horizontal" ? { left: LABEL + axis } : { top: HEADER + axis };
        return <div className="axis-phase" key={phase.id} style={style}><span>{phase.name}</span></div>;
      })}
      <div className="axis-lane-label mechanic-label" style={laneLabelStyle(0)}>BOSS 机制</div>
      {plan.roster.map((member, index) => (
        <div className={`axis-lane-label member-lane-label ${readOnly ? "readonly" : ""}`} key={member.id} style={laneLabelStyle(index + 1)}>
          {readOnly ? <><i style={{ background: member.color }} /><span><b>{member.name}</b><small>{WOW_CLASS_LABELS[member.classSlug] ?? "待选择职业"} · {specializationLabel(member.classSlug, member.specSlug)}</small></span></> : <>
            <button className="axis-member-main" onClick={() => onSelectMember?.(member.id)} title={`编辑成员：${member.name}`}>
              <i style={{ background: member.color }} /><span><b>{member.name}</b><small>{WOW_CLASS_LABELS[member.classSlug] ?? "待选择职业"} · {specializationLabel(member.classSlug, member.specSlug)}</small></span>
            </button>
            <button className="axis-member-skill" onClick={() => onOpenMemberSkills?.(member.id)} title={`为 ${member.name} 安排技能`} aria-label={`为 ${member.name} 安排技能`}>＋</button>
          </>}
        </div>
      ))}
      {plan.mechanics.map((mechanic) => {
        const atMs = displayedTime("mechanic", mechanic.id, mechanic.atMs);
        return <button
          key={mechanic.id}
          className={`axis-event mechanic-event ${selected === `mechanic:${mechanic.id}` ? "selected" : ""}`}
          style={pointStyle(orientation, atMs, 0, pixelsPerSecond)}
          onPointerDown={(event) => beginDrag("mechanic", mechanic.id, mechanic.atMs, event)}
          onPointerMove={continueDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onClick={() => handleSelect(`mechanic:${mechanic.id}`)}
          title={`${formatTime(atMs)} · ${mechanic.name}${mechanic.description ? `\n${mechanic.description}` : "\n暂无说明"}`}
        ><strong>{mechanic.name}</strong></button>;
      })}
      {plan.assignments.map((assignment) => {
        const memberIndex = plan.roster.findIndex((item) => item.id === assignment.memberId);
        const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId);
        if (memberIndex < 0 || !cooldown) return null;
        const lane = memberIndex + 1;
        const atMs = displayedTime("assignment", assignment.id, assignment.atMs);
        const cast = cooldown.castTimeMs;
        const duration = cooldown.durationMs;
        const effectAt = atMs + (cast ?? 0);
        return <div key={assignment.id}>
          {cast != null && cast > 0 && <span className="axis-segment cast-segment" style={lengthStyle(orientation, atMs, cast, lane, pixelsPerSecond)} />}
          {duration != null && duration > 0 && <span className="axis-segment effect-segment" style={{ ...lengthStyle(orientation, effectAt, duration, lane, pixelsPerSecond), background: cooldown.color }} />}
          <button
            className={`axis-event assignment-event ${selected === `assignment:${assignment.id}` ? "selected" : ""} ${warningIds.has(assignment.id) ? "warning" : ""}`}
            style={{ ...pointStyle(orientation, atMs, lane, pixelsPerSecond), borderColor: cooldown.color }}
            onPointerDown={(event) => beginDrag("assignment", assignment.id, assignment.atMs, event)}
            onPointerMove={continueDrag}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
            onClick={() => handleSelect(`assignment:${assignment.id}`)}
            title={`${formatTime(atMs)} 开始 · ${cooldown.name}`}
          ><i style={{ background: cooldown.color }} /><strong>{cooldown.name}</strong>{warningIds.has(assignment.id) && <b>!</b>}</button>
        </div>;
      })}
      {!plan.roster.length && !readOnly && <div className="axis-empty">先添加成员，再安排技能。双击空白处可添加机制。</div>}
    </div>
  );
}
