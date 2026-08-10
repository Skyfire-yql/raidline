"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim is not client-runtime compatible here. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { detectConflicts, exportMrtNote, formatTime } from "@/lib/core";
import { specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import type { ApiError, PublicPublication, RaidPlanDocument } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView, type TimelineSelectionKey } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { createLocalPlan } from "./local-store";

type SharedSelection = { type: "member" | "mechanic" | "assignment" | "phase" | "note"; id: string } | null;

function ReadonlyDetails({ plan, selection }: { plan: RaidPlanDocument; selection: SharedSelection }) {
  if (!selection) return <div className="context-empty"><strong>查看时间轴对象</strong><p>点击右侧的成员、机制、阶段、注释或技能分配，在这里查看完整信息。</p></div>;
  const member = selection.type === "member" ? plan.roster.find((item) => item.id === selection.id) : undefined;
  const mechanic = selection.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : undefined;
  const phase = selection.type === "phase" ? plan.phases.find((item) => item.id === selection.id) : undefined;
  const note = selection.type === "note" ? plan.timelineNotes.find((item) => item.id === selection.id) : undefined;
  const assignment = selection.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : undefined;

  if (member) {
    const group = plan.groups.find((item) => item.id === member.groupId);
    return <div className="inspector readonly-inspector"><header><h2>{member.name}</h2><span>成员</span></header><ReadonlyField label="职业" value={WOW_CLASS_LABELS[member.classSlug] ?? "未设置"} /><ReadonlyField label="专精" value={specializationLabel(member.classSlug, member.specSlug) || "未设置"} /><ReadonlyField label="职责" value={{ tank: "坦克", healer: "治疗", damage: "输出" }[member.role]} /><ReadonlyField label="分组" value={group?.name ?? "未分组"} /></div>;
  }
  if (phase) return <div className="inspector readonly-inspector"><header><h2>{phase.name}</h2><span>阶段</span></header><ReadonlyField label="时间" value={formatTime(phase.atMs)} /></div>;
  if (note) return <div className="inspector readonly-inspector"><header><h2>时间轴注释</h2><span>注释</span></header><ReadonlyField label="时间" value={formatTime(note.atMs)} /><ReadonlyField label="内容" value={note.text || "空注释"} multiline /></div>;
  if (mechanic) return <div className="inspector readonly-inspector"><header><h2>{mechanic.name}</h2><span>机制</span></header><ReadonlyField label="时间" value={formatTime(mechanic.atMs)} /><ReadonlyField label="说明" value={mechanic.description || "暂无说明"} multiline /><div className="field-grid"><ReadonlyField label="施法" value={mechanic.castTimeMs == null ? "未配置" : formatTime(mechanic.castTimeMs)} /><ReadonlyField label="持续" value={mechanic.durationMs == null ? "未配置" : formatTime(mechanic.durationMs)} /></div>{mechanic.note && <ReadonlyField label="备注" value={mechanic.note} multiline />}</div>;
  if (assignment) {
    const memberName = plan.roster.find((item) => item.id === assignment.memberId)?.name ?? "未知成员";
    const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId);
    const linkedMechanic = plan.mechanics.find((item) => item.id === assignment.mechanicId);
    return <div className="inspector readonly-inspector"><header><h2>{cooldown?.name ?? "未知技能"}</h2><span>技能分配</span></header><ReadonlyField label="成员" value={memberName} /><ReadonlyField label="开始时间" value={formatTime(assignment.atMs)} />{linkedMechanic && <ReadonlyField label="关联机制" value={linkedMechanic.name} />}{assignment.note && <ReadonlyField label="备注" value={assignment.note} multiline />}</div>;
  }
  return <div className="context-empty"><strong>对象已不存在</strong><p>它可能已从发布版本中移除。</p></div>;
}

function ReadonlyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return <label className={multiline ? "readonly-multiline" : ""}>{label}<span className="readonly-field">{value}</span></label>;
}

export function SharedPlanClient({ shareId }: { shareId: string }) {
  const router = useRouter();
  const [stored, setStored] = useState<PublicPublication | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [zoom, setZoom] = useState(1);
  const [timelineScroll, setTimelineScroll] = useState({ left: 0, top: 0 });
  const [selection, setSelection] = useState<SharedSelection>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [viewWidth, setViewWidth] = useState(1024);
  const [viewReady, setViewReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/publications/${shareId}`).then(async (response) => {
      const payload = await response.json() as { data?: PublicPublication; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败");
      if (!cancelled) setStored(payload.data);
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "读取计划失败"); });
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("shared", shareId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number; leftCollapsed?: boolean } | null;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(Math.max(1, view?.zoom ?? 1)); setLeftCollapsed(view?.leftCollapsed ?? innerWidth < 720);
      } catch { setViewWidth(innerWidth); setOrientation(defaultOrientation(innerWidth)); setLeftCollapsed(innerWidth < 720); }
      setViewReady(true);
    });
    return () => { cancelled = true; };
  }, [shareId]);

  useEffect(() => {
    if (viewReady) localStorage.setItem(viewPreferenceKey("shared", shareId, viewWidth), JSON.stringify({ orientation, zoom, leftCollapsed }));
  }, [leftCollapsed, orientation, shareId, viewReady, viewWidth, zoom]);

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
  const timelineSelection: TimelineSelectionKey = selection && selection.type !== "member" ? `${selection.type}:${selection.id}` : null;

  if (error) return <main className="state-page"><div className="state-card"><h1>分享链接不可用</h1><p>{error}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !stored) return <main className="state-page"><p>正在读取只读排轴…</p></main>;

  return <main className="shared-workspace">
    <header className="editor-utility-header shared-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="shared-plan-name"><strong>{plan.encounter.name}</strong><span className="readonly-state">只读</span></div><div className="header-actions"><button onClick={async () => { const local = await createLocalPlan(plan); router.push(`/plans/${local.id}`); }}>复制到我的轴</button><button onClick={async () => { await navigator.clipboard.writeText(exportMrtNote(plan)); setToast("MRT 文本已复制"); }}>MRT</button><ThemeControl compact /></div></header>
    <div className={`editor-table-grid shared-table-grid ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`left-table-panel context-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <ReadonlyDetails plan={plan} selection={selection} />}</aside>
      <section className="timeline-work-panel">
        <div className="axis-toolbar"><strong>时间轴</strong><div><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div>
        <div className="axis-scroll" ref={scrollRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView plan={plan} orientation={orientation} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} readOnly onSelect={(key) => { if (!key) return; const [type, id] = key.split(":"); setSelection({ type: type as Exclude<SharedSelection, null>["type"], id }); setLeftCollapsed(false); }} onSelectMember={(id) => { setSelection({ type: "member", id }); setLeftCollapsed(false); }} /></div>
        <div className="axis-statusbar"><span>点击对象查看详情 · Ctrl + 滚轮缩放</span><button className={warnings.length ? "warn" : "ok"} onClick={() => { const warning = warnings[0]; if (warning?.assignmentId) setSelection({ type: "assignment", id: warning.assignmentId }); else if (warning?.mechanicId) setSelection({ type: "mechanic", id: warning.mechanicId }); setLeftCollapsed(false); }}>{warnings.length ? `${warnings.length} 项提醒` : "检查通过"}</button></div>
      </section>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </main>;
}
