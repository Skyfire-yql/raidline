"use client";

import { clampZoom } from "@/lib/view";

export function ZoomControl({ zoom, onChange }: { zoom: number; onChange: (zoom: number) => void }) {
  return <div className="zoom-control">
    <button aria-label="缩小时间轴" title="缩小时间轴" onClick={() => onChange(clampZoom(zoom - 0.1))}>−</button>
    <label>缩放<input type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={(event) => onChange(Number(event.target.value))} /></label>
    <button aria-label="放大时间轴" title="放大时间轴" onClick={() => onChange(clampZoom(zoom + 0.1))}>＋</button>
  </div>;
}
