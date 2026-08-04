"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim is not client-runtime compatible here. */

import { useEffect, useMemo, useRef, useState } from "react";
import { detectConflicts, exportMrtNote, formatTime } from "@/lib/core";
import type { ApiError, StoredPlan } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";

export function SharedPlanClient({ shareSlug }: { shareSlug: string }) {
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [zoom, setZoom] = useState(1);
  const [viewWidth, setViewWidth] = useState(1024);
  const [viewReady, setViewReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/shared/${shareSlug}`).then(async (response) => {
      const payload = await response.json() as { data?: StoredPlan; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败");
      if (!cancelled) setStored(payload.data);
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "读取计划失败"); });
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("shared", shareSlug, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number } | null;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(view?.zoom ?? 1);
      } catch { setViewWidth(innerWidth); setOrientation(defaultOrientation(innerWidth)); }
      setViewReady(true);
    });
    return () => { cancelled = true; };
  }, [shareSlug]);

  useEffect(() => {
    if (viewReady) localStorage.setItem(viewPreferenceKey("shared", shareSlug, viewWidth), JSON.stringify({ orientation, zoom }));
  }, [orientation, shareSlug, viewReady, viewWidth, zoom]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const pointerInTimeline = event.target instanceof Node && element.contains(event.target);
      if (!shouldInterceptTimelineWheel(event.ctrlKey, pointerInTimeline)) return;
      event.preventDefault();
      setZoom((current) => {
        const next = zoomFromWheel(current, event.deltaY);
        const rect = element.getBoundingClientRect();
        if (orientation === "horizontal") element.scrollLeft = anchoredScroll(element.scrollLeft, event.clientX - rect.left, current, next);
        else element.scrollTop = anchoredScroll(element.scrollTop, event.clientY - rect.top, current, next);
        return next;
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [orientation]);

  const plan = stored?.document ?? null;
  const warnings = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);

  if (error) return <main className="state-page"><div className="state-card"><h1>分享链接不可用</h1><p>{error}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !stored) return <main className="state-page"><p>正在读取只读排轴…</p></main>;

  return (
    <main className="shared-workspace">
      <header className="utility-header shared-utility-header">
        <a className="utility-brand" href="/"><span>轴</span><strong>团轴 Raidline</strong></a>
        <div><span className="readonly-state">只读</span><button onClick={async () => { await navigator.clipboard.writeText(exportMrtNote(plan)); setToast("MRT 文本已复制"); }}>复制 MRT</button><ThemeControl compact /></div>
      </header>
      <section className="shared-summary">
        <div><h1>{plan.encounter.name}</h1><p>{plan.encounter.difficulty} · {formatTime(plan.encounter.durationMs)} · 更新于 {new Date(stored.updatedAt).toLocaleString("zh-CN")}</p></div>
        <div className="summary-cells"><span><b>{plan.roster.length}</b><small>成员</small></span><span><b>{plan.mechanics.length}</b><small>机制</small></span><span><b>{plan.assignments.length}</b><small>分配</small></span><span className={warnings.length ? "warn" : "ok"}><b>{warnings.length}</b><small>提醒</small></span></div>
      </section>
      <section className="shared-axis-card">
        <div className="axis-toolbar"><strong>战斗时间轴</strong><div><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "转为时间纵向" : "转为时间横向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div>
        <div className="axis-scroll" ref={scrollRef}><TimelineView plan={plan} orientation={orientation} zoom={zoom} readOnly /></div>
      </section>
      <section className="mechanic-list-card">
        <header><h2>机制说明</h2><span>{plan.mechanics.length} 项</span></header>
        <div className="data-table mechanic-table"><div className="table-row table-head"><span>时间</span><span>机制</span><span>说明</span></div>{plan.mechanics.map((mechanic) => <div className="table-row" key={mechanic.id}><span>{formatTime(mechanic.atMs)}</span><span><b>{mechanic.name}</b></span><span>{mechanic.description || "暂无说明"}</span></div>)}</div>
      </section>
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
    </main>
  );
}
