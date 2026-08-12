"use client";

import type { MechanicTimelinePoint, MechanicTimelinePresentation } from "@/lib/types";

const POINTS: Array<{ value: MechanicTimelinePoint; label: string }> = [
  { value: "cast-start", label: "开始" },
  { value: "impact", label: "判定" },
  { value: "end", label: "结束" },
];
const POINT_ORDER: Record<MechanicTimelinePoint, number> = { "cast-start": 0, impact: 1, end: 2 };
const INTERVAL_TONES = [
  { value: "context", label: "背景 / 无效果" },
  { value: "warning", label: "读条 / 预警" },
  { value: "active", label: "效果持续" },
] as const;
const MARKER_TONES = [
  { value: "point", label: "普通时点" },
  { value: "judgment", label: "机制判定" },
] as const;

interface MechanicPresentationEditorProps {
  value: MechanicTimelinePresentation;
  onChange: (value: MechanicTimelinePresentation) => void;
}

function intervalKey(from: MechanicTimelinePoint, to: MechanicTimelinePoint) {
  return `${from}:${to}`;
}

export function MechanicPresentationEditor({ value, onChange }: MechanicPresentationEditorProps) {
  function update(mutator: (next: MechanicTimelinePresentation) => void) {
    const next = structuredClone(value);
    mutator(next);
    onChange(next);
  }

  function addInterval() {
    const used = new Set(value.parts.filter((part) => part.kind === "interval").map((part) => intervalKey(part.from, part.to)));
    const pair = POINTS.flatMap((from) => POINTS.map((to) => [from.value, to.value] as const))
      .find(([from, to]) => POINT_ORDER[from] < POINT_ORDER[to] && !used.has(intervalKey(from, to)));
    if (!pair) return;
    update((next) => { next.parts.push({ kind: "interval", from: pair[0], to: pair[1], tone: "warning", text: "新阶段" }); });
  }

  function addMarker() {
    const used = new Set(value.parts.filter((part) => part.kind === "marker").map((part) => part.at));
    const at = POINTS.find((point) => !used.has(point.value))?.value;
    if (!at) return;
    update((next) => { next.parts.push({ kind: "marker", at, tone: "judgment", text: "新判定" }); });
  }

  const intervalCount = value.parts.filter((part) => part.kind === "interval").length;
  const markerCount = value.parts.filter((part) => part.kind === "marker").length;

  return <fieldset className="mechanic-presentation-editor">
    <legend>时间轴阶段展示</legend>
    <p>一个 Boss 机制可以包含多个持续阶段和判定点；列表顺序用于相同时点的稳定展示。</p>
    {value.parts.map((part, index) => {
      const otherIntervals = new Set(value.parts.flatMap((candidate, candidateIndex) => candidateIndex !== index && candidate.kind === "interval" ? [intervalKey(candidate.from, candidate.to)] : []));
      const otherMarkers = new Set(value.parts.flatMap((candidate, candidateIndex) => candidateIndex !== index && candidate.kind === "marker" ? [candidate.at] : []));
      return <article className="mechanic-presentation-part" key={`${part.kind}-${index}`}>
        <header><b>{part.kind === "interval" ? "区间" : "时点"}</b><span><button type="button" disabled={index === 0} onClick={() => update((next) => { [next.parts[index - 1], next.parts[index]] = [next.parts[index], next.parts[index - 1]]; })} aria-label="上移">↑</button><button type="button" disabled={index === value.parts.length - 1} onClick={() => update((next) => { [next.parts[index], next.parts[index + 1]] = [next.parts[index + 1], next.parts[index]]; })} aria-label="下移">↓</button><button type="button" className="danger-link" disabled={value.parts.length === 1} onClick={() => update((next) => { next.parts.splice(index, 1); })}>删除</button></span></header>
        <label>阶段说明<input value={part.text} onChange={(event) => update((next) => { next.parts[index].text = event.target.value; })} /></label>
        {part.kind === "interval" ? <div className="field-grid">
          <label>起点<select value={part.from} onChange={(event) => update((next) => { const candidate = next.parts[index]; if (candidate.kind === "interval") candidate.from = event.target.value as MechanicTimelinePoint; })}>{POINTS.map((point) => <option key={point.value} value={point.value} disabled={POINT_ORDER[point.value] >= POINT_ORDER[part.to] || otherIntervals.has(intervalKey(point.value, part.to))}>{point.label}</option>)}</select></label>
          <label>终点<select value={part.to} onChange={(event) => update((next) => { const candidate = next.parts[index]; if (candidate.kind === "interval") candidate.to = event.target.value as MechanicTimelinePoint; })}>{POINTS.map((point) => <option key={point.value} value={point.value} disabled={POINT_ORDER[part.from] >= POINT_ORDER[point.value] || otherIntervals.has(intervalKey(part.from, point.value))}>{point.label}</option>)}</select></label>
          <label>视觉语义<select value={part.tone} onChange={(event) => update((next) => { const candidate = next.parts[index]; if (candidate.kind === "interval") candidate.tone = event.target.value as typeof part.tone; })}>{INTERVAL_TONES.map((tone) => <option key={tone.value} value={tone.value}>{tone.label}</option>)}</select></label>
        </div> : <div className="field-grid">
          <label>时点<select value={part.at} onChange={(event) => update((next) => { const candidate = next.parts[index]; if (candidate.kind === "marker") candidate.at = event.target.value as MechanicTimelinePoint; })}>{POINTS.map((point) => <option key={point.value} value={point.value} disabled={otherMarkers.has(point.value)}>{point.label}</option>)}</select></label>
          <label>视觉语义<select value={part.tone} onChange={(event) => update((next) => { const candidate = next.parts[index]; if (candidate.kind === "marker") candidate.tone = event.target.value as typeof part.tone; })}>{MARKER_TONES.map((tone) => <option key={tone.value} value={tone.value}>{tone.label}</option>)}</select></label>
        </div>}
      </article>;
    })}
    <footer><button type="button" disabled={value.parts.length >= 8 || intervalCount >= 3} onClick={addInterval}>＋ 区间</button><button type="button" disabled={value.parts.length >= 8 || markerCount >= 3} onClick={addMarker}>＋ 判定点</button><small>{value.parts.length} / 8</small></footer>
  </fieldset>;
}
