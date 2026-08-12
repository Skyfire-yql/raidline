"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildTimelineScene, detectConflicts, exportPlan, formatTime, resolveDirectiveTime, resolveMechanicPoint, resolveTimelineAnchor } from "@/lib/core";
import { specializationLabel, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import { resolveSkillForMember, skillDataStatusLabel } from "@/lib/skills";
import type { ApiError, MemberSelector, PublicPublication, RaidPlanDocument } from "@/lib/types";
import { anchoredScroll, clampZoom, defaultOrientation, MIN_ZOOM, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type MechanicLaneMode, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { MechanicLaneModeControl, TimelineView, type TimelineSelectionKey } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { createLocalPlan } from "./local-store";

type SharedSelection = { type: "member" | "mechanic" | "assignment" | "phase" | "directive"; id: string } | null;
const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;

function ReadonlyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return <label className={multiline ? "readonly-multiline" : ""}>{label}<span className="readonly-field">{value}</span></label>;
}

function selectorLabel(plan: RaidPlanDocument, selector: MemberSelector) {
  if (selector.kind === "all") return "全团";
  if (selector.kind === "groups") return selector.groupIds.map((id) => plan.roster.groups.find((item) => item.id === id)?.name ?? "未知策略组").join("、") || "未选择";
  if (selector.kind === "roles") return selector.roles.map((role) => roleLabels[role]).join("、") || "未选择";
  if (selector.kind === "subgroups") return selector.subgroups.map((group) => `${group} 队`).join("、") || "未选择";
  return selector.memberIds.map((id) => plan.roster.members.find((item) => item.id === id)?.name ?? "未知成员").join("、") || "未选择";
}

function ReadonlyDetails({ plan, selection }: { plan: RaidPlanDocument; selection: SharedSelection }) {
  if (!selection) return <div className="inspector readonly-inspector"><header><h2>{plan.encounter.name}</h2><span>ENCOUNTER</span></header><ReadonlyField label="计划名称" value={plan.metadata.title} /><ReadonlyField label="游戏版本" value={plan.encounter.gameVersion} /><p className="field-note">点击右侧的成员、机制、阶段、任务、说明或技能安排查看完整信息。</p></div>;
  const member = selection.type === "member" ? plan.roster.members.find((item) => item.id === selection.id) : undefined;
  const occurrence = selection.type === "mechanic" ? plan.timeline.mechanics.find((item) => item.id === selection.id) : undefined;
  const phase = selection.type === "phase" ? plan.timeline.phases.find((item) => item.id === selection.id) : undefined;
  const directive = selection.type === "directive" ? plan.timeline.directives.find((item) => item.id === selection.id) : undefined;
  const assignment = selection.type === "assignment" ? plan.timeline.skillAssignments.find((item) => item.id === selection.id) : undefined;

  if (member) {
    const groups = member.groupIds.map((id) => plan.roster.groups.find((item) => item.id === id)?.name).filter(Boolean).join("、") || "未分组";
    return <div className="inspector readonly-inspector"><header><h2>{member.name}</h2><span>成员槽位</span></header><ReadonlyField label="职业" value={member.classSlug ? WOW_CLASS_LABELS[member.classSlug] ?? member.classSlug : "未设置"} /><ReadonlyField label="专精" value={specializationLabel(member.classSlug ?? "", member.specSlug ?? "")} /><ReadonlyField label="职责" value={member.role ? roleLabels[member.role] : "未设置"} /><ReadonlyField label="小队" value={member.subgroup ? `${member.subgroup} 队` : "未指定"} /><ReadonlyField label="策略组" value={groups} /></div>;
  }
  if (phase) return <div className="inspector readonly-inspector"><header><h2>{phase.name}</h2><span>阶段 {phase.ordinal}</span></header><ReadonlyField label="预计开始" value={formatTime(phase.estimatedStartMs)} /><p className="field-note">阶段预计时间用于布局、检查和无法表达事件触发时的导出降级。</p></div>;
  if (directive) {
    const resolved = resolveDirectiveTime(plan, directive);
    const directiveScope = directive.scope;
    const scopeLabel = directiveScope.kind === "plan" ? "全计划" : directiveScope.kind === "phase" ? `整个 ${plan.timeline.phases.find((item) => item.id === directiveScope.phaseId)?.name ?? "未知阶段"}` : resolved?.ok ? formatTime(resolved.atMs) : "无法解析";
    return <div className="inspector readonly-inspector"><header><h2>{directive.kind === "task" ? "战术任务" : "说明"}</h2><span>{directive.kind.toUpperCase()}</span></header><ReadonlyField label="范围" value={scopeLabel} /><ReadonlyField label="内容" value={directive.text || "空内容"} multiline />{directive.kind === "task" && <><ReadonlyField label="执行者" value={selectorLabel(plan, directive.assignees)} /><ReadonlyField label="提前提醒" value={directive.reminder ? `${directive.reminder.leadMs / 1000} 秒` : "无"} /></>}</div>;
  }
  if (occurrence) {
    const definition = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId); const start = resolveMechanicPoint(plan, occurrence.id, "cast-start"); const impact = resolveMechanicPoint(plan, occurrence.id, "impact"); const end = resolveMechanicPoint(plan, occurrence.id, "end");
    return <div className="inspector readonly-inspector"><header><h2>{definition?.name ?? "未知机制"}</h2><span>机制实例</span></header><ReadonlyField label="施法开始" value={start.ok ? formatTime(start.atMs) : "无法解析"} /><ReadonlyField label="命中" value={impact.ok ? formatTime(impact.atMs) : "无法解析"} /><ReadonlyField label="结束" value={end.ok ? formatTime(end.atMs) : "无法解析"} /><ReadonlyField label="说明" value={definition?.description || "暂无说明"} multiline />{definition && <ReadonlyField label="核准状态" value={skillDataStatusLabel(definition.dataStatus)} />}</div>;
  }
  if (assignment) {
    const memberName = plan.roster.members.find((item) => item.id === assignment.memberId)?.name ?? "未知成员"; const skill = resolveSkillForMember(plan, assignment.memberId, assignment.skillDefinitionId); const time = resolveTimelineAnchor(plan, assignment.anchor);
    return <div className="inspector readonly-inspector"><header><h2>{skill?.name ?? "未知技能"}</h2><span>{skill ? skillDataStatusLabel(skill.dataStatus) : "技能安排"}</span></header><ReadonlyField label="成员" value={memberName} />{skill?.selectedVariant && <ReadonlyField label="变体" value={skill.selectedVariant.name} />}<ReadonlyField label="开始时间" value={time.ok ? formatTime(time.atMs) : "无法解析"} />{skill && <ReadonlyField label="技能时间" value={`${skill.cooldownMs == null ? "冷却待补" : `${skill.cooldownMs / 1000} 秒冷却`} · ${skill.maxCharges} 层充能 · ${skill.castType === "channel" ? "引导" : skill.castType === "cast" ? "读条" : skill.castType === "instant" ? "瞬发" : "施法待补"}`} />}{skill?.limitations.map((limitation) => <ReadonlyField key={limitation} label="计算限制" value={limitation} multiline />)}{assignment.note && <ReadonlyField label="备注" value={assignment.note} multiline />}</div>;
  }
  return <div className="context-empty"><strong>对象已不存在</strong><p>它可能已从发布版本中移除。</p></div>;
}

export function SharedPlanClient({ shareId }: { shareId: string }) {
  const router = useRouter();
  const [stored, setStored] = useState<PublicPublication | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [mechanicLaneMode, setMechanicLaneMode] = useState<MechanicLaneMode>("compact");
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [timelineScroll, setTimelineScroll] = useState({ left: 0, top: 0 });
  const [selection, setSelection] = useState<SharedSelection>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [viewWidth, setViewWidth] = useState(1024);
  const [viewReady, setViewReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/publications/${shareId}`).then(async (response) => { const payload = await response.json() as { data?: PublicPublication; error?: ApiError }; if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败"); if (!cancelled) setStored(payload.data); }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "读取计划失败"); });
    queueMicrotask(() => { if (cancelled) return; try { const view = JSON.parse(localStorage.getItem(viewPreferenceKey("shared", shareId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; mechanicLaneMode?: MechanicLaneMode; zoom?: number; leftCollapsed?: boolean } | null; setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setMechanicLaneMode(view?.mechanicLaneMode === "by-type" ? "by-type" : "compact"); setZoom(clampZoom(view?.zoom ?? MIN_ZOOM)); setLeftCollapsed(view?.leftCollapsed ?? innerWidth < 720); } catch { setViewWidth(innerWidth); setOrientation(defaultOrientation(innerWidth)); setMechanicLaneMode("compact"); setZoom(MIN_ZOOM); setLeftCollapsed(innerWidth < 720); } setViewReady(true); });
    return () => { cancelled = true; };
  }, [shareId]);
  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("shared", shareId, viewWidth), JSON.stringify({ orientation, mechanicLaneMode, zoom, leftCollapsed })); }, [leftCollapsed, mechanicLaneMode, orientation, shareId, viewReady, viewWidth, zoom]);
  useEffect(() => {
    const element = scrollRef.current; if (!element) return;
    const onWheel = (event: WheelEvent) => { if (!shouldInterceptTimelineWheel(event.ctrlKey, event.target instanceof Node && element.contains(event.target))) return; event.preventDefault(); setZoom((current) => { const next = zoomFromWheel(current, event.deltaY); const rect = element.getBoundingClientRect(); if (orientation === "horizontal") element.scrollLeft = anchoredScroll(element.scrollLeft, event.clientX - rect.left, current, next); else element.scrollTop = anchoredScroll(element.scrollTop, event.clientY - rect.top, current, next); return next; }); };
    element.addEventListener("wheel", onWheel, { passive: false }); return () => element.removeEventListener("wheel", onWheel);
  }, [orientation]);

  const plan = stored?.document ?? null;
  const scene = useMemo(() => plan ? buildTimelineScene(plan) : null, [plan]);
  const warnings = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);
  const timelineSelection: TimelineSelectionKey = selection && selection.type !== "member" ? `${selection.type}:${selection.id}` : null;
  if (error) return <main className="state-page"><div className="state-card"><h1>分享链接不可用</h1><p>{error}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !stored || !scene) return <main className="state-page"><p>正在读取只读排轴…</p></main>;

  function choose(key: Exclude<TimelineSelectionKey, null>) { const separator = key.indexOf(":"); setSelection({ type: key.slice(0, separator) as Exclude<SharedSelection, null>["type"], id: key.slice(separator + 1) }); setLeftCollapsed(false); }
  function copyMrt() { const result = exportPlan({ target: "mrt-reading", document: plan! }); const blocker = result.diagnostics.find((item) => item.severity === "error"); if (blocker) { setToast(blocker.message); return; } navigator.clipboard.writeText(result.text).then(() => setToast(result.diagnostics.length ? `MRT 已复制，含 ${result.diagnostics.length} 项降级提示` : "MRT 已复制")); }

  return <main className="shared-workspace"><header className="editor-utility-header shared-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="shared-plan-name"><strong>{plan.metadata.title}</strong><span className="readonly-state">只读</span></div><div className="header-actions"><button onClick={async () => { const local = await createLocalPlan(plan); router.push(`/plans/${local.id}`); }}>复制到我的轴</button><button onClick={copyMrt}>MRT</button><ThemeControl compact /></div></header><div className={`editor-table-grid shared-table-grid ${leftCollapsed ? "left-collapsed" : ""}`}><aside className={`left-table-panel context-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <ReadonlyDetails plan={plan} selection={selection} />}</aside><section className="timeline-work-panel"><div className="axis-toolbar"><strong>时间轴</strong><div><MechanicLaneModeControl value={mechanicLaneMode} onChange={setMechanicLaneMode} /><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div><div className="axis-scroll" ref={scrollRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView scene={scene} orientation={orientation} mechanicLaneMode={mechanicLaneMode} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} readOnly warningIds={new Set(warnings.map((item) => item.assignmentId))} onSelect={(key) => { if (key) choose(key); }} onSelectMember={(id) => { setSelection({ type: "member", id }); setLeftCollapsed(false); }} /></div><div className="axis-statusbar"><span>点击对象查看详情 · Ctrl + 滚轮缩放</span><button className={warnings.length + scene.diagnostics.length ? "warn" : "ok"} onClick={() => { const first = warnings[0]; if (first) { setSelection({ type: "assignment", id: first.assignmentId }); setLeftCollapsed(false); } }}>{warnings.length + scene.diagnostics.length ? `${warnings.length + scene.diagnostics.length} 项提醒` : "检查通过"}</button></div></section></div>{toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}</main>;
}
