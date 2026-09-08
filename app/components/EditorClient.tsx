"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */

import { useEffect, useMemo, useRef, useState } from "react";
import { SEED_CATALOG } from "@/lib/catalog";
import { cooldownsForMember, specializationFor, specializationsForClass, WOW_CLASS_COLORS, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import {
  buildTimelineScene,
  deleteRosterMember,
  detectConflicts,
  exportPlan,
  formatTime,
  hasBlockingDiagnostics,
  makeId,
  moveAnchorTo,
  parsePlanDocument,
  parseTime,
  resolveTimelineAnchor,
  snapTime,
  validatePlanSemantics,
} from "@/lib/core";
import type { ConflictWarning, PlanDiagnostic } from "@/lib/core";
import { hashPlanDocument } from "@/lib/hashing";
import { skillEffectText } from "@/lib/plan-presentation";
import { randomBase62 } from "@/lib/publication-ids";
import { defaultSkillTargets, skillDataStatusLabel, skillTargetMode, skillTargetsForMode } from "@/lib/skills";
import type {
  ApiError,
  CatalogRelease,
  LocalPlanRecord,
  MemberSelector,
  MechanicDefinitionSnapshot,
  MechanicOccurrence,
  PlanSnapshot,
  PlayerSkillDefinition,
  PublicPublication,
  PublicationBinding,
  RaidPhase,
  RaidPlanDocument,
  RosterSlot,
  SkillAssignment,
  TacticalDirective,
  TimelineAnchor,
} from "@/lib/types";
import { anchoredScroll, clampZoom, defaultOrientation, MIN_ZOOM, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type MechanicLaneMode, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { MechanicPresentationEditor } from "./MechanicPresentationEditor";
import { MechanicLaneModeControl, TimelineView, type TimelineSelectionKey } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { SkillTargetEditor } from "./SkillTargetEditor";
import { cacheCatalog, createLocalPlan, createPlanSnapshot, getCachedCatalog, getLocalPlan, listPlanSnapshots, LocalRevisionConflictError, saveLocalPlan, setPlanPublication } from "./local-store";

type TimelineObjectSelection = { type: "mechanic" | "assignment" | "phase" | "directive"; id: string };
type Selection = TimelineObjectSelection | { type: "member" | "skill"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type PanelMode = "object" | "skills" | "history" | "checks";
type MutatePlan = (mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) => void;

const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;
const castTypeLabels = { unknown: "待配置", instant: "瞬发", cast: "读条", channel: "引导" } as const;

function clonePlan(plan: RaidPlanDocument) { return structuredClone(plan); }
function entityCounts(plan: RaidPlanDocument) {
  return [plan.roster.members.length, plan.definitions.mechanics.length, plan.timeline.phases.length, plan.timeline.mechanics.length, plan.timeline.directives.length, plan.timeline.skillAssignments.length];
}

function TimeField({ value, onCommit, label = "时间" }: { value: number; onCommit: (value: number) => void; label?: string }) {
  const [draft, setDraft] = useState(formatTime(value));
  useEffect(() => { const timer = setTimeout(() => setDraft(formatTime(value)), 0); return () => clearTimeout(timer); }, [value]);
  function commit() { const parsed = parseTime(draft); if (parsed == null) setDraft(formatTime(value)); else onCommit(parsed); }
  return <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function NullableNumber({ value, onChange, scale = 1, min = 0, placeholder = "未设置" }: { value: number | null; onChange: (value: number | null) => void; scale?: number; min?: number; placeholder?: string }) {
  return <input type="number" min={min} placeholder={placeholder} value={value == null ? "" : value / scale} onChange={(event) => onChange(event.target.value === "" ? null : Math.max(min, Number(event.target.value)) * scale)} />;
}

function anchorAbsoluteTime(plan: RaidPlanDocument, anchor: TimelineAnchor) {
  const result = resolveTimelineAnchor(plan, anchor);
  return result.ok ? result.atMs : 0;
}

function anchorRelationValue(anchor: TimelineAnchor) {
  if (anchor.kind === "pull") return "pull";
  if (anchor.kind === "phase") return `phase:${anchor.phaseId}`;
}

function anchorForRelation(plan: RaidPlanDocument, relation: string, atMs: number): TimelineAnchor {
  const snapped = snapTime(atMs);
  if (relation === "pull") return { kind: "pull", offsetMs: snapped };
  const [kind, id] = relation.split(":");
  if (kind === "phase") {
    const phase = plan.timeline.phases.find((item) => item.id === id);
    return phase ? { kind: "phase", phaseId: id, offsetMs: Math.round((snapped - phase.estimatedStartMs) / 1000) * 1000 } : { kind: "pull", offsetMs: snapped };
  }
  return { kind: "pull", offsetMs: snapped };
}

function AnchorEditor({ plan, anchor, onChange }: { plan: RaidPlanDocument; anchor: TimelineAnchor; onChange: (anchor: TimelineAnchor) => void }) {
  const absolute = anchorAbsoluteTime(plan, anchor);
  const resolved = resolveTimelineAnchor(plan, anchor);
  return <>
    <label>时间关系<select value={anchorRelationValue(anchor)} onChange={(event) => onChange(anchorForRelation(plan, event.target.value, absolute))}>
      <option value="pull">开怪后</option>
      {anchor.kind === "phase" && !plan.timeline.phases.some(phase => phase.id === anchor.phaseId) && <option value={`phase:${anchor.phaseId}`} disabled>阶段已不存在，请重新选择</option>}
      {plan.timeline.phases.map((phase) => <option key={phase.id} value={`phase:${phase.id}`}>{phase.name} 开始后</option>)}
    </select></label>
    <label>解析时间{resolved.ok ? <TimeField value={absolute} onCommit={(value) => onChange(moveAnchorTo(plan, anchor, value))} /> : <span className="readonly-field danger-text">无法解析</span>}</label>
    {anchor.kind !== "pull" && <p className="field-note">随阶段开始时间移动。</p>}
  </>;
}

function TargetEditor({ target, plan, onChange }: { target: MemberSelector; plan: RaidPlanDocument; onChange: (target: MemberSelector) => void }) {
  function changeKind(kind: string) {
    if (kind === "all") onChange({ kind });
    else if (kind === "members") onChange({ kind, memberIds: [] });
  }
  function toggleMember(value: string) {
    if (target.kind !== "members") return;
    const current = new Set(target.memberIds);
    if (current.has(value)) current.delete(value); else current.add(value);
    onChange({ kind: "members", memberIds: [...current] });
  }
  return <div className="target-editor"><select aria-label="执行者" value={target.kind} onChange={(event) => changeKind(event.target.value)}>
    <option value="all">全团</option>
    <option value="members">具体成员</option>
  </select>
    {target.kind === "members" && <div className="check-grid">{plan.roster.members.map((member) => <label key={member.id}><input type="checkbox" checked={target.memberIds.includes(member.id)} onChange={() => toggleMember(member.id)} />{member.name}</label>)}</div>}
  </div>;
}

function skillTimingSummary(skill: PlayerSkillDefinition) {
  const cooldown = skill.cooldownMs == null ? "冷却待补" : `最短冷却 ${skill.cooldownMs / 1000} 秒`;
  const charges = skill.maxCharges > 1 ? ` · ${skill.maxCharges} 层充能` : "";
  const duration = skill.durationMs == null ? " · 持续待补" : ` · 持续 ${skill.durationMs / 1000} 秒`;
  return `${cooldown}${charges}${duration}`;
}

export function EditorClient({ planId }: { planId: string }) {
  const [record, setRecord] = useState<LocalPlanRecord | null>(null);
  const [plan, setPlan] = useState<RaidPlanDocument | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState("");
  const [conflict, setConflict] = useState<LocalPlanRecord | null>(null);
  const [publishing, setPublishing] = useState("");
  const [currentHash, setCurrentHash] = useState("");
  const [panelMode, setPanelMode] = useState<PanelMode>("object");
  const [skillMemberId, setSkillMemberId] = useState("");
  const [skillInsertionMs, setSkillInsertionMs] = useState(0);
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [mechanicLaneMode, setMechanicLaneMode] = useState<MechanicLaneMode>("compact");
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [timelineScroll, setTimelineScroll] = useState({ left: 0, top: 0 });
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [viewWidth, setViewWidth] = useState(1024);
  const [viewReady, setViewReady] = useState(false);
  const [catalog, setCatalog] = useState<CatalogRelease>(SEED_CATALOG);
  const [snapshots, setSnapshots] = useState<PlanSnapshot[]>([]);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const undoStack = useRef<RaidPlanDocument[]>([]);
  const redoStack = useRef<RaidPlanDocument[]>([]);
  const editRevision = useRef(0);
  const planRef = useRef<RaidPlanDocument | null>(null);
  const localRevisionRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      try {
        const [local, localSnapshots, cached] = await Promise.all([getLocalPlan(planId), listPlanSnapshots(planId), getCachedCatalog()]);
        if (!local) throw new Error("这条本地轴不存在，可能已被删除。");
        const document = parsePlanDocument(local.document);
        if (cancelled) return;
        setRecord({ ...local, document }); setPlan(document); planRef.current = document;
        setLocalRevision(local.localRevision); localRevisionRef.current = local.localRevision;
        setSnapshots(localSnapshots); if (cached) setCatalog(cached);
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("plan", planId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; mechanicLaneMode?: MechanicLaneMode; zoom?: number; leftCollapsed?: boolean } | null;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setMechanicLaneMode(view?.mechanicLaneMode === "by-type" ? "by-type" : "compact"); setZoom(clampZoom(view?.zoom ?? MIN_ZOOM)); setLeftCollapsed(view?.leftCollapsed ?? innerWidth < 720); setViewReady(true);
        fetch("/api/catalog/current").then(async (response) => {
          const payload = await response.json() as { data?: CatalogRelease };
          if (response.ok && payload.data) { await cacheCatalog(payload.data); if (!cancelled) setCatalog(payload.data); }
        }).catch(() => undefined);
      } catch (error) { if (!cancelled) setFatal(error instanceof Error ? error.message : "读取本地计划失败"); }
    });
    return () => { cancelled = true; };
  }, [planId]);

  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("plan", planId, viewWidth), JSON.stringify({ orientation, mechanicLaneMode, zoom, leftCollapsed })); }, [leftCollapsed, mechanicLaneMode, orientation, planId, viewReady, viewWidth, zoom]);

  function mutate(mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) {
    const current = planRef.current;
    if (!current) return;
    const next = clonePlan(current);
    mutator(next);
    let parsed: RaidPlanDocument;
    try { parsed = parsePlanDocument(next); }
    catch (error) { setToast(error instanceof Error ? error.message : "修改不符合 v1 数据结构"); return; }
    undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)]; redoStack.current = [];
    const destructive = entityCounts(parsed).some((value, index) => value < entityCounts(current)[index]);
    if (destructive) createPlanSnapshot(planId, "destructive", current, localRevisionRef.current).then(() => listPlanSnapshots(planId).then(setSnapshots)).catch(() => undefined);
    planRef.current = parsed; setPlan(parsed); editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: false }); setSaveState("dirty");
    if (nextSelection !== undefined) setSelection(nextSelection);
  }

  function replacePlan(value: RaidPlanDocument) {
    const next = parsePlanDocument(value);
    const current = planRef.current;
    if (current) undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)];
    redoStack.current = []; planRef.current = next; setPlan(next); editRevision.current += 1; setHistoryState({ canUndo: Boolean(current), canRedo: false }); setSelection(null); setSaveState("dirty");
  }

  function undo() {
    const current = planRef.current; const previous = undoStack.current.pop(); if (!current || !previous) return;
    redoStack.current.push(clonePlan(current)); planRef.current = previous; setPlan(previous); editRevision.current += 1; setHistoryState({ canUndo: undoStack.current.length > 0, canRedo: true }); setSaveState("dirty");
  }
  function redo() {
    const current = planRef.current; const next = redoStack.current.pop(); if (!current || !next) return;
    undoStack.current.push(clonePlan(current)); planRef.current = next; setPlan(next); editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: redoStack.current.length > 0 }); setSaveState("dirty");
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); } };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!plan || saveState !== "dirty" || conflict) return;
    const captured = plan; const capturedRevision = editRevision.current;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const saved = await saveLocalPlan(planId, captured, localRevisionRef.current);
        localRevisionRef.current = saved.localRevision; setLocalRevision(saved.localRevision); setRecord({ ...saved, document: planRef.current ?? saved.document });
        setSaveState(editRevision.current === capturedRevision ? "saved" : "dirty");
      } catch (error) {
        if (error instanceof LocalRevisionConflictError) { setConflict(error.latest); setSaveState("conflict"); }
        else { setSaveState("error"); setToast(error instanceof Error ? error.message : "本地保存失败"); }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [conflict, plan, planId, saveState]);

  useEffect(() => { if (!plan) return; let cancelled = false; hashPlanDocument(plan).then((hash) => { if (!cancelled) setCurrentHash(hash); }); return () => { cancelled = true; }; }, [plan]);
  useEffect(() => { const timer = setInterval(() => { const current = planRef.current; if (current) createPlanSnapshot(planId, "minute", current, localRevisionRef.current).then(() => listPlanSnapshots(planId).then(setSnapshots)).catch(() => undefined); }, 60_000); return () => clearInterval(timer); }, [planId]);
  useEffect(() => {
    const element = timelineRef.current; if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!shouldInterceptTimelineWheel(event.ctrlKey, event.target instanceof Node && element.contains(event.target))) return;
      event.preventDefault(); setZoom((current) => { const next = zoomFromWheel(current, event.deltaY); const rect = element.getBoundingClientRect(); if (orientation === "horizontal") element.scrollLeft = anchoredScroll(element.scrollLeft, event.clientX - rect.left, current, next); else element.scrollTop = anchoredScroll(element.scrollTop, event.clientY - rect.top, current, next); return next; });
    };
    element.addEventListener("wheel", onWheel, { passive: false }); return () => element.removeEventListener("wheel", onWheel);
  }, [orientation]);

  const scene = useMemo(() => plan ? buildTimelineScene(plan, catalog.playerSkills) : null, [plan, catalog.playerSkills]);
  const conflicts = useMemo(() => plan ? detectConflicts(plan, catalog.playerSkills) : [], [plan, catalog.playerSkills]);
  const diagnostics = useMemo(() => scene?.diagnostics ?? [], [scene]);
  const warningIds = useMemo(() => new Set([...conflicts.map((item) => item.assignmentId), ...diagnostics.flatMap((item) => item.objectId ? [item.objectId] : [])]), [conflicts, diagnostics]);
  const skillMember = plan?.roster.members.find((item) => item.id === skillMemberId);
  const availableSkills = useMemo(() => cooldownsForMember(catalog.playerSkills.filter(item => item.enabled), skillMember), [catalog.playerSkills, skillMember]);

  if (fatal) return <main className="state-page"><div className="state-card"><h1>无法打开编辑器</h1><p>{fatal}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !record || !scene) return <main className="state-page"><p>正在读取本地计划…</p></main>;
  const activePlan = plan; const activeRecord = record;

  function revealSelection(next: Selection, locate = false) {
    setSelection(next); setPanelMode("object"); setLeftCollapsed(false);
    if (!locate || !next || next.type === "member" || next.type === "skill") return;
    requestAnimationFrame(() => requestAnimationFrame(() => timelineRef.current?.querySelector<HTMLElement>(`[data-timeline-key="${next.type}:${next.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" })));
  }
  function addMember() {
    const id = makeId();
    mutate((draft) => draft.roster.members.push({ id, name: `成员 ${String(draft.roster.members.length + 1).padStart(2, "0")}`, classSlug: null, specSlug: null, role: null, color: "#7b8490" }), { type: "member", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addPhase(atMs: number) {
    const id = makeId();
    mutate((draft) => { draft.timeline.phases.push({ id, name: `P${draft.timeline.phases.length + 1}`, ordinal: draft.timeline.phases.length + 1, estimatedStartMs: Math.max(1000, snapTime(atMs)) }); draft.timeline.phases.sort((a, b) => a.estimatedStartMs - b.estimatedStartMs || a.ordinal - b.ordinal).forEach((item, index) => { item.ordinal = index + 1; }); }, { type: "phase", id }); setPanelMode("object"); setLeftCollapsed(false);
  }
  function addDirective(kind: "task" | "note", atMs: number) {
    const id = makeId();
    mutate((draft) => {
      const scope = { kind: "timed" as const, anchor: { kind: "pull" as const, offsetMs: snapTime(atMs) } };
      if (kind === "task") draft.timeline.directives.push({ id, kind, text: "新任务", scope, assignees: { kind: "all" }, durationMs: null });
      else draft.timeline.directives.push({ id, kind, text: "新说明", scope, durationMs: null });
    }, { type: "directive", id }); setPanelMode("object"); setLeftCollapsed(false);
  }
  function addAssignment(skillDefinitionId: string) {
    const member = activePlan.roster.members.find(item => item.id === skillMemberId);
    const skill = catalog.playerSkills.find(item => item.enabled && item.id === skillDefinitionId);
    if (!member || !skill) return;
    const assignment: SkillAssignment = { id: makeId(), memberId: member.id, skillDefinitionId: skill.id, anchor: { kind: "pull", offsetMs: snapTime(skillInsertionMs) }, targets: defaultSkillTargets(skill, member.id), note: "" };
    mutate(draft => { draft.timeline.skillAssignments.push(assignment); }, { type: "assignment", id: assignment.id });
    setPanelMode("object");
  }
  function openMemberSkills(memberId: string, atMs: number) {
    const member = activePlan.roster.members.find((item) => item.id === memberId); if (!member) return;
    setSelection({ type: "member", id: memberId }); setLeftCollapsed(false);
    if (!member.classSlug) { setPanelMode("object"); setToast("请先为该成员选择职业和专精"); return; }
    setSkillMemberId(memberId); setSkillInsertionMs(atMs); setPanelMode("skills");
  }
  function moveTimelineObject(type: TimelineObjectSelection["type"], id: string, atMs: number) {
    mutate((draft) => {
      if (type === "phase") { const phase = draft.timeline.phases.find((item) => item.id === id); if (phase && phase.ordinal !== 1) { phase.estimatedStartMs = Math.max(1000, snapTime(atMs)); draft.timeline.phases.sort((a, b) => a.estimatedStartMs - b.estimatedStartMs || a.ordinal - b.ordinal).forEach((item, index) => { item.ordinal = index + 1; }); } return; }
      if (type === "mechanic") { const item = draft.timeline.mechanics.find((entry) => entry.id === id); if (item) item.anchor = moveAnchorTo(draft, item.anchor, atMs); return; }
      if (type === "assignment") { const item = draft.timeline.skillAssignments.find((entry) => entry.id === id); if (item) item.anchor = moveAnchorTo(draft, item.anchor, atMs); return; }
      const item = draft.timeline.directives.find((entry) => entry.id === id); if (!item) return;
      if (item.scope.kind === "timed") item.scope.anchor = moveAnchorTo(draft, item.scope.anchor, atMs);
      else setToast("阶段或全计划范围的任务/说明不能通过拖动伪造时间");
    }, { type, id }); setPanelMode("object"); setLeftCollapsed(false);
  }

  async function copyText(value: string, message: string) { await navigator.clipboard.writeText(value); setToast(message); }
  async function refreshSnapshots() { setSnapshots(await listPlanSnapshots(planId)); }
  async function confirmPublication(shareId: string, editId: string, expectedHash: string) {
    const response = await fetch(`/api/publications/${shareId}`); const payload = await response.json() as { data?: PublicPublication };
    if (!response.ok || payload.data?.contentHash !== expectedHash) return null;
    return { shareId, editId, revisionId: payload.data.revisionId, publishedAt: payload.data.publishedAt, contentHash: payload.data.contentHash } satisfies PublicationBinding;
  }
  async function publish(mode: "new" | "overwrite") {
    const semantic = validatePlanSemantics(activePlan, catalog.playerSkills); if (hasBlockingDiagnostics(semantic)) { setToast(semantic.find((item) => item.severity === "error")?.message ?? "计划存在阻断错误"); setPanelMode("checks"); setLeftCollapsed(false); return; }
    const captured = clonePlan(activePlan); const capturedHash = await hashPlanDocument(captured);
    let shareId = mode === "overwrite" ? activeRecord.activePublication?.shareId ?? "" : randomBase62(16); let editId = mode === "overwrite" ? activeRecord.activePublication?.editId ?? "" : randomBase62(4);
    if (!shareId || !editId) { setToast("当前计划还没有可覆盖的发布链接"); return; }
    setPublishing(mode); setToast("");
    try {
      await createPlanSnapshot(planId, "publish", captured, localRevisionRef.current); let binding: PublicationBinding | null = null;
      for (let attempt = 0; attempt < 3 && !binding; attempt += 1) {
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetch(mode === "overwrite" ? `/api/publications/${shareId}/${editId}` : "/api/publications", { method: mode === "overwrite" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: captured, ...(mode === "new" ? { shareId, editId } : {}) }), signal: controller.signal });
          const payload = await response.json() as { data?: PublicPublication & { editId: string; binding: PublicationBinding }; error?: ApiError };
          if (response.status === 409 && mode === "new") { shareId = randomBase62(16); editId = randomBase62(4); continue; }
          if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "发布失败"); binding = payload.data.binding;
        } catch (error) { binding = await confirmPublication(shareId, editId, capturedHash); if (!binding) throw error; }
        finally { clearTimeout(timeout); }
      }
      if (!binding) throw new Error("发布失败，请重试");
      const linked = await setPlanPublication(planId, binding, localRevisionRef.current); localRevisionRef.current = linked.localRevision; setLocalRevision(linked.localRevision); setRecord({ ...linked, document: planRef.current ?? linked.document }); await refreshSnapshots();
      const latestHash = planRef.current ? await hashPlanDocument(planRef.current) : capturedHash; setCurrentHash(latestHash); setToast(latestHash === binding.contentHash ? "服务器版本已发布" : "快照已发布；上传期间的新修改仍只在本地");
    } catch (error) { if (error instanceof LocalRevisionConflictError) { setConflict(error.latest); setSaveState("conflict"); } setToast(error instanceof Error ? error.message : "发布失败"); }
    finally { setPublishing(""); }
  }
  async function removePublication() {
    const binding = activeRecord.activePublication; if (!binding || !confirm("删除当前服务器发布？本地工作副本会保留。")) return; setPublishing("delete");
    try { const response = await fetch(`/api/publications/${binding.shareId}/${binding.editId}`, { method: "DELETE" }); const payload = await response.json() as { error?: ApiError }; if (!response.ok) throw new Error(payload.error?.message ?? "删除失败"); const unlinked = await setPlanPublication(planId, undefined, localRevisionRef.current); localRevisionRef.current = unlinked.localRevision; setLocalRevision(unlinked.localRevision); setRecord({ ...unlinked, document: planRef.current ?? unlinked.document }); setToast("服务器发布已删除，本地轴仍然保留"); }
    catch (error) { setToast(error instanceof Error ? error.message : "删除失败"); } finally { setPublishing(""); }
  }
  function exportMrt() {
    const result = exportPlan({ target: "mrt-reading", document: activePlan, skillLibrary: catalog.playerSkills }); const error = result.diagnostics.find((item) => item.severity === "error");
    if (error) { setToast(error.message); setPanelMode("checks"); setLeftCollapsed(false); return; }
    copyText(result.text, result.diagnostics.length ? `MRT 已复制，含 ${result.diagnostics.length} 项降级提示` : "MRT 已复制");
  }

  const timelineSelection: TimelineSelectionKey = selection && ["mechanic", "assignment", "phase", "directive"].includes(selection.type) ? `${selection.type as TimelineObjectSelection["type"]}:${selection.id}` : null;
  const publicationDirty = Boolean(record.activePublication && currentHash && record.activePublication.contentHash !== currentHash);

  return <main className="editor-workspace" data-local-revision={localRevision}>
    <header className="editor-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="plan-name"><input aria-label="计划名称" value={plan.metadata.title} onChange={(event) => mutate((draft) => { draft.metadata.title = event.target.value; })} /><span className={`save-state ${saveState}`}>{{ saved: "本地已保存", dirty: "本地待保存", saving: "本地保存中", error: "本地保存失败", conflict: "标签页冲突" }[saveState]}</span><span className={`publication-state ${publicationDirty ? "dirty" : record.activePublication ? "published" : "unpublished"}`}>{record.activePublication ? publicationDirty ? "存在未发布修改" : "服务器已发布" : "尚未发布"}</span></div><div className="header-actions"><button onClick={undo} disabled={!historyState.canUndo}>撤销</button><button onClick={redo} disabled={!historyState.canRedo}>重做</button><button onClick={exportMrt}>MRT</button><details className="header-menu"><summary>工具</summary><div><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanelMode("history"); setLeftCollapsed(false); }}>历史</button></div></details>{record.activePublication && <><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}`, "只读链接已复制")}>复制分享链接</button><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}/${record.activePublication!.editId}`, "编辑链接已复制")}>复制编辑链接</button><button disabled={Boolean(publishing)} onClick={() => publish("overwrite")}>覆盖当前链接</button></>}<button disabled={Boolean(publishing)} onClick={() => publish("new")}>{record.activePublication ? "发布为新链接" : "发布并创建链接"}</button>{record.activePublication && <button className="danger-link" disabled={Boolean(publishing)} onClick={removePublication}>删除发布</button>}<ThemeControl compact /></div></header>
    {saveState === "conflict" && <div className="conflict-banner"><span>另一个标签页已保存了更新；当前标签页没有覆盖它。</span><button onClick={() => { if (conflict) { const next = parsePlanDocument(conflict.document); setPlan(next); planRef.current = next; setRecord(conflict); setLocalRevision(conflict.localRevision); localRevisionRef.current = conflict.localRevision; setConflict(null); setSaveState("saved"); } }}>加载较新本地版本</button><button onClick={async () => { const copy = await createLocalPlan(activePlan); location.assign(`/plans/${copy.id}`); }}>将当前内容另存为副本</button></div>}
    <div className={`editor-table-grid ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`left-table-panel context-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <>
        {panelMode === "skills" && <div className="panel-body skill-picker">
          <header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>选择技能</b></header>
          <p className="skill-target">分配给：<b>{skillMember?.name}</b><small>{formatTime(skillInsertionMs)}</small></p>
          <div className="skill-list grouped-skill-list">{availableSkills.map(skill => <section className="skill-group" key={skill.id}>
            <button className="skill-definition" onClick={() => { setSelection({ type: "skill", id: skill.id }); setPanelMode("object"); }}><i style={{ background: skill.color }} /><span><strong>{skill.name}</strong><small>{skillTimingSummary(skill)}</small></span></button>
            <button aria-label={`安排${skill.name}`} onClick={() => addAssignment(skill.id)}>＋ 安排</button>
          </section>)}{!availableSkills.length && <p className="table-empty">当前职业或专精暂无可用技能。</p>}</div>
        </div>}
        {panelMode === "history" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>历史检查点</b></header><div className="snapshot-list">{snapshots.slice(0, 30).map((snapshot) => <button key={snapshot.id} onClick={async () => { if (!confirm(`恢复 ${new Date(snapshot.createdAt).toLocaleString("zh-CN")} 的检查点？`)) return; await createPlanSnapshot(planId, "destructive", activePlan, localRevisionRef.current); replacePlan(snapshot.document); setPanelMode("object"); await refreshSnapshots(); }}><span>{new Date(snapshot.createdAt).toLocaleString("zh-CN")}</span><small>{{ minute: "自动", publish: "发布前", preset: "预设前", destructive: "操作前", manual: "手动" }[snapshot.reason]}</small></button>)}{!snapshots.length && <p className="table-empty">尚无可恢复的检查点。</p>}</div></div>}
        {panelMode === "checks" && <Checks conflicts={conflicts} diagnostics={diagnostics} onSelect={(type, id) => revealSelection({ type, id }, true)} onBack={() => setPanelMode("object")} />}
        {panelMode === "object" && <Inspector library={catalog.playerSkills} plan={plan} selection={selection} mutate={mutate} conflicts={conflicts} />}
      </>}</aside>
      <section className="timeline-work-panel"><div className="axis-toolbar"><strong>时间轴</strong><div><MechanicLaneModeControl value={mechanicLaneMode} onChange={setMechanicLaneMode} /><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div><div className="axis-scroll" ref={timelineRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView scene={scene} orientation={orientation} mechanicLaneMode={mechanicLaneMode} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} warningIds={warningIds} onSelect={(key) => { if (!key) return; const separator = key.indexOf(":"); revealSelection({ type: key.slice(0, separator) as TimelineObjectSelection["type"], id: key.slice(separator + 1) }); }} onSelectMember={(id) => revealSelection({ type: "member", id })} onOpenMemberSkills={openMemberSkills} onAddMember={addMember} onAddPhase={addPhase} onAddDirective={addDirective} onMovePhase={(id, atMs) => moveTimelineObject("phase", id, atMs)} onMoveDirective={(id, atMs) => moveTimelineObject("directive", id, atMs)} onMoveMechanic={(id, atMs) => moveTimelineObject("mechanic", id, atMs)} onMoveAssignment={(id, atMs) => moveTimelineObject("assignment", id, atMs)} /></div><div className="axis-statusbar"><span>Ctrl + 滚轮缩放 · 拖动只改变锚点偏移 · 左侧显示当前对象</span><button className={conflicts.length + diagnostics.length ? "warn" : "ok"} onClick={() => { setPanelMode("checks"); setLeftCollapsed(false); }}>{conflicts.length + diagnostics.length ? `${conflicts.length + diagnostics.length} 项提醒` : "冷却与结构无异常"}</button></div></section>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </main>;
}

function Checks({ conflicts, diagnostics, onSelect, onBack }: { conflicts: ConflictWarning[]; diagnostics: PlanDiagnostic[]; onSelect: (type: NonNullable<Selection>["type"], id: string) => void; onBack: () => void }) {
  return <div className="panel-body"><header className="context-heading"><button onClick={onBack}>← 返回</button><b>排轴检查</b></header><div className="checks"><header><b>结构与语义</b><span>{diagnostics.length}</span></header>{diagnostics.map((item, index) => <button key={`${item.code}-${item.objectId}-${index}`} className={item.severity === "error" ? "danger-text" : ""} disabled={!item.objectType} onClick={() => { if (item.objectId && item.objectType) onSelect(item.objectType, item.objectId); }}>{item.severity === "error" ? "阻断：" : "提醒："}{item.message}</button>)}{!diagnostics.length && <p className="table-empty">结构与引用检查通过。</p>}</div><div className="checks"><header><b>技能冷却</b><span>{conflicts.length}</span></header>{conflicts.map((item, index) => <button key={`${item.assignmentId}-${item.type}-${index}`} onClick={() => onSelect("assignment", item.assignmentId)}>{item.message}</button>)}{!conflicts.length && <p className="table-empty">未发现技能冷却冲突。</p>}</div></div>;
}

function Inspector({ plan, selection, mutate, conflicts, library }: { library: readonly PlayerSkillDefinition[]; plan: RaidPlanDocument; selection: Selection; mutate: MutatePlan; conflicts: ConflictWarning[] }) {
  const member = selection?.type === "member" ? plan.roster.members.find((item) => item.id === selection.id) : undefined;
  const phase = selection?.type === "phase" ? plan.timeline.phases.find((item) => item.id === selection.id) : undefined;
  const directive = selection?.type === "directive" ? plan.timeline.directives.find((item) => item.id === selection.id) : undefined;
  const occurrence = selection?.type === "mechanic" ? plan.timeline.mechanics.find((item) => item.id === selection.id) : undefined;
  const assignment = selection?.type === "assignment" ? plan.timeline.skillAssignments.find((item) => item.id === selection.id) : undefined;
  const directSkill = selection?.type === "skill" ? library.find((item) => item.id === selection.id) : undefined;
  const skill = directSkill ?? (assignment ? library.find((item) => item.id === assignment.skillDefinitionId) : undefined);
  const definition = occurrence ? plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId) : undefined;

  if (!selection) return <div className="inspector"><header><h2>计划与遭遇</h2><span>PLAN</span></header><label>Boss / 遭遇名称<input value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /></label><label>游戏版本<input value={plan.encounter.gameVersion} onChange={(event) => mutate((draft) => { draft.encounter.gameVersion = event.target.value; })} /></label><p className="field-note">点击右侧成员、机制、阶段、任务、说明或技能安排，可在这里编辑。计划名称在页头独立维护。</p></div>;
  if (member) return <MemberInspector member={member} mutate={mutate} />;
  if (phase) return <PhaseInspector phase={phase} mutate={mutate} />;
  if (directive) return <DirectiveInspector plan={plan} directive={directive} mutate={mutate} />;
  if (occurrence && definition) return <MechanicInspector plan={plan} occurrence={occurrence} definition={definition} mutate={mutate} />;
  if (occurrence) return <div className="inspector"><header><h2>Boss 机制</h2></header>
    <label>机制定义<select value={occurrence.definitionId} onChange={event => mutate(draft => { const item = draft.timeline.mechanics.find(entry => entry.id === occurrence.id); if (item) item.definitionId = event.target.value; })}>
      <option value={occurrence.definitionId} disabled>定义已不存在，请重新选择</option>
      {plan.definitions.mechanics.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <AnchorEditor plan={plan} anchor={occurrence.anchor} onChange={anchor => mutate(draft => { const item = draft.timeline.mechanics.find(entry => entry.id === occurrence.id); if (item) item.anchor = anchor; })} />
    <button className="danger-button" onClick={() => mutate(draft => { draft.timeline.mechanics = draft.timeline.mechanics.filter(item => item.id !== occurrence.id); }, null)}>删除机制实例</button>
  </div>;
  if (assignment) return <AssignmentInspector library={library} plan={plan} assignment={assignment} skill={skill} conflicts={conflicts.filter((item) => item.assignmentId === assignment.id)} mutate={mutate} />;
  if (directSkill) return <SkillInspector skill={directSkill} />;
  return <div className="context-empty"><b>对象已不存在</b><p>它可能刚刚被删除。</p></div>;
}

function MemberInspector({ member, mutate }: { member: RosterSlot; mutate: MutatePlan }) {
  const specs = specializationsForClass(member.classSlug ?? "");
  function update(fn: (item: RosterSlot) => void) { mutate((draft) => { const item = draft.roster.members.find((entry) => entry.id === member.id); if (item) fn(item); }); }
  return <div className="inspector"><header><h2>成员</h2><span>ROSTER SLOT</span></header><label>角色名<input value={member.name} onChange={(event) => update((item) => { item.name = event.target.value; })} /></label><label>职业<select value={member.classSlug ?? ""} onChange={(event) => update((item) => { item.classSlug = event.target.value || null; item.specSlug = null; item.role = null; item.color = event.target.value ? WOW_CLASS_COLORS[event.target.value] ?? item.color : "#7b8490"; })}><option value="">待选择</option>{Object.entries(WOW_CLASS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>专精<select disabled={!member.classSlug} value={member.specSlug ?? ""} onChange={(event) => update((item) => { item.specSlug = event.target.value || null; item.role = event.target.value ? specializationFor(item.classSlug ?? "", event.target.value)?.role ?? item.role : null; })}><option value="">待选择</option>{specs.map((spec) => <option key={spec.slug} value={spec.slug}>{spec.label}</option>)}</select></label><label>职责<select value={member.role ?? ""} onChange={(event) => update((item) => { item.role = event.target.value ? event.target.value as RosterSlot["role"] : null; })}><option value="">待选择</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="danger-button" onClick={() => { if (!confirm(`删除成员“${member.name}”及其技能安排？`)) return; mutate((draft) => { deleteRosterMember(draft, member.id); }, null); }}>删除成员</button></div>;
}

function PhaseInspector({ phase, mutate }: { phase: RaidPhase; mutate: MutatePlan }) {
  function update(fn: (item: RaidPhase) => void) { mutate((draft) => { const item = draft.timeline.phases.find((entry) => entry.id === phase.id); if (item) fn(item); }); }
  return <div className="inspector"><header><h2>阶段</h2><span>PHASE {phase.ordinal}</span></header><label>名称<input value={phase.name} onChange={(event) => update((item) => { item.name = event.target.value; })} /></label><label>预计开始时间<TimeField value={phase.estimatedStartMs} onCommit={(value) => update((item) => { if (item.ordinal !== 1) item.estimatedStartMs = value; })} /></label><p className="field-note">阶段序号稳定且唯一；P1 固定从 00:00 开始。预计时间用于布局、检查和导出降级。</p>{phase.ordinal !== 1 && <button className="danger-button" onClick={() => { if (!confirm(`删除阶段“${phase.name}”？引用它的对象将改为开怪后时间。`)) return; mutate((draft) => { const old = draft.timeline.phases.find((item) => item.id === phase.id); if (!old) return; for (const mechanic of draft.timeline.mechanics) if (mechanic.anchor.kind === "phase" && mechanic.anchor.phaseId === phase.id) mechanic.anchor = { kind: "pull", offsetMs: snapTime(old.estimatedStartMs + mechanic.anchor.offsetMs) }; for (const assignment of draft.timeline.skillAssignments) if (assignment.anchor.kind === "phase" && assignment.anchor.phaseId === phase.id) assignment.anchor = { kind: "pull", offsetMs: snapTime(old.estimatedStartMs + assignment.anchor.offsetMs) }; for (const directive of draft.timeline.directives) { if (directive.scope.kind === "timed" && directive.scope.anchor.kind === "phase" && directive.scope.anchor.phaseId === phase.id) directive.scope.anchor = { kind: "pull", offsetMs: snapTime(old.estimatedStartMs + directive.scope.anchor.offsetMs) }; else if (directive.scope.kind === "phase" && directive.scope.phaseId === phase.id) directive.scope = { kind: "timed", anchor: { kind: "pull", offsetMs: old.estimatedStartMs } }; } draft.timeline.phases = draft.timeline.phases.filter((item) => item.id !== phase.id).sort((a, b) => a.estimatedStartMs - b.estimatedStartMs); draft.timeline.phases.forEach((item, index) => { item.ordinal = index + 1; }); }); }}>删除阶段</button>}</div>;
}

function DirectiveInspector({ plan, directive, mutate }: { plan: RaidPlanDocument; directive: TacticalDirective; mutate: MutatePlan }) {
  function update(fn: (item: TacticalDirective) => void) { mutate((draft) => { const item = draft.timeline.directives.find((entry) => entry.id === directive.id); if (item) fn(item); }); }
  function changeScope(kind: "timed" | "phase" | "plan") {
    const scope = directive.scope;
    const currentTime = scope.kind === "timed" ? anchorAbsoluteTime(plan, scope.anchor) : scope.kind === "phase" ? plan.timeline.phases.find((item) => item.id === scope.phaseId)?.estimatedStartMs ?? 0 : 0;
    update((item) => { if (kind === "timed") item.scope = { kind, anchor: { kind: "pull", offsetMs: currentTime } }; else if (kind === "phase") item.scope = { kind, phaseId: plan.timeline.phases[0].id }; else if (item.kind === "note") item.scope = { kind }; });
  }
  return <div className="inspector"><header><h2>{directive.kind === "task" ? "战术任务" : "说明"}</h2><span>{directive.kind.toUpperCase()}</span></header><label>内容<textarea rows={6} value={directive.text} onChange={(event) => update((item) => { item.text = event.target.value; })} /></label><label>范围<select value={directive.scope.kind} onChange={(event) => changeScope(event.target.value as "timed" | "phase" | "plan")}><option value="timed">精确时间</option><option value="phase">整个阶段</option>{directive.kind === "note" && <option value="plan">全计划</option>}</select></label>{directive.scope.kind === "timed" && <AnchorEditor plan={plan} anchor={directive.scope.anchor} onChange={(anchor) => update((item) => { item.scope = { kind: "timed", anchor }; })} />}{directive.scope.kind === "phase" && <label>阶段<select value={directive.scope.phaseId} onChange={(event) => update((item) => { item.scope = { kind: "phase", phaseId: event.target.value }; })}>{plan.timeline.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label>}{directive.kind === "note" && <label className="checkbox-field"><input type="checkbox" checked={directive.timelinePresentation === "team-buff-window"} onChange={event => update(item => { if (item.kind === "note") { if (event.target.checked) item.timelinePresentation = "team-buff-window"; else delete item.timelinePresentation; } })} />以团队增益背景显示（需要精确时间和正时长）</label>}<label>持续秒数<NullableNumber value={directive.durationMs} scale={1000} onChange={(value) => update((item) => { item.durationMs = value; })} /></label>{directive.kind === "task" && <><label>执行者<TargetEditor target={directive.assignees} plan={plan} onChange={(target) => update((item) => { if (item.kind === "task") item.assignees = target; })} /></label></>}<button className="danger-button" onClick={() => mutate((draft) => { draft.timeline.directives = draft.timeline.directives.filter((item) => item.id !== directive.id); })}>删除{directive.kind === "task" ? "任务" : "说明"}</button></div>;
}

function MechanicInspector({ plan, occurrence, definition, mutate }: { plan: RaidPlanDocument; occurrence: MechanicOccurrence; definition: MechanicDefinitionSnapshot; mutate: MutatePlan }) {
  function updateOccurrence(fn: (item: MechanicOccurrence) => void) { mutate((draft) => { const item = draft.timeline.mechanics.find((entry) => entry.id === occurrence.id); if (item) fn(item); }); }
  function updateDefinition(fn: (item: MechanicDefinitionSnapshot) => void) { mutate((draft) => { const item = draft.definitions.mechanics.find((entry) => entry.id === definition.id); if (item) { fn(item); item.dataStatus = "custom"; item.verification = undefined; } }); }
  const castTimeMs = occurrence.timing?.castTimeMs ?? definition.castTimeMs;
  const durationMs = occurrence.timing?.durationMs ?? definition.durationMs;
  return <div className="inspector"><header><h2>Boss 机制</h2><span>INSTANCE + DEFINITION</span></header><label>名称<input value={definition.name} onChange={(event) => updateDefinition((item) => { item.name = event.target.value; })} /></label>{occurrence.displayLabel && <label>本次状态<span className="readonly-field">{occurrence.displayLabel}</span></label>}<label>说明<textarea rows={4} value={definition.description} onChange={(event) => updateDefinition((item) => { item.description = event.target.value; })} /></label><AnchorEditor plan={plan} anchor={occurrence.anchor} onChange={(anchor) => updateOccurrence((item) => { item.anchor = anchor; })} /><div className="field-grid"><label>施法秒数<NullableNumber value={castTimeMs} scale={1000} onChange={(value) => updateOccurrence((item) => { item.timing = { castTimeMs: value ?? 0, durationMs: item.timing?.durationMs ?? definition.durationMs ?? 0 }; })} /></label><label>持续秒数<NullableNumber value={durationMs} scale={1000} onChange={(value) => updateOccurrence((item) => { item.timing = { castTimeMs: item.timing?.castTimeMs ?? definition.castTimeMs ?? 0, durationMs: value ?? 0 }; })} /></label></div><MechanicPresentationEditor value={definition.timelinePresentation} onChange={(value) => updateDefinition((item) => { item.timelinePresentation = value; })} /><p className="field-note">编辑共享定义会影响计划内所有引用实例。如需独立差异，请先复制为新定义。</p><button onClick={() => mutate((draft) => { const copy = structuredClone(definition); copy.id = makeId(); copy.name = `${copy.name}（副本）`; copy.dataStatus = "custom"; delete copy.origin; delete copy.verification; draft.definitions.mechanics.push(copy); const item = draft.timeline.mechanics.find((entry) => entry.id === occurrence.id); if (item) item.definitionId = copy.id; })}>复制为独立定义</button><button className="danger-button" onClick={() => { if (!confirm(`删除机制“${definition.name}”？`)) return; mutate(draft => { draft.timeline.mechanics = draft.timeline.mechanics.filter(item => item.id !== occurrence.id); if (!draft.timeline.mechanics.some(item => item.definitionId === definition.id)) draft.definitions.mechanics = draft.definitions.mechanics.filter(item => item.id !== definition.id); }); }}>删除机制实例</button></div>;
}

function AssignmentInspector({ plan, assignment, skill, library, conflicts, mutate }: { plan: RaidPlanDocument; assignment: SkillAssignment; skill?: PlayerSkillDefinition; library: readonly PlayerSkillDefinition[]; conflicts: ConflictWarning[]; mutate: MutatePlan }) {
  const member = plan.roster.members.find(item => item.id === assignment.memberId);
  function update(fn: (item: SkillAssignment) => void) { mutate(draft => { const item = draft.timeline.skillAssignments.find(entry => entry.id === assignment.id); if (item) fn(item); }); }
  const compatible = member ? cooldownsForMember([...library], member) : library;
  const options = skill && !compatible.some(item => item.id === skill.id) ? [skill, ...compatible] : compatible;
  return <div className="inspector">
    <header><h2>技能安排</h2><span>{skill ? skillDataStatusLabel(skill.dataStatus) : "技能已不存在"}</span></header>
    {conflicts.map(item => <div className="warning-box" key={item.message}>{item.message}</div>)}
    <label>成员<select value={assignment.memberId} onChange={event => update(item => { const self = skillTargetMode(item.targets, item.memberId) === "self"; item.memberId = event.target.value; if (self) item.targets = skillTargetsForMode("self", item.memberId); })}>
      {!member && <option value={assignment.memberId} disabled>成员已不存在，请重新选择</option>}
      {plan.roster.members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <label>技能<select value={assignment.skillDefinitionId} onChange={event => update(item => { item.skillDefinitionId = event.target.value; delete item.observedDurationMs; const next = library.find(entry => entry.id === item.skillDefinitionId); if (next) item.targets = defaultSkillTargets(next, item.memberId); })}>
      {!skill && <option value={assignment.skillDefinitionId} disabled>技能已不存在，请重新选择</option>}
      {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <AnchorEditor plan={plan} anchor={assignment.anchor} onChange={anchor => update(item => { item.anchor = anchor; })} />
    <label>目标<SkillTargetEditor target={assignment.targets} memberId={assignment.memberId} onChange={target => update(item => { item.targets = target; })} /></label>
    <details key={assignment.id} className="assignment-note-editor" open={assignment.note ? true : undefined}><summary>备注</summary><textarea aria-label="备注" value={assignment.note} onChange={event => update(item => { item.note = event.target.value; })} /></details>
    {skill && <section className="skill-detail-section"><b>技能效果</b><p>{skillEffectText(skill)}</p><small>{skillTimingSummary(skill)}</small></section>}
    <button className="danger-button" onClick={() => mutate(draft => { draft.timeline.skillAssignments = draft.timeline.skillAssignments.filter(item => item.id !== assignment.id); }, null)}>删除技能安排</button>
  </div>;
}

function SkillInspector({ skill }: { skill: PlayerSkillDefinition }) {
  return <div className="inspector readonly-inspector">
    <header><h2>{skill.name}</h2><span>{skillDataStatusLabel(skill.dataStatus)}</span></header>
    <label>技能效果<span className="readonly-field">{skillEffectText(skill)}</span></label>
    <label>技能时间<span className="readonly-field">{skillTimingSummary(skill)}</span></label>
    <label>施法类型<span className="readonly-field">{castTypeLabels[skill.castType]}</span></label>
  </div>;
}
