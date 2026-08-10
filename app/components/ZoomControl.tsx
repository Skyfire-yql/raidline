"use client";

import { clampZoom, MAX_ZOOM, MIN_ZOOM } from "@/lib/view";

export function ZoomControl({ zoom, onChange }: { zoom: number; onChange: (zoom: number) => void }) {
  return <div className="zoom-control">
    <button aria-label="缩小时间轴" title="缩小时间轴" disabled={zoom <= MIN_ZOOM} onClick={() => onChange(clampZoom(zoom - 0.1))}>−</button>
    <label>缩放<input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.1" value={zoom} onChange={(event) => onChange(clampZoom(Number(event.target.value)))} /></label>
    <button aria-label="放大时间轴" title="放大时间轴" disabled={zoom >= MAX_ZOOM} onClick={() => onChange(clampZoom(zoom + 0.1))}>＋</button>
  </div>;
}
