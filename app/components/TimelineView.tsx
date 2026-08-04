"use client";

import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { formatTime } from "@/lib/core";
import type { RaidPlanDocument } from "@/lib/types";
import { timeAxisPosition, type TimelineOrientation } from "@/lib/view";

type SelectionKey = `mechanic:${string}` | `assignment:${string}` | null;

interface TimelineViewProps {
  plan: RaidPlanDocument;
  orientation: TimelineOrientation;
  zoom: number;
  selected?: SelectionKey;
  warningIds?: Set<string>;
  readOnly?: boolean;
  onSelect?: (key: SelectionKey) => void;
  onAddMechanic?: (atMs: number) => void;
  onMoveAssignment?: (id: string, atMs: number) => void;
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

export function TimelineView({ plan, orientation, zoom, selected = null, warningIds = new Set(), readOnly = false, onSelect, onAddMechanic, onMoveAssignment }: TimelineViewProps) {
  const pixelsPerSecond = 5 * zoom;
  const durationPx = timeAxisPosition(plan.encounter.durationMs, pixelsPerSecond);
  const laneCount = plan.roster.length + 1;
  const canvasStyle: CSSProperties = orientation === "horizontal"
    ? { width: Math.max(920, LABEL + durationPx + 100), height: Math.max(360, HEADER + laneCount * LANE) }
    : { width: Math.max(760, LABEL + laneCount * COLUMN), height: Math.max(620, HEADER + durationPx + 100) };
  const ticks = Array.from({ length: Math.floor(plan.encounter.durationMs / 30_000) + 1 }, (_, index) => index * 30_000);

  function timeFromPointer(event: MouseEvent<HTMLDivElement> | DragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = orientation === "horizontal" ? event.clientX - rect.left - LABEL : event.clientY - rect.top - HEADER;
    return Math.max(0, Math.min(plan.encounter.durationMs, offset / pixelsPerSecond * 1000));
  }

  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (readOnly || (event.target as HTMLElement).closest("button")) return;
    onAddMechanic?.(timeFromPointer(event));
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (readOnly) return;
    event.preventDefault();
    const id = event.dataTransfer.getData("application/x-raidline-assignment");
    if (id) onMoveAssignment?.(id, timeFromPointer(event));
  }

  return (
    <div className={`axis-canvas axis-${orientation}`} style={canvasStyle} onDoubleClick={handleDoubleClick} onDragOver={(event) => { if (!readOnly) event.preventDefault(); }} onDrop={handleDrop}>
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
      <div className="axis-lane-label mechanic-label" style={orientation === "horizontal" ? { top: HEADER } : { left: LABEL }}>BOSS 机制</div>
      {plan.roster.map((member, index) => (
        <div className="axis-lane-label" key={member.id} style={orientation === "horizontal" ? { top: HEADER + (index + 1) * LANE } : { left: LABEL + (index + 1) * COLUMN }}>
          <i style={{ background: member.color }} /><span><b>{member.name}</b><small>{member.specSlug}</small></span>
        </div>
      ))}
      {plan.mechanics.map((mechanic) => {
        return <div key={mechanic.id}>
          <button className={`axis-event mechanic-event ${selected === `mechanic:${mechanic.id}` ? "selected" : ""}`} style={pointStyle(orientation, mechanic.atMs, 0, pixelsPerSecond)} onClick={() => onSelect?.(`mechanic:${mechanic.id}`)} title={`${formatTime(mechanic.atMs)} · ${mechanic.name}${mechanic.description ? ` · ${mechanic.description}` : ""}`}>
            <strong>{mechanic.name}</strong><small>{mechanic.description || "暂无说明"}</small>
          </button>
        </div>;
      })}
      {plan.assignments.map((assignment) => {
        const memberIndex = plan.roster.findIndex((item) => item.id === assignment.memberId);
        const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId);
        if (memberIndex < 0 || !cooldown) return null;
        const lane = memberIndex + 1;
        const cast = cooldown.castTimeMs;
        const duration = cooldown.durationMs;
        const effectAt = assignment.atMs + (cast ?? 0);
        return <div key={assignment.id}>
          {cast != null && cast > 0 && <span className="axis-segment cast-segment" style={lengthStyle(orientation, assignment.atMs, cast, lane, pixelsPerSecond)} />}
          {duration != null && duration > 0 && <span className="axis-segment effect-segment" style={{ ...lengthStyle(orientation, effectAt, duration, lane, pixelsPerSecond), background: cooldown.color }} />}
          <button draggable={!readOnly} className={`axis-event assignment-event ${selected === `assignment:${assignment.id}` ? "selected" : ""} ${warningIds.has(assignment.id) ? "warning" : ""}`} style={{ ...pointStyle(orientation, assignment.atMs, lane, pixelsPerSecond), borderColor: cooldown.color }} onDragStart={(event) => event.dataTransfer.setData("application/x-raidline-assignment", assignment.id)} onClick={() => onSelect?.(`assignment:${assignment.id}`)} title={`${formatTime(assignment.atMs)} 开始 · ${cooldown.name}`}>
            <i style={{ background: cooldown.color }} /><strong>{cooldown.name}</strong>{warningIds.has(assignment.id) && <b>!</b>}
          </button>
        </div>;
      })}
      {!plan.roster.length && !readOnly && <div className="axis-empty">先添加成员，再安排技能。双击空白处可添加机制。</div>}
    </div>
  );
}
