"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Inspector JSX edits heterogeneous v2 unions in-place; runtime documents are normalized before use. */
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim loads a second React instance in the client bundle. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cooldownsForClass,
  specializationFor,
  specializationsForClass,
  WOW_CLASS_COLORS,
  WOW_CLASS_LABELS,
} from "@/lib/cooldowns";
import {
  ALL_TARGETS, INHERIT_TARGETS, defaultAssignmentStart, detectConflicts,
  exportMrtNote, formatTime, makeId, mechanicImpactMs,
  normalizePlanDocument, parseTime, snapTime, syncLinkedAssignments,
} from "@/lib/core";
import type { ConflictWarning } from "@/lib/core";
import { catalogDifference, SEED_CATALOG } from "@/lib/catalog";
import { hashPlanDocument } from "@/lib/hashing";
import { randomBase62 } from "@/lib/publication-ids";
import type { ApiError, CatalogRelease, CooldownDefinition, LocalPlanRecord, PlanSnapshot, PublicPublication, PublicationBinding, RaidAssignment, RaidMechanic, RaidPhase, RaidPlanDocument, RaidTimelineNote, RosterMember, TargetSelection } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView, type TimelineSelectionKey } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { cacheCatalog, createLocalPlan, createPlanSnapshot, getCachedCatalog, getLocalPlan, listPlanSnapshots, LocalRevisionConflictError, saveLocalPlan, setPlanPublication } from "./local-store";

type TimelineObjectSelection = { type: "mechanic" | "assignment" | "phase" | "note"; id: string };
type Selection = TimelineObjectSelection | { type: "member" | "cooldown"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type PanelMode = "object" | "skills" | "history" | "checks" | "catalog";
const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;

function clonePlan(plan: RaidPlanDocument) { return structuredClone(plan); }
function currentTimestamp() { return Date.now(); }

function TimeField({ value, onCommit, label = "时间" }: { value: number; onCommit: (value: number) => void; label?: string }) {
  const [draft, setDraft] = useState(formatTime(value));
  useEffect(() => {
    const timer = setTimeout(() => setDraft(formatTime(value)), 0);
    return () => clearTimeout(timer);
  }, [value]);
  function commit() { const parsed = parseTime(draft); if (parsed == null) setDraft(formatTime(value)); else onCommit(parsed); }
  return <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function NullableNumber({ value, onChange, scale = 1, min = 0, placeholder = "未设置" }: { value: number | null; onChange: (value: number | null) => void; scale?: number; min?: number; placeholder?: string }) {
  return <input type="number" min={min} placeholder={placeholder} value={value == null ? "" : value / scale} onChange={(event) => onChange(event.target.value === "" ? null : Math.max(min, Number(event.target.value)) * scale)} />;
}

function TargetEditor({ target, plan, allowInherit, onChange }: { target: TargetSelection; plan: RaidPlanDocument; allowInherit?: boolean; onChange: (target: TargetSelection) => void }) {
  const modes = [...(allowInherit ? [{ value: "inherit", label: "跟随机制" }] : []), { value: "all", label: "全团" }, { value: "groups", label: "自定义分组" }, { value: "roles", label: "职责" }, { value: "members", label: "具体成员" }];
  function toggle(key: "groupIds" | "roles" | "memberIds", value: string) {
    const current = new Set((target[key] ?? []) as string[]);
    if (current.has(value)) current.delete(value); else current.add(value);
    onChange({ ...target, [key]: [...current] });
  }
  return <div className="target-editor"><select value={target.mode} onChange={(event) => onChange({ mode: event.target.value as TargetSelection["mode"] })}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}</select>
    {target.mode === "groups" && <div className="check-grid">{plan.groups.map((group) => <label key={group.id}><input type="checkbox" checked={target.groupIds?.includes(group.id) ?? false} onChange={() => toggle("groupIds", group.id)} />{group.name}</label>)}</div>}
    {target.mode === "roles" && <div className="check-grid">{Object.entries(roleLabels).map(([role, label]) => <label key={role}><input type="checkbox" checked={target.roles?.includes(role as keyof typeof roleLabels) ?? false} onChange={() => toggle("roles", role)} />{label}</label>)}</div>}
    {target.mode === "members" && <div className="check-grid">{plan.roster.map((member) => <label key={member.id}><input type="checkbox" checked={target.memberIds?.includes(member.id) ?? false} onChange={() => toggle("memberIds", member.id)} />{member.name}</label>)}</div>}
  </div>;
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
  const [skillClassSlug, setSkillClassSlug] = useState("");
  const [skillMemberId, setSkillMemberId] = useState("");
  const [skillInsertionMs, setSkillInsertionMs] = useState(0);
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [zoom, setZoom] = useState(1);
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
      if (cancelled) return;
      try {
        const [local, localSnapshots, cached] = await Promise.all([getLocalPlan(planId), listPlanSnapshots(planId), getCachedCatalog()]);
        if (!local) throw new Error("这条本地轴不存在，可能已被删除或属于另一台设备。");
        const document = normalizePlanDocument(local.document);
        setRecord({ ...local, document }); setPlan(document); planRef.current = document;
        setLocalRevision(local.localRevision); localRevisionRef.current = local.localRevision;
        setSnapshots(localSnapshots); setSaveState("saved");
        if (cached) setCatalog(cached);
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("plan", planId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number; leftCollapsed?: boolean } | null;
        const mobile = innerWidth < 720;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(Math.max(1, view?.zoom ?? 1)); setLeftCollapsed(view?.leftCollapsed ?? mobile);
        setViewReady(true);
        fetch("/api/catalog/current").then(async (response) => {
          const payload = await response.json() as { data?: CatalogRelease };
          if (response.ok && payload.data) { await cacheCatalog(payload.data); if (!cancelled) setCatalog(payload.data); }
        }).catch(() => undefined);
      } catch (error) {
        if (!cancelled) setFatal(error instanceof Error ? error.message : "读取本地计划失败");
      }
    });
    return () => { cancelled = true; };
  }, [planId]);

  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("plan", planId, viewWidth), JSON.stringify({ orientation, zoom, leftCollapsed })); }, [leftCollapsed, orientation, planId, viewReady, viewWidth, zoom]);

  function mutate(mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) {
    setPlan((current) => {
      if (!current) return current;
      undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)]; redoStack.current = [];
      const counts = [current.roster.length, current.groups.length, current.mechanics.length, current.cooldowns.length, current.assignments.length, current.phases.length, current.timelineNotes.length];
      const next = clonePlan(current); mutator(next);
      const destructive = [next.roster.length, next.groups.length, next.mechanics.length, next.cooldowns.length, next.assignments.length, next.phases.length, next.timelineNotes.length].some((value, index) => value < counts[index]);
      if (destructive) createPlanSnapshot(planId, "destructive", current, localRevisionRef.current).then(() => listPlanSnapshots(planId).then(setSnapshots)).catch((error) => setToast(error instanceof Error ? error.message : "建立检查点失败"));
      const normalized = normalizePlanDocument(next); planRef.current = normalized; return normalized;
    });
    editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: false });
    setSaveState("dirty"); if (nextSelection !== undefined) setSelection(nextSelection);
  }

  function replacePlan(next: RaidPlanDocument) {
    if (plan) undoStack.current = [...undoStack.current.slice(-49), clonePlan(plan)];
    redoStack.current = []; editRevision.current += 1; setHistoryState({ canUndo: Boolean(plan), canRedo: false }); const normalized = normalizePlanDocument(next); planRef.current = normalized; setPlan(normalized); setSelection(null); setSaveState("dirty");
  }

  function undo() { const previous = undoStack.current.pop(); if (!previous || !plan) return; redoStack.current.push(clonePlan(plan)); editRevision.current += 1; setHistoryState({ canUndo: undoStack.current.length > 0, canRedo: true }); planRef.current = previous; setPlan(previous); setSaveState("dirty"); }
  function redo() { const next = redoStack.current.pop(); if (!next || !plan) return; undoStack.current.push(clonePlan(plan)); editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: redoStack.current.length > 0 }); planRef.current = next; setPlan(next); setSaveState("dirty"); }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault(); if (event.shiftKey) redo(); else undo();
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!plan || saveState !== "dirty" || conflict) return;
    const captured = plan;
    const capturedRevision = editRevision.current;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const saved = await saveLocalPlan(planId, captured, localRevisionRef.current);
        localRevisionRef.current = saved.localRevision; setLocalRevision(saved.localRevision); setRecord(saved);
        setSaveState(editRevision.current === capturedRevision ? "saved" : "dirty");
      } catch (error) {
        if (error instanceof LocalRevisionConflictError) { setConflict(error.latest); setSaveState("conflict"); }
        else { setSaveState("error"); setToast(error instanceof Error ? error.message : "本地保存失败"); }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [conflict, plan, planId, saveState]);

  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    hashPlanDocument(plan).then((hash) => { if (!cancelled) setCurrentHash(hash); });
    return () => { cancelled = true; };
  }, [plan]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = planRef.current;
      if (!current) return;
      createPlanSnapshot(planId, "minute", current, localRevisionRef.current).then(() => listPlanSnapshots(planId).then(setSnapshots)).catch((error) => setToast(error instanceof Error ? error.message : "分钟检查点保存失败"));
    }, 60_000);
    return () => clearInterval(timer);
  }, [planId]);

  useEffect(() => {
    const element = timelineRef.current; if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const pointerInTimeline = event.target instanceof Node && element.contains(event.target);
      if (!shouldInterceptTimelineWheel(event.ctrlKey, pointerInTimeline)) return;
      event.preventDefault();
      setZoom((current) => {
        const next = zoomFromWheel(current, event.deltaY); const rect = element.getBoundingClientRect();
        if (orientation === "horizontal") element.scrollLeft = anchoredScroll(element.scrollLeft, event.clientX - rect.left, current, next);
        else element.scrollTop = anchoredScroll(element.scrollTop, event.clientY - rect.top, current, next);
        return next;
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false }); return () => element.removeEventListener("wheel", onWheel);
  }, [orientation]);

  const warnings = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);
  const warningIds = useMemo(() => new Set(warnings.flatMap((item) => item.assignmentId ? [item.assignmentId] : [])), [warnings]);
  const classCooldowns = useMemo(() => cooldownsForClass(plan?.cooldowns ?? [], skillClassSlug), [plan?.cooldowns, skillClassSlug]);

  if (fatal) return <main className="state-page"><div className="state-card"><h1>无法打开编辑器</h1><p>{fatal}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !record) return <main className="state-page"><p>正在读取本地计划…</p></main>;
  const activePlan = plan;
  const activeRecord = record;

  const selectedMember = selection?.type === "member" ? plan.roster.find((item) => item.id === selection.id) : null;
  const selectedMechanic = selection?.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : null;
  const selectedPhase = selection?.type === "phase" ? plan.phases.find((item) => item.id === selection.id) : null;
  const selectedNote = selection?.type === "note" ? plan.timelineNotes.find((item) => item.id === selection.id) : null;
  const selectedCooldownDirect = selection?.type === "cooldown" ? plan.cooldowns.find((item) => item.id === selection.id) : null;
  const selectedAssignment = selection?.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : null;
  const selectedCooldown = selectedCooldownDirect ?? (selectedAssignment ? plan.cooldowns.find((item) => item.id === selectedAssignment.cooldownId) : null);
  function addMember() {
    const id = makeId("member");
    mutate((draft) => draft.roster.push({ id, name: `成员 ${String(draft.roster.length + 1).padStart(2, "0")}`, classSlug: "", specSlug: "", role: "damage", color: "#7b8490" }), { type: "member", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addMechanic(atMs = 30_000) {
    const id = makeId("mechanic"); mutate((draft) => draft.mechanics.push({ id, name: "新机制", description: "", atMs: snapTime(atMs), castTimeMs: 0, durationMs: 0, damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false }, targets: structuredClone(ALL_TARGETS), severity: "warning", source: "manual", note: "" }), { type: "mechanic", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addPhase(atMs: number) {
    const id = makeId("phase"); mutate((draft) => draft.phases.push({ id, name: `P${draft.phases.length + 1}`, atMs: snapTime(atMs) }), { type: "phase", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addTimelineNote(atMs: number) {
    const id = makeId("note"); mutate((draft) => draft.timelineNotes.push({ id, text: "新注释", atMs: snapTime(atMs) }), { type: "note", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addCustomSkill() {
    if (!skillClassSlug) { setToast("请先选择职业"); return; }
    const id = makeId("custom-spell"); const classSlug = skillClassSlug;
    mutate((draft) => draft.cooldowns.push({ id, name: "自定义技能", description: "", classSlug, specSlugs: [], scope: "team", cooldownMs: null, castTimeMs: null, durationMs: null, triggersGcd: null, maxTargets: null, effects: [], category: "自定义", color: WOW_CLASS_COLORS[classSlug], catalogVersion: "custom", dataStatus: "custom" }), { type: "cooldown", id });
    setPanelMode("object");
  }
  function addAssignment(cooldownId: string) {
    const cooldown = activePlan.cooldowns.find((item) => item.id === cooldownId); if (!cooldown) return;
    const timelineMember = activePlan.roster.find((item) => item.id === skillMemberId && item.classSlug === cooldown.classSlug);
    const selectedAssignmentMember = selectedAssignment ? activePlan.roster.find((item) => item.id === selectedAssignment.memberId) : null;
    const preferredMember = selectedMember?.classSlug === cooldown.classSlug ? selectedMember : selectedAssignmentMember?.classSlug === cooldown.classSlug ? selectedAssignmentMember : null;
    const member = timelineMember ?? preferredMember ?? activePlan.roster.find((item) => item.classSlug === cooldown.classSlug);
    if (!member) { setToast(`先为至少一名成员选择${WOW_CLASS_LABELS[cooldown.classSlug] ?? "对应"}职业`); return; }
    const mechanic = selectedMechanic ?? (selectedAssignment?.mechanicId ? activePlan.mechanics.find((item) => item.id === selectedAssignment.mechanicId) : null);
    const id = makeId("assignment"); const atMs = mechanic ? defaultAssignmentStart(activePlan, cooldown, mechanic) : snapTime(skillInsertionMs);
    mutate((draft) => draft.assignments.push({ id, memberId: member.id, cooldownId, ...(mechanic ? { mechanicId: mechanic.id, offsetMs: atMs - mechanicImpactMs(mechanic) } : {}), atMs, targets: cooldown.scope === "personal" ? { mode: "members", memberIds: [member.id] } : mechanic ? structuredClone(INHERIT_TARGETS) : structuredClone(ALL_TARGETS), note: "", source: "manual" }), { type: "assignment", id });
    setPanelMode("object");
  }
  function moveAssignment(id: string, atMs: number) {
    mutate((draft) => { const item = draft.assignments.find((entry) => entry.id === id); if (!item) return; item.atMs = snapTime(atMs); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); }, { type: "assignment", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function moveMechanic(id: string, atMs: number) {
    mutate((draft) => {
      const item = draft.mechanics.find((entry) => entry.id === id);
      if (!item) return;
      item.atMs = snapTime(atMs);
      syncLinkedAssignments(draft, item.id);
    }, { type: "mechanic", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function movePhase(id: string, atMs: number) {
    mutate((draft) => { const item = draft.phases.find((entry) => entry.id === id); if (item) item.atMs = snapTime(atMs); }, { type: "phase", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function moveTimelineNote(id: string, atMs: number) {
    mutate((draft) => { const item = draft.timelineNotes.find((entry) => entry.id === id); if (item) item.atMs = snapTime(atMs); }, { type: "note", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function openMemberSkills(memberId: string, atMs = 0) {
    const member = activePlan.roster.find((item) => item.id === memberId);
    if (!member) return;
    setSelection({ type: "member", id: member.id });
    if (!member.classSlug) {
      setPanelMode("object"); setLeftCollapsed(false);
      setToast("请先为该成员选择职业和专精");
      return;
    }
    setSkillMemberId(member.id);
    setSkillClassSlug(member.classSlug);
    setSkillInsertionMs(atMs);
    setPanelMode("skills");
    setLeftCollapsed(false);
  }

  async function copyText(value: string, message: string) { await navigator.clipboard.writeText(value); setToast(message); }

  async function refreshSnapshots() { setSnapshots(await listPlanSnapshots(planId)); }

  async function upgradeCatalog() {
    const appliedAt = currentTimestamp();
    const difference = catalogDifference(activePlan, catalog);
    if (difference.addedSkills + difference.changedSkills + difference.removedSkills === 0) { setToast("当前计划已使用最新技能目录"); return; }
    if (!confirm(`升级到目录 ${difference.availableVersion}？将更新目录技能，机制快照不会自动改变。`)) return;
    await createPlanSnapshot(planId, "catalog-upgrade", activePlan, localRevisionRef.current);
    const next = clonePlan(activePlan);
    const custom = next.cooldowns.filter((item) => item.dataStatus === "custom" || item.id.startsWith("custom-"));
    const customIds = new Set(custom.map((item) => item.id));
    next.cooldowns = [...catalog.playerSkills.filter((item) => item.enabled && !customIds.has(item.id)).map((item) => { const { enabled: _enabled, gameVersion: _gameVersion, ...skill } = item; void _enabled; void _gameVersion; return structuredClone(skill); }), ...custom];
    next.catalogSource = { version: catalog.manifest.version, appliedAt };
    replacePlan(next); setPanelMode("object"); await refreshSnapshots(); setToast("技能目录已升级；旧机制和时间轴保持不变");
  }

  async function confirmPublication(shareId: string, editId: string, expectedHash: string) {
    const response = await fetch(`/api/publications/${shareId}`);
    const payload = await response.json() as { data?: PublicPublication };
    if (!response.ok || payload.data?.contentHash !== expectedHash) return null;
    const data = payload.data;
    return { shareId, editId, revisionId: data.revisionId, publishedAt: data.publishedAt, contentHash: data.contentHash } satisfies PublicationBinding;
  }

  async function publish(mode: "new" | "overwrite") {
    const captured = clonePlan(activePlan);
    const capturedHash = await hashPlanDocument(captured);
    let shareId = mode === "overwrite" ? activeRecord.activePublication?.shareId ?? "" : randomBase62(16);
    let editId = mode === "overwrite" ? activeRecord.activePublication?.editId ?? "" : randomBase62(4);
    if (!shareId || !editId) { setToast("当前计划还没有可覆盖的发布链接"); return; }
    setPublishing(mode); setToast("");
    try {
      await createPlanSnapshot(planId, "publish", captured, localRevisionRef.current);
      let binding: PublicationBinding | null = null;
      for (let attempt = 0; attempt < 3 && !binding; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetch(mode === "overwrite" ? `/api/publications/${shareId}/${editId}` : "/api/publications", {
            method: mode === "overwrite" ? "PUT" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ document: captured, ...(mode === "new" ? { shareId, editId } : {}) }),
            signal: controller.signal,
          });
          const payload = await response.json() as { data?: PublicPublication & { editId: string; binding: PublicationBinding }; error?: ApiError };
          if (response.status === 409 && mode === "new") { shareId = randomBase62(16); editId = randomBase62(4); continue; }
          if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "发布失败");
          binding = payload.data.binding;
        } catch (error) {
          binding = await confirmPublication(shareId, editId, capturedHash);
          if (!binding) throw error;
        } finally { clearTimeout(timeout); }
      }
      if (!binding) throw new Error("发布失败，请重试");
      const linked = await setPlanPublication(planId, binding, localRevisionRef.current);
      localRevisionRef.current = linked.localRevision; setLocalRevision(linked.localRevision);
      setRecord({ ...linked, document: planRef.current ?? linked.document });
      await refreshSnapshots();
      const latestHash = planRef.current ? await hashPlanDocument(planRef.current) : capturedHash;
      setCurrentHash(latestHash);
      setToast(latestHash === binding.contentHash ? "服务器版本已发布" : "快照已发布；发布期间的新修改仍只在本地");
    } catch (error) {
      if (error instanceof LocalRevisionConflictError) { setConflict(error.latest); setSaveState("conflict"); setToast("服务器快照已发布，但另一标签页已更新本地轴；请先处理本地冲突"); }
      else setToast(error instanceof Error ? error.message : "发布失败");
    }
    finally { setPublishing(""); }
  }

  async function removePublication() {
    const binding = activeRecord.activePublication;
    if (!binding || !confirm("删除当前服务器发布？本地工作副本会保留，但原链接将立即失效。")) return;
    setPublishing("delete");
    try {
      const response = await fetch(`/api/publications/${binding.shareId}/${binding.editId}`, { method: "DELETE" });
      const payload = await response.json() as { error?: ApiError };
      if (!response.ok) throw new Error(payload.error?.message ?? "删除失败");
      const unlinked = await setPlanPublication(planId, undefined, localRevisionRef.current);
      localRevisionRef.current = unlinked.localRevision; setLocalRevision(unlinked.localRevision); setRecord({ ...unlinked, document: planRef.current ?? unlinked.document });
      setToast("服务器发布已删除，本地轴仍然保留");
    } catch (error) {
      if (error instanceof LocalRevisionConflictError) { setConflict(error.latest); setSaveState("conflict"); setToast("服务器发布已删除，但另一标签页已更新本地轴；请先处理本地冲突"); }
      else setToast(error instanceof Error ? error.message : "删除失败");
    }
    finally { setPublishing(""); }
  }

  function selectTimelineObject(next: TimelineObjectSelection, locate = false) {
    setSelection(next);
    setPanelMode("object");
    setLeftCollapsed(false);
    if (!locate) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const key = `${next.type}:${next.id}`;
      const target = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-timeline-key]") ?? [])]
        .find((element) => element.dataset.timelineKey === key);
      target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }));
  }

  const timelineSelection: TimelineSelectionKey = selection && ["mechanic", "assignment", "phase", "note"].includes(selection.type)
    ? `${selection.type as "mechanic" | "assignment" | "phase" | "note"}:${selection.id}`
    : null;
  const catalogUpdate = catalogDifference(plan, catalog);
  const hasCatalogUpdate = catalogUpdate.addedSkills + catalogUpdate.changedSkills + catalogUpdate.removedSkills > 0;
  const publicationDirty = Boolean(record.activePublication && currentHash && record.activePublication.contentHash !== currentHash);
  return <main className="editor-workspace" data-local-revision={localRevision}>
    <header className="editor-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="plan-name"><input aria-label="计划名称" value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /><span className={`save-state ${saveState}`}>{{ saved: "本地已保存", dirty: "本地待保存", saving: "本地保存中", error: "本地保存失败", conflict: "标签页冲突" }[saveState]}</span><span className={`publication-state ${publicationDirty ? "dirty" : record.activePublication ? "published" : "unpublished"}`}>{record.activePublication ? publicationDirty ? "存在未发布修改" : "服务器已发布" : "尚未发布"}</span></div><div className="header-actions"><button onClick={undo} disabled={!historyState.canUndo}>撤销</button><button onClick={redo} disabled={!historyState.canRedo}>重做</button><button onClick={() => copyText(exportMrtNote(plan), "MRT 已复制")}>MRT</button><details className="header-menu"><summary>工具</summary><div><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanelMode("history"); setLeftCollapsed(false); }}>历史</button>{hasCatalogUpdate && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanelMode("catalog"); setLeftCollapsed(false); }}>查看技能更新</button>}</div></details>{record.activePublication && <><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}`, "只读链接已复制")}>复制分享链接</button><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}/${record.activePublication!.editId}`, "编辑链接已复制")}>复制编辑链接</button><button disabled={Boolean(publishing)} onClick={() => publish("overwrite")}>覆盖当前链接</button></>}<button disabled={Boolean(publishing)} onClick={() => publish("new")}>{record.activePublication ? "发布为新链接" : "发布并创建链接"}</button>{record.activePublication && <button className="danger-link" disabled={Boolean(publishing)} onClick={removePublication}>删除发布</button>}<ThemeControl compact /></div></header>
    {saveState === "conflict" && <div className="conflict-banner"><span>另一个标签页已保存了更新；当前标签页没有覆盖它。</span><button onClick={() => { if (conflict) { const next = normalizePlanDocument(conflict.document); setPlan(next); planRef.current = next; setRecord(conflict); setLocalRevision(conflict.localRevision); localRevisionRef.current = conflict.localRevision; setConflict(null); setSaveState("saved"); } }}>加载较新本地版本</button><button onClick={async () => { const copy = await createLocalPlan(activePlan); location.assign(`/plans/${copy.id}`); }}>将当前内容另存为副本</button></div>}
    <div className={`editor-table-grid ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`left-table-panel context-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <>
        {panelMode === "skills" && <div className="panel-body skill-picker"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>选择技能</b></header><p className="skill-target">分配给：<b>{plan.roster.find((member) => member.id === skillMemberId)?.name}</b><small>{formatTime(skillInsertionMs)} 附近</small></p><button className="secondary-action" onClick={addCustomSkill}>＋ 添加自定义技能</button><div className="skill-list">{classCooldowns.map((cooldown) => <div key={cooldown.id} title={cooldown.description || "暂无说明"}><button onClick={() => { setSelection({ type: "cooldown", id: cooldown.id }); setPanelMode("object"); }}><i style={{ background: cooldown.color }} /><span><strong>{cooldown.name}</strong><small>{cooldown.category} · {cooldown.durationMs == null ? "持续待补" : `${cooldown.durationMs / 1000}s`}</small></span></button><button onClick={() => addAssignment(cooldown.id)} title={`分配 ${cooldown.name}`} aria-label={`分配 ${cooldown.name}`}>＋</button></div>)}{!classCooldowns.length && <p className="table-empty">该职业暂无目录技能，可创建自定义技能。</p>}</div></div>}
        {panelMode === "history" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>历史检查点</b></header><div className="snapshot-list">{snapshots.slice(0, 30).map((snapshot) => <button key={snapshot.id} onClick={async () => { if (!confirm(`恢复 ${new Date(snapshot.createdAt).toLocaleString("zh-CN")} 的检查点？`)) return; await createPlanSnapshot(planId, "destructive", activePlan, localRevisionRef.current); replacePlan(snapshot.document); setPanelMode("object"); await refreshSnapshots(); }}><span>{new Date(snapshot.createdAt).toLocaleString("zh-CN")}</span><small>{{ minute: "自动", publish: "发布前", preset: "预设前", "catalog-upgrade": "目录升级前", destructive: "操作前", manual: "手动" }[snapshot.reason]}</small></button>)}{!snapshots.length && <p className="table-empty">尚无可恢复的检查点。</p>}</div></div>}
        {panelMode === "checks" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>排轴检查</b></header><Checks warnings={warnings} onSelect={(next) => selectTimelineObject(next, true)} /></div>}
        {panelMode === "catalog" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>技能目录更新</b></header><div className="catalog-summary"><p>新增 {catalogUpdate.addedSkills} 项，更新 {catalogUpdate.changedSkills} 项，移除 {catalogUpdate.removedSkills} 项。</p><small>只更新内置技能；自定义技能、机制和分配保持不变。</small><button className="primary-action" onClick={upgradeCatalog}>确认升级</button></div></div>}
        {panelMode === "object" && <Inspector plan={plan} selection={selection} selectedMember={selectedMember} selectedMechanic={selectedMechanic} selectedPhase={selectedPhase} selectedNote={selectedNote} selectedCooldown={selectedCooldown} selectedAssignment={selectedAssignment} warnings={warnings} mutate={mutate} />}
      </>}</aside>
      <section className="timeline-work-panel">
        <div className="axis-toolbar"><strong>时间轴</strong><div><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div>
        <div className="axis-scroll" ref={timelineRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView plan={plan} orientation={orientation} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} warningIds={warningIds} onSelect={(key) => { if (!key) return; const [type,id] = key.split(":"); selectTimelineObject({ type: type as TimelineObjectSelection["type"], id }); }} onSelectMember={(id) => { setSelection({ type: "member", id }); setPanelMode("object"); setLeftCollapsed(false); }} onOpenMemberSkills={openMemberSkills} onAddMember={addMember} onAddPhase={addPhase} onAddTimelineNote={addTimelineNote} onAddMechanic={addMechanic} onMovePhase={movePhase} onMoveTimelineNote={moveTimelineNote} onMoveMechanic={moveMechanic} onMoveAssignment={moveAssignment} /></div>
        <div className="axis-statusbar"><span>Ctrl + 滚轮缩放 · 拖动对象调整时间 · 左侧显示当前对象</span><button className={warnings.length ? "warn" : "ok"} onClick={() => { setPanelMode("checks"); setLeftCollapsed(false); }}>{warnings.length ? `${warnings.length} 项提醒` : "检查通过"}</button></div>
      </section>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </main>;
}

type MutatePlan = (mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) => void;

interface InspectorProps {
  plan: RaidPlanDocument;
  selection: Selection;
  selectedMember: RosterMember | null | undefined;
  selectedMechanic: RaidMechanic | null | undefined;
  selectedPhase: RaidPhase | null | undefined;
  selectedNote: RaidTimelineNote | null | undefined;
  selectedCooldown: CooldownDefinition | null | undefined;
  selectedAssignment: RaidAssignment | null | undefined;
  warnings: ConflictWarning[];
  mutate: MutatePlan;
}

function Inspector({ plan, selection, selectedMember, selectedMechanic, selectedPhase, selectedNote, selectedCooldown, selectedAssignment, warnings, mutate }: InspectorProps) {
  const updateMechanic = (fn: (item: any) => void) => mutate((draft) => { const item = draft.mechanics.find((entry) => entry.id === selectedMechanic?.id); if (item) { fn(item); syncLinkedAssignments(draft, item.id); } });
  const updateCooldown = (fn: (item: CooldownDefinition) => void) => mutate((draft: RaidPlanDocument) => { const item = draft.cooldowns.find((entry) => entry.id === selectedCooldown?.id); if (item) { fn(item); item.dataStatus = "custom"; if (item.scope === "personal") { item.maxTargets = 1; for (const assignment of draft.assignments.filter((entry) => entry.cooldownId === item.id)) assignment.targets = { mode: "members", memberIds: [assignment.memberId] }; } } });
  if (!selection) return <div className="context-empty"><b>选择时间轴对象</b><p>点击右侧的成员、技能、机制、阶段或注释，在这里查看和编辑。</p></div>;
  if (selectedMember) {
    const specializations = specializationsForClass(selectedMember.classSlug);
    const knownSpecialization = specializationFor(selectedMember.classSlug, selectedMember.specSlug);
    const selectedGroup = plan.groups.find((group) => group.id === selectedMember.groupId);
    return <div className="inspector">
      <header><h2>成员</h2><span>RAIDER</span></header>
      <label>角色名<input value={selectedMember.name} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.name = event.target.value; })} /></label>
      <label>职业<select value={selectedMember.classSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) { item.classSlug = event.target.value; item.specSlug = ""; item.role = "damage"; item.color = WOW_CLASS_COLORS[event.target.value] ?? "#7b8490"; } })}><option value="">待选择</option>{Object.entries(WOW_CLASS_LABELS).map(([slug,label]) => <option value={slug} key={slug}>{label}</option>)}</select></label>
      <label>专精<select value={selectedMember.specSlug} disabled={!selectedMember.classSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (!item) return; item.specSlug = event.target.value; item.role = specializationFor(item.classSlug, item.specSlug)?.role ?? "damage"; })}><option value="">待选择专精</option>{selectedMember.specSlug && !knownSpecialization && <option value={selectedMember.specSlug}>{selectedMember.specSlug}（旧专精）</option>}{specializations.map((spec) => <option value={spec.slug} key={spec.slug}>{spec.label}</option>)}</select></label>
      <label>职责<output className="readonly-field">{knownSpecialization ? roleLabels[knownSpecialization.role] : "选择专精后自动匹配"}</output></label>
      <label>自定义分组<select value={selectedMember.groupId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.groupId = event.target.value || undefined; })}><option value="">未分组</option>{plan.groups.map((group: any) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
      <button className="secondary-action" onClick={() => mutate((draft) => { const id = makeId("group"); draft.groups.push({ id, name: `分组 ${draft.groups.length + 1}`, color: "#6f7f91" }); const member = draft.roster.find((item) => item.id === selectedMember.id); if (member) member.groupId = id; })}>＋ 新建并加入分组</button>
      {selectedGroup && <section className="inline-group-editor"><b>当前分组</b><label>名称<input value={selectedGroup.name} onChange={(event) => mutate((draft) => { const group = draft.groups.find((item) => item.id === selectedGroup.id); if (group) group.name = event.target.value; })} /></label><label>标识色<input type="color" value={selectedGroup.color} onChange={(event) => mutate((draft) => { const group = draft.groups.find((item) => item.id === selectedGroup.id); if (group) group.color = event.target.value; })} /></label><button className="danger-link" onClick={() => { if (!confirm(`删除分组“${selectedGroup.name}”？成员会变为未分组。`)) return; mutate((draft) => { draft.groups = draft.groups.filter((item) => item.id !== selectedGroup.id); draft.roster.forEach((member) => { if (member.groupId === selectedGroup.id) member.groupId = undefined; }); }); }}>删除分组</button></section>}
      <button className="danger-button" onClick={() => { if (confirm(`删除成员“${selectedMember.name}”及其分配？`)) mutate((draft: RaidPlanDocument) => { draft.roster = draft.roster.filter((entry) => entry.id !== selectedMember.id); draft.assignments = draft.assignments.filter((entry) => entry.memberId !== selectedMember.id); }, null); }}>删除成员</button>
    </div>;
  }
  if (selectedPhase) return <div className="inspector"><header><h2>阶段</h2><span>PHASE</span></header><label>名称<input value={selectedPhase.name} onChange={(event) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === selectedPhase.id); if (item) item.name = event.target.value; })} /></label><label>时间点<TimeField value={selectedPhase.atMs} onCommit={(value) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === selectedPhase.id); if (item) item.atMs = snapTime(value); })} /></label><button className="danger-button" onClick={() => mutate((draft) => { draft.phases = draft.phases.filter((entry) => entry.id !== selectedPhase.id); draft.mechanics.forEach((item) => { if (item.phaseId === selectedPhase.id) item.phaseId = undefined; }); }, null)}>删除阶段</button></div>;
  if (selectedNote) return <div className="inspector"><header><h2>注释</h2><span>NOTE</span></header><label>内容<textarea rows={8} value={selectedNote.text} onChange={(event) => mutate((draft) => { const item = draft.timelineNotes.find((entry) => entry.id === selectedNote.id); if (item) item.text = event.target.value; })} /></label><label>时间点<TimeField value={selectedNote.atMs} onCommit={(value) => mutate((draft) => { const item = draft.timelineNotes.find((entry) => entry.id === selectedNote.id); if (item) item.atMs = snapTime(value); })} /></label><p className="field-note">注释已保存到时间轴；MRT 输出格式将在后续单独确定。</p><button className="danger-button" onClick={() => mutate((draft) => { draft.timelineNotes = draft.timelineNotes.filter((entry) => entry.id !== selectedNote.id); }, null)}>删除注释</button></div>;
  if (selectedMechanic) return <div className="inspector">
    <header><h2>机制</h2><span>MECHANIC</span></header>
    <label>名称<input value={selectedMechanic.name} onChange={(event) => updateMechanic((item) => { item.name = event.target.value; })} /></label>
    <label>说明<textarea rows={4} value={selectedMechanic.description} onChange={(event) => updateMechanic((item) => { item.description = event.target.value; })} /></label>
    <div className="field-grid"><label>时间点<TimeField value={selectedMechanic.atMs} onCommit={(value) => updateMechanic((item) => { item.atMs = snapTime(value); })} /></label><label>严重度<select value={selectedMechanic.severity} onChange={(event) => updateMechanic((item) => { item.severity = event.target.value as RaidMechanic["severity"]; })}><option value="info">提示</option><option value="warning">警告</option><option value="danger">致命</option></select></label></div>
    <div className="field-grid"><label>施法秒数<NullableNumber value={selectedMechanic.castTimeMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.castTimeMs = value; })} /></label><label>持续秒数<NullableNumber value={selectedMechanic.durationMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.durationMs = value; })} /></label></div>
    <label>所属阶段<select value={selectedMechanic.phaseId ?? ""} onChange={(event) => updateMechanic((item) => { item.phaseId = event.target.value || undefined; })}><option value="">未指定</option>{plan.phases.map((phase) => <option value={phase.id} key={phase.id}>{formatTime(phase.atMs)} {phase.name}</option>)}</select></label>
    <label>伤害类型<select value={selectedMechanic.damage.school} onChange={(event) => updateMechanic((item) => { item.damage.school = event.target.value as RaidMechanic["damage"]["school"]; })}><option value="magic">魔法</option><option value="physical">物理</option></select></label>
    <div className="field-grid"><label>直接伤害<NullableNumber value={selectedMechanic.damage.directAmount} onChange={(value) => updateMechanic((item) => { item.damage.directAmount = value; })} /></label><label>周期伤害<NullableNumber value={selectedMechanic.damage.periodicAmount} onChange={(value) => updateMechanic((item) => { item.damage.periodicAmount = value; })} /></label></div>
    <div className="field-grid"><label>周期秒数<NullableNumber value={selectedMechanic.damage.periodicIntervalMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.damage.periodicIntervalMs = value; })} /></label><label className="inline-check"><input type="checkbox" checked={selectedMechanic.damage.tickOnStart} onChange={(event) => updateMechanic((item) => { item.damage.tickOnStart = event.target.checked; })} />开始时立即跳伤</label></div>
    <label>作用目标<TargetEditor target={selectedMechanic.targets} plan={plan} onChange={(target) => updateMechanic((item) => { item.targets = target; })} /></label>
    <label>备注<textarea value={selectedMechanic.note} onChange={(event) => updateMechanic((item) => { item.note = event.target.value; })} /></label>
    <button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.mechanics = draft.mechanics.filter((entry) => entry.id !== selectedMechanic.id); draft.assignments = draft.assignments.map((entry) => entry.mechanicId === selectedMechanic.id ? { ...entry, mechanicId: undefined, offsetMs: undefined, targets: entry.targets.mode === "inherit" ? structuredClone(ALL_TARGETS) : entry.targets } : entry); }, null)}>删除机制</button>
  </div>;
  if (selectedCooldown && !selectedAssignment) return <SkillInspector cooldown={selectedCooldown} update={updateCooldown} mutate={mutate} />;
  if (selectedAssignment && selectedCooldown) {
    const member = plan.roster.find((item) => item.id === selectedAssignment.memberId);
    const compatibleCooldowns = plan.cooldowns.filter((item) => item.classSlug === member?.classSlug || item.id === selectedAssignment.cooldownId);
    return <div className="inspector"><header><h2>技能分配</h2><span>ASSIGNMENT</span></header><label>成员<select value={selectedAssignment.memberId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.memberId = event.target.value; const nextMember = draft.roster.find((entry) => entry.id === item.memberId); const currentCooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); const firstCompatible = draft.cooldowns.find((entry) => entry.classSlug === nextMember?.classSlug); if (currentCooldown?.classSlug !== nextMember?.classSlug && firstCompatible) item.cooldownId = firstCompatible.id; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{plan.roster.map((entry: any) => <option value={entry.id} key={entry.id}>{entry.name} · {WOW_CLASS_LABELS[entry.classSlug] ?? "待选择职业"}</option>)}</select></label><label>技能<select value={selectedAssignment.cooldownId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.cooldownId = event.target.value; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{compatibleCooldowns.map((cooldown: any) => <option value={cooldown.id} key={cooldown.id}>{cooldown.name}{cooldown.classSlug !== member?.classSlug ? "（旧分配）" : ""}</option>)}</select></label><label>开始施法<TimeField value={selectedAssignment.atMs} onCommit={(value) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.atMs = snapTime(value); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); })} /></label><label>关联机制<select value={selectedAssignment.mechanicId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; const mechanic = draft.mechanics.find((entry) => entry.id === event.target.value); item.mechanicId = mechanic?.id; if (mechanic) { item.atMs = defaultAssignmentStart(draft, selectedCooldown, mechanic); item.offsetMs = item.atMs - mechanicImpactMs(mechanic); item.targets = selectedCooldown.scope === "personal" ? { mode: "members", memberIds: [item.memberId] } : structuredClone(INHERIT_TARGETS); } else { item.offsetMs = undefined; if (item.targets.mode === "inherit") item.targets = structuredClone(ALL_TARGETS); } })}><option value="">自由时间点</option>{plan.mechanics.map((mechanic: any) => <option value={mechanic.id} key={mechanic.id}>{formatTime(mechanic.atMs)} {mechanic.name}</option>)}</select></label>{selectedCooldown.scope === "personal" ? <div className="field-note"><b>实际目标：施放者本人</b><br />个人技能固定作用于当前成员，不能改为其他目标。</div> : <label>实际目标<TargetEditor target={selectedAssignment.targets} plan={plan} allowInherit onChange={(target) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.targets = target; })} /></label>}<label>备注<textarea value={selectedAssignment.note} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.note = event.target.value; })} /></label>{warnings.filter((warning: any) => warning.assignmentId === selectedAssignment.id).map((warning: any, index: number) => <div className="warning-box" key={`${warning.type}-${index}`}>{warning.message}</div>)}<button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.assignments = draft.assignments.filter((entry) => entry.id !== selectedAssignment.id); }, null)}>删除分配</button></div>;
  }
  return <div className="context-empty"><b>对象已不存在</b><p>请在右侧选择其他对象。</p></div>;
}

function SkillInspector({ cooldown, update, mutate }: { cooldown: CooldownDefinition; update: (fn: (item: CooldownDefinition) => void) => void; mutate: MutatePlan }) {
  const status = cooldown.dataStatus === "unconfigured" ? "数值待补" : cooldown.dataStatus === "legacy" ? "旧数据" : "已自定义";
  return <div className="inspector">
    <header><h2>技能定义</h2><span>{status}</span></header>
    <label>名称<input value={cooldown.name} onChange={(event) => update((item) => { item.name = event.target.value; })} /></label>
    <label>简介<textarea value={cooldown.description} onChange={(event) => update((item) => { item.description = event.target.value; })} /></label>
    <div className="field-grid">
      <label>范围<select value={cooldown.scope} onChange={(event) => update((item) => { item.scope = event.target.value as CooldownDefinition["scope"]; if (item.scope === "personal") item.maxTargets = 1; })}><option value="team">团队</option><option value="external">单体外部</option><option value="personal">个人</option></select></label>
      <label>类别<select value={cooldown.category} onChange={(event) => update((item) => { item.category = event.target.value as CooldownDefinition["category"]; })}>{["团队减伤","外部减伤","个人减伤","治疗","免疫","位移","自定义"].map((value) => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="field-grid">
      <label>职业<select value={cooldown.classSlug} onChange={(event) => update((item) => { item.classSlug = event.target.value; item.color = WOW_CLASS_COLORS[event.target.value]; })}>{Object.entries(WOW_CLASS_LABELS).map(([slug,label]) => <option value={slug} key={slug}>{label}</option>)}</select></label>
      <label>专精归属<input placeholder="多个专精用逗号分隔" value={cooldown.specSlugs.join("、")} onChange={(event) => update((item) => { item.specSlugs = event.target.value.split(/[、,，]/).map((value) => value.trim()).filter(Boolean); })} /></label>
    </div>
    <label>冷却秒数<NullableNumber value={cooldown.cooldownMs} scale={1000} onChange={(value) => update((item) => { item.cooldownMs = value; })} /></label>
    <div className="field-grid">
      <label>施法秒数<NullableNumber value={cooldown.castTimeMs} scale={1000} onChange={(value) => update((item) => { item.castTimeMs = value; })} /></label>
      <label>持续秒数<NullableNumber value={cooldown.durationMs} scale={1000} onChange={(value) => update((item) => { item.durationMs = value; })} /></label>
    </div>
    <p className="field-note">留空表示未知；填写 0 表示明确瞬发或无持续时间。目录 {cooldown.catalogVersion}</p>
    <label>GCD<select value={cooldown.triggersGcd == null ? "unknown" : cooldown.triggersGcd ? "yes" : "no"} onChange={(event) => update((item) => { item.triggersGcd = event.target.value === "unknown" ? null : event.target.value === "yes"; })}><option value="unknown">未设置</option><option value="yes">占用 GCD</option><option value="no">不占用 GCD</option></select></label>
    <button className="danger-button" onClick={() => { if (confirm(`删除技能“${cooldown.name}”及其分配？`)) mutate((draft) => { draft.cooldowns = draft.cooldowns.filter((entry) => entry.id !== cooldown.id); draft.assignments = draft.assignments.filter((entry) => entry.cooldownId !== cooldown.id); }, null); }}>删除技能</button>
  </div>;
}

function Checks({ warnings, onSelect }: { warnings: ConflictWarning[]; onSelect: (selection: TimelineObjectSelection) => void }) {
  return <div className="checks"><header><b>排轴检查</b><span>{warnings.length ? `${warnings.length} 项` : "通过"}</span></header>{warnings.slice(0, 8).map((warning, index) => <button key={`${warning.type}-${index}`} onClick={() => warning.assignmentId ? onSelect({ type: "assignment", id: warning.assignmentId }) : warning.mechanicId ? onSelect({ type: "mechanic", id: warning.mechanicId }) : undefined}>{warning.message}</button>)}</div>;
}
