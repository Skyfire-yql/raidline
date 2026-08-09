"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Inspector JSX edits heterogeneous v2 unions in-place; runtime documents are normalized before use. */
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim loads a second React instance in the client bundle. */

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  cooldownsForClass,
  specializationFor,
  specializationLabel,
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
import { applyCatalogPreset, catalogDifference, SEED_CATALOG } from "@/lib/catalog";
import { hashPlanDocument } from "@/lib/hashing";
import { randomBase62 } from "@/lib/publication-ids";
import type { ApiError, CatalogRelease, CooldownDefinition, LocalPlanRecord, PlanSnapshot, PublicPublication, PublicationBinding, RaidAssignment, RaidGroup, RaidMechanic, RaidPlanDocument, RosterMember, TargetSelection } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { cacheCatalog, createLocalPlan, createPlanSnapshot, getCachedCatalog, getLocalPlan, listPlanSnapshots, LocalRevisionConflictError, saveLocalPlan, setPlanPublication } from "./local-store";

type Selection = { type: "member" | "group" | "mechanic" | "cooldown" | "assignment"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type LeftTab = "members" | "skills" | "groups" | "presets";
const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;
const TIMELINE_LIMITS = [600_000, 1_200_000, 1_800_000, 3_600_000, 7_200_000] as const;

function clonePlan(plan: RaidPlanDocument) { return structuredClone(plan); }

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
  const [leftTab, setLeftTab] = useState<LeftTab>("members");
  const [skillClassSlug, setSkillClassSlug] = useState("");
  const [skillMemberId, setSkillMemberId] = useState("");
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [zoom, setZoom] = useState(1);
  const [timelineScroll, setTimelineScroll] = useState({ left: 0, top: 0 });
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
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
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("plan", planId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number; leftCollapsed?: boolean; rightCollapsed?: boolean } | null;
        const mobile = innerWidth < 720;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(view?.zoom ?? 1); setLeftCollapsed(view?.leftCollapsed ?? mobile); setRightCollapsed(view?.rightCollapsed ?? mobile);
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

  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("plan", planId, viewWidth), JSON.stringify({ orientation, zoom, leftCollapsed, rightCollapsed })); }, [leftCollapsed, orientation, planId, rightCollapsed, viewReady, viewWidth, zoom]);

  function mutate(mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) {
    setPlan((current) => {
      if (!current) return current;
      undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)]; redoStack.current = [];
      const counts = [current.roster.length, current.groups.length, current.mechanics.length, current.cooldowns.length, current.assignments.length, current.phases.length];
      const next = clonePlan(current); mutator(next);
      const destructive = [next.roster.length, next.groups.length, next.mechanics.length, next.cooldowns.length, next.assignments.length, next.phases.length].some((value, index) => value < counts[index]);
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
  const selectedGroup = selection?.type === "group" ? plan.groups.find((item) => item.id === selection.id) : null;
  const selectedMechanic = selection?.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : null;
  const selectedCooldownDirect = selection?.type === "cooldown" ? plan.cooldowns.find((item) => item.id === selection.id) : null;
  const selectedAssignment = selection?.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : null;
  const selectedCooldown = selectedCooldownDirect ?? (selectedAssignment ? plan.cooldowns.find((item) => item.id === selectedAssignment.cooldownId) : null);
  function addMember() {
    const id = makeId("member");
    mutate((draft) => draft.roster.push({ id, name: `成员 ${String(draft.roster.length + 1).padStart(2, "0")}`, classSlug: "", specSlug: "", role: "damage", color: "#7b8490" }), { type: "member", id });
  }
  function addGroup() { const id = makeId("group"); mutate((draft) => draft.groups.push({ id, name: `分组 ${draft.groups.length + 1}`, color: "#6f7f91" }), { type: "group", id }); }
  function addMechanic(atMs = 30_000) {
    const id = makeId("mechanic"); mutate((draft) => draft.mechanics.push({ id, name: "新机制", description: "", atMs: snapTime(atMs, draft.settings.snapMs), castTimeMs: 0, durationMs: 0, damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false }, targets: structuredClone(ALL_TARGETS), severity: "warning", source: "manual", note: "" }), { type: "mechanic", id });
  }
  function addCustomSkill() {
    if (!skillClassSlug) { setToast("请先选择职业"); return; }
    const id = makeId("custom-spell"); const classSlug = skillClassSlug;
    mutate((draft) => draft.cooldowns.push({ id, name: "自定义技能", description: "", classSlug, specSlugs: [], scope: "team", cooldownMs: null, castTimeMs: null, durationMs: null, triggersGcd: null, maxTargets: null, effects: [], category: "自定义", color: WOW_CLASS_COLORS[classSlug], catalogVersion: "custom", dataStatus: "custom" }), { type: "cooldown", id });
  }
  function addAssignment(cooldownId: string) {
    const cooldown = activePlan.cooldowns.find((item) => item.id === cooldownId); if (!cooldown) return;
    const timelineMember = activePlan.roster.find((item) => item.id === skillMemberId && item.classSlug === cooldown.classSlug);
    const selectedAssignmentMember = selectedAssignment ? activePlan.roster.find((item) => item.id === selectedAssignment.memberId) : null;
    const preferredMember = selectedMember?.classSlug === cooldown.classSlug ? selectedMember : selectedAssignmentMember?.classSlug === cooldown.classSlug ? selectedAssignmentMember : null;
    const member = timelineMember ?? preferredMember ?? activePlan.roster.find((item) => item.classSlug === cooldown.classSlug);
    if (!member) { setToast(`先为至少一名成员选择${WOW_CLASS_LABELS[cooldown.classSlug] ?? "对应"}职业`); return; }
    const mechanic = selectedMechanic ?? (selectedAssignment?.mechanicId ? activePlan.mechanics.find((item) => item.id === selectedAssignment.mechanicId) : null);
    const id = makeId("assignment"); const atMs = mechanic ? defaultAssignmentStart(activePlan, cooldown, mechanic) : 0;
    mutate((draft) => draft.assignments.push({ id, memberId: member.id, cooldownId, ...(mechanic ? { mechanicId: mechanic.id, offsetMs: atMs - mechanicImpactMs(mechanic) } : {}), atMs, targets: cooldown.scope === "personal" ? { mode: "members", memberIds: [member.id] } : mechanic ? structuredClone(INHERIT_TARGETS) : structuredClone(ALL_TARGETS), note: "", source: "manual" }), { type: "assignment", id });
  }
  function moveAssignment(id: string, atMs: number) {
    mutate((draft) => { const item = draft.assignments.find((entry) => entry.id === id); if (!item) return; item.atMs = snapTime(atMs, draft.settings.snapMs); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); }, { type: "assignment", id });
  }
  function moveMechanic(id: string, atMs: number) {
    mutate((draft) => {
      const item = draft.mechanics.find((entry) => entry.id === id);
      if (!item) return;
      item.atMs = snapTime(atMs, draft.settings.snapMs);
      syncLinkedAssignments(draft, item.id);
    }, { type: "mechanic", id });
  }
  function openMemberSkills(memberId: string) {
    const member = activePlan.roster.find((item) => item.id === memberId);
    if (!member) return;
    setSelection({ type: "member", id: member.id });
    if (!member.classSlug) {
      setRightCollapsed(false);
      setToast("请先为该成员选择职业和专精");
      return;
    }
    setSkillMemberId(member.id);
    setSkillClassSlug(member.classSlug);
    setLeftTab("skills");
    setLeftCollapsed(false);
  }

  async function copyText(value: string, message: string) { await navigator.clipboard.writeText(value); setToast(message); }

  async function refreshSnapshots() { setSnapshots(await listPlanSnapshots(planId)); }

  async function applyPreset(presetId: string) {
    const preset = catalog.timelinePresets.find((item) => item.id === presetId);
    if (!preset || !confirm(`应用“${preset.name}”？当前机制和分配会被替换，并先建立检查点。`)) return;
    try {
      await createPlanSnapshot(planId, "preset", activePlan, localRevisionRef.current);
      replacePlan(applyCatalogPreset(activePlan, catalog, preset));
      await refreshSnapshots(); setToast("预设已应用，旧内容已保存为检查点");
    } catch (error) { setToast(error instanceof Error ? error.message : "应用预设失败"); }
  }

  async function upgradeCatalog(event: React.MouseEvent<HTMLButtonElement>) {
    const appliedAt = Math.round(performance.timeOrigin + event.timeStamp);
    const difference = catalogDifference(activePlan, catalog);
    if (difference.currentVersion === difference.availableVersion) { setToast("当前计划已使用最新目录"); return; }
    if (!confirm(`升级到目录 ${difference.availableVersion}？将更新目录技能，机制快照不会自动改变。`)) return;
    await createPlanSnapshot(planId, "catalog-upgrade", activePlan, localRevisionRef.current);
    const next = clonePlan(activePlan);
    const custom = next.cooldowns.filter((item) => item.dataStatus === "custom" || item.id.startsWith("custom-"));
    next.cooldowns = [...catalog.playerSkills.filter((item) => item.enabled).map((item) => { const { enabled: _enabled, gameVersion: _gameVersion, ...skill } = item; void _enabled; void _gameVersion; return structuredClone(skill); }), ...custom];
    next.catalogSource = { version: catalog.manifest.version, appliedAt };
    replacePlan(next); await refreshSnapshots(); setToast("技能目录已升级；旧机制和时间轴保持不变");
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
      const linked = await setPlanPublication(planId, binding);
      localRevisionRef.current = linked.localRevision; setLocalRevision(linked.localRevision);
      setRecord({ ...linked, document: planRef.current ?? linked.document });
      await refreshSnapshots();
      const latestHash = planRef.current ? await hashPlanDocument(planRef.current) : capturedHash;
      setCurrentHash(latestHash);
      setToast(latestHash === binding.contentHash ? "服务器版本已发布" : "快照已发布；发布期间的新修改仍只在本地");
    } catch (error) { setToast(error instanceof Error ? error.message : "发布失败"); }
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
      const unlinked = await setPlanPublication(planId);
      localRevisionRef.current = unlinked.localRevision; setLocalRevision(unlinked.localRevision); setRecord({ ...unlinked, document: planRef.current ?? unlinked.document });
      setToast("服务器发布已删除，本地轴仍然保留");
    } catch (error) { setToast(error instanceof Error ? error.message : "删除失败"); }
    finally { setPublishing(""); }
  }

  const timelineSelection = selection?.type === "mechanic" ? `mechanic:${selection.id}` as const : selection?.type === "assignment" ? `assignment:${selection.id}` as const : null;
  const gridClass = `${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`;
  const publicationDirty = Boolean(record.activePublication && currentHash && record.activePublication.contentHash !== currentHash);
  return <main className="editor-workspace" data-local-revision={localRevision}>
    <header className="editor-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="plan-name"><input aria-label="计划名称" value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /><span className={`save-state ${saveState}`}>{{ saved: "本地已保存", dirty: "本地待保存", saving: "本地保存中", error: "本地保存失败", conflict: "标签页冲突" }[saveState]}</span><span className={`publication-state ${publicationDirty ? "dirty" : record.activePublication ? "published" : "unpublished"}`}>{record.activePublication ? publicationDirty ? "存在未发布修改" : "服务器已发布" : "尚未发布"}</span></div><div className="header-actions"><button onClick={undo} disabled={!historyState.canUndo}>撤销</button><button onClick={redo} disabled={!historyState.canRedo}>重做</button><button onClick={() => copyText(exportMrtNote(plan), "MRT 已复制")}>MRT</button>{record.activePublication && <><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}`, "只读链接已复制")}>复制分享链接</button><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}/${record.activePublication!.editId}`, "编辑链接已复制")}>复制编辑链接</button><button disabled={Boolean(publishing)} onClick={() => publish("overwrite")}>覆盖当前链接</button></>}<button disabled={Boolean(publishing)} onClick={() => publish("new")}>{record.activePublication ? "发布为新链接" : "发布并创建链接"}</button>{record.activePublication && <button className="danger-link" disabled={Boolean(publishing)} onClick={removePublication}>删除发布</button>}<ThemeControl compact /></div></header>
    {saveState === "conflict" && <div className="conflict-banner"><span>另一个标签页已保存了更新；当前标签页没有覆盖它。</span><button onClick={() => { if (conflict) { const next = normalizePlanDocument(conflict.document); setPlan(next); planRef.current = next; setRecord(conflict); setLocalRevision(conflict.localRevision); localRevisionRef.current = conflict.localRevision; setConflict(null); setSaveState("saved"); } }}>加载较新本地版本</button><button onClick={async () => { const copy = await createLocalPlan(activePlan); location.assign(`/plans/${copy.id}`); }}>将当前内容另存为副本</button></div>}
    <div className={`editor-table-grid ${gridClass}`}>
      <aside className={`left-table-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <><nav className="panel-tabs">{([['members','成员'],['skills','技能'],['groups','分组'],['presets','预设']] as const).map(([id,label]) => <button className={leftTab === id ? "active" : ""} key={id} onClick={() => setLeftTab(id)}>{label}</button>)}</nav>
        {leftTab === "members" && <div className="panel-body"><div className="table-tools"><span>{plan.roster.length}/40 人</span><button onClick={addMember}>＋ 添加</button></div><div className="dense-list">{plan.roster.map((member) => <button className={selection?.type === "member" && selection.id === member.id ? "selected" : ""} key={member.id} onClick={() => setSelection({ type: "member", id: member.id })}><i style={{ background: member.color }} /><span><strong>{member.name}</strong><small>{WOW_CLASS_LABELS[member.classSlug] ?? "待选择职业"} · {specializationLabel(member.classSlug, member.specSlug)} · {roleLabels[member.role]}</small></span></button>)}</div></div>}
        {leftTab === "skills" && <div className="panel-body skill-picker">
          <label>职业<select value={skillClassSlug} onChange={(event) => { setSkillClassSlug(event.target.value); setSkillMemberId(""); setSelection(null); }}><option value="">先选择职业</option>{Object.entries(WOW_CLASS_LABELS).map(([slug,label]) => <option value={slug} key={slug}>{label}</option>)}</select></label>
          {skillMemberId && <p className="skill-target">分配给：<b>{plan.roster.find((member) => member.id === skillMemberId)?.name}</b></p>}
          {skillClassSlug && <button className="secondary-action" onClick={addCustomSkill}>＋ 为{WOW_CLASS_LABELS[skillClassSlug]}添加自定义技能</button>}
          {!skillClassSlug && <p className="table-empty">选择职业后，直接显示该职业的可用技能。</p>}
          {skillClassSlug && <div className="skill-list">{classCooldowns.map((cooldown) => <div className={selection?.type === "cooldown" && selection.id === cooldown.id ? "selected" : ""} key={cooldown.id} title={cooldown.description || "暂无说明"}>
            <button onClick={() => setSelection({ type: "cooldown", id: cooldown.id })}><i style={{ background: cooldown.color }} /><span><strong>{cooldown.name}</strong><small>{cooldown.category} · {cooldown.durationMs == null ? "持续待补" : `${cooldown.durationMs / 1000}s`}</small></span></button>
            <button onClick={() => addAssignment(cooldown.id)} title={`分配 ${cooldown.name}`} aria-label={`分配 ${cooldown.name}`}>＋</button>
          </div>)}{!classCooldowns.length && <p className="table-empty">该职业暂无技能，可添加自定义技能。</p>}</div>}
        </div>}
        {leftTab === "groups" && <div className="panel-body"><div className="table-tools"><span>每人最多一个自定义组</span><button onClick={addGroup}>＋ 添加</button></div><div className="dense-list">{plan.groups.map((group) => <button className={selection?.type === "group" && selection.id === group.id ? "selected" : ""} key={group.id} onClick={() => setSelection({ type: "group", id: group.id })}><i style={{ background: group.color }} /><span><strong>{group.name}</strong><small>{plan.roster.filter((member) => member.groupId === group.id).length} 人</small></span></button>)}{!plan.groups.length && <p className="table-empty">可建立左场、右场等站位组。</p>}</div></div>}
        {leftTab === "presets" && <div className="panel-body"><div className="catalog-summary"><b>目录 {catalog.manifest.version}</b><small>计划来源 {plan.catalogSource?.version ?? "未记录"}</small><button onClick={upgradeCatalog}>查看差异并手动升级技能</button></div><div className="preset-list">{catalog.timelinePresets.filter((preset) => preset.enabled).map((preset) => <div key={preset.id}><span><strong>{preset.name}</strong><small>{preset.gameVersion} / {preset.raidId} / {preset.bossId} · {preset.description}</small></span><button onClick={() => applyPreset(preset.id)}>应用</button></div>)}</div><div className="snapshot-list"><header><b>本地检查点</b><span>最近 {snapshots.length}/30</span></header>{snapshots.slice(0, 8).map((snapshot) => <button key={snapshot.id} onClick={async () => { if (!confirm(`恢复 ${new Date(snapshot.createdAt).toLocaleString("zh-CN")} 的检查点？`)) return; await createPlanSnapshot(planId, "destructive", activePlan, localRevisionRef.current); replacePlan(snapshot.document); await refreshSnapshots(); }}><span>{new Date(snapshot.createdAt).toLocaleString("zh-CN")}</span><small>{snapshot.reason} · 本地版本 {snapshot.localRevision}</small></button>)}{!snapshots.length && <p className="table-empty">每分钟、发布和破坏性操作前会自动建立检查点。</p>}</div></div>}
      </>}</aside>
      <section className="timeline-work-panel">
        <div className="axis-toolbar"><div><button onClick={() => setLeftCollapsed((value) => !value)}>成员/技能</button><b>{plan.encounter.difficulty}</b><label className="timeline-limit">上限<select aria-label="时间轴上限" value={TIMELINE_LIMITS.some((value) => value === plan.encounter.durationMs) ? String(plan.encounter.durationMs) : "custom"} onChange={(event) => { if (event.target.value !== "custom") mutate((draft) => { draft.encounter.durationMs = Number(event.target.value); }); }}><option value="600000">10 分钟</option><option value="1200000">20 分钟</option><option value="1800000">30 分钟</option><option value="3600000">60 分钟</option><option value="7200000">120 分钟</option>{!TIMELINE_LIMITS.some((value) => value === plan.encounter.durationMs) && <option value="custom">自定义 {formatTime(plan.encounter.durationMs)}</option>}</select></label><span>{plan.mechanics.length} 机制</span><span>{plan.assignments.length} 分配</span></div><div><button onClick={() => addMechanic()}>＋ 机制</button><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /><button onClick={() => { setSelection(null); setRightCollapsed(false); }}>计划设置</button><button onClick={() => setRightCollapsed((value) => !value)}>属性/检查</button></div></div>
        <div className="axis-scroll" ref={timelineRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView plan={plan} orientation={orientation} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} warningIds={warningIds} onSelect={(key) => { if (!key) setSelection(null); else { const [type,id] = key.split(":"); setSelection({ type: type as "mechanic" | "assignment", id }); setRightCollapsed(false); } }} onSelectMember={(id) => { setSelection({ type: "member", id }); setRightCollapsed(false); }} onOpenMemberSkills={openMemberSkills} onAddMechanic={addMechanic} onMoveMechanic={moveMechanic} onMoveAssignment={moveAssignment} /></div>
        <div className="axis-statusbar"><span>Ctrl + 滚轮缩放 · 双击空白添加机制 · 拖动机制或技能改时间 · 成员栏已冻结</span><b className={warnings.length ? "warn" : "ok"}>{warnings.length ? `${warnings.length} 项提醒` : "检查通过"}</b></div>
      </section>
      <aside className={`right-table-panel ${rightCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setRightCollapsed((value) => !value)}>{rightCollapsed ? "‹" : "›"}</button>{!rightCollapsed && <Inspector plan={plan} selection={selection} selectedMember={selectedMember} selectedGroup={selectedGroup} selectedMechanic={selectedMechanic} selectedCooldown={selectedCooldown} selectedAssignment={selectedAssignment} warnings={warnings} mutate={mutate} setSelection={setSelection} />}</aside>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </main>;
}

type MutatePlan = (mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) => void;

interface InspectorProps {
  plan: RaidPlanDocument;
  selection: Selection;
  selectedMember: RosterMember | null | undefined;
  selectedGroup: RaidGroup | null | undefined;
  selectedMechanic: RaidMechanic | null | undefined;
  selectedCooldown: CooldownDefinition | null | undefined;
  selectedAssignment: RaidAssignment | null | undefined;
  warnings: ConflictWarning[];
  mutate: MutatePlan;
  setSelection: Dispatch<SetStateAction<Selection>>;
}

function Inspector({ plan, selection, selectedMember, selectedGroup, selectedMechanic, selectedCooldown, selectedAssignment, warnings, mutate, setSelection }: InspectorProps) {
  const updateMechanic = (fn: (item: any) => void) => mutate((draft) => { const item = draft.mechanics.find((entry) => entry.id === selectedMechanic?.id); if (item) { fn(item); syncLinkedAssignments(draft, item.id); } });
  const updateCooldown = (fn: (item: CooldownDefinition) => void) => mutate((draft: RaidPlanDocument) => { const item = draft.cooldowns.find((entry) => entry.id === selectedCooldown?.id); if (item) { fn(item); item.dataStatus = "custom"; if (item.scope === "personal") { item.maxTargets = 1; for (const assignment of draft.assignments.filter((entry) => entry.cooldownId === item.id)) assignment.targets = { mode: "members", memberIds: [assignment.memberId] }; } } });
  if (!selection) return <PlanSettingsInspector plan={plan} warnings={warnings} mutate={mutate} setSelection={setSelection} />;
  if (selectedMember) {
    const specializations = specializationsForClass(selectedMember.classSlug);
    const knownSpecialization = specializationFor(selectedMember.classSlug, selectedMember.specSlug);
    return <div className="inspector">
      <header><h2>成员</h2><span>RAIDER</span></header>
      <label>角色名<input value={selectedMember.name} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.name = event.target.value; })} /></label>
      <label>职业<select value={selectedMember.classSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) { item.classSlug = event.target.value; item.specSlug = ""; item.role = "damage"; item.color = WOW_CLASS_COLORS[event.target.value] ?? "#7b8490"; } })}><option value="">待选择</option>{Object.entries(WOW_CLASS_LABELS).map(([slug,label]) => <option value={slug} key={slug}>{label}</option>)}</select></label>
      <label>专精<select value={selectedMember.specSlug} disabled={!selectedMember.classSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (!item) return; item.specSlug = event.target.value; item.role = specializationFor(item.classSlug, item.specSlug)?.role ?? "damage"; })}><option value="">待选择专精</option>{selectedMember.specSlug && !knownSpecialization && <option value={selectedMember.specSlug}>{selectedMember.specSlug}（旧专精）</option>}{specializations.map((spec) => <option value={spec.slug} key={spec.slug}>{spec.label}</option>)}</select></label>
      <label>职责<output className="readonly-field">{knownSpecialization ? roleLabels[knownSpecialization.role] : "选择专精后自动匹配"}</output></label>
      <label>自定义分组<select value={selectedMember.groupId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.groupId = event.target.value || undefined; })}><option value="">未分组</option>{plan.groups.map((group: any) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
      <button className="danger-button" onClick={() => { if (confirm(`删除成员“${selectedMember.name}”及其分配？`)) mutate((draft: RaidPlanDocument) => { draft.roster = draft.roster.filter((entry) => entry.id !== selectedMember.id); draft.assignments = draft.assignments.filter((entry) => entry.memberId !== selectedMember.id); }, null); }}>删除成员</button>
    </div>;
  }
  if (selectedGroup) return <div className="inspector"><header><h2>分组</h2><span>GROUP</span></header><label>名称<input value={selectedGroup.name} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.groups.find((entry) => entry.id === selectedGroup.id); if (item) item.name = event.target.value; })} /></label><label>标识色<input type="color" value={selectedGroup.color} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.groups.find((entry) => entry.id === selectedGroup.id); if (item) item.color = event.target.value; })} /></label><p className="field-note">{plan.roster.filter((member: any) => member.groupId === selectedGroup.id).map((member: any) => member.name).join("、") || "暂无成员"}</p><button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.groups = draft.groups.filter((entry) => entry.id !== selectedGroup.id); draft.roster.forEach((member) => { if (member.groupId === selectedGroup.id) member.groupId = undefined; }); }, null)}>删除分组</button></div>;
  if (selectedMechanic) return <div className="inspector"><header><h2>机制</h2><span>MECHANIC</span></header><label>名称<input value={selectedMechanic.name} onChange={(event) => updateMechanic((item) => { item.name = event.target.value; })} /></label><label>说明<textarea rows={5} value={selectedMechanic.description} onChange={(event) => updateMechanic((item) => { item.description = event.target.value; })} /></label><label>时间点<TimeField value={selectedMechanic.atMs} onCommit={(value) => updateMechanic((item) => { item.atMs = snapTime(value, plan.settings.snapMs); })} /></label><label>所属阶段<select value={selectedMechanic.phaseId ?? ""} onChange={(event) => updateMechanic((item) => { item.phaseId = event.target.value || undefined; })}><option value="">未指定</option>{plan.phases.map((phase) => <option value={phase.id} key={phase.id}>{formatTime(phase.atMs)} {phase.name}</option>)}</select></label><button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.mechanics = draft.mechanics.filter((entry) => entry.id !== selectedMechanic.id); draft.assignments = draft.assignments.map((entry) => entry.mechanicId === selectedMechanic.id ? { ...entry, mechanicId: undefined, offsetMs: undefined, targets: entry.targets.mode === "inherit" ? structuredClone(ALL_TARGETS) : entry.targets } : entry); }, null)}>删除机制</button></div>;
  if (selectedCooldown && !selectedAssignment) return <SkillInspector cooldown={selectedCooldown} update={updateCooldown} mutate={mutate} />;
  if (selectedAssignment && selectedCooldown) {
    const member = plan.roster.find((item) => item.id === selectedAssignment.memberId);
    const compatibleCooldowns = plan.cooldowns.filter((item) => item.classSlug === member?.classSlug || item.id === selectedAssignment.cooldownId);
    return <div className="inspector"><header><h2>技能分配</h2><span>ASSIGNMENT</span></header><label>成员<select value={selectedAssignment.memberId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.memberId = event.target.value; const nextMember = draft.roster.find((entry) => entry.id === item.memberId); const currentCooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); const firstCompatible = draft.cooldowns.find((entry) => entry.classSlug === nextMember?.classSlug); if (currentCooldown?.classSlug !== nextMember?.classSlug && firstCompatible) item.cooldownId = firstCompatible.id; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{plan.roster.map((entry: any) => <option value={entry.id} key={entry.id}>{entry.name} · {WOW_CLASS_LABELS[entry.classSlug] ?? "待选择职业"}</option>)}</select></label><label>技能<select value={selectedAssignment.cooldownId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.cooldownId = event.target.value; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{compatibleCooldowns.map((cooldown: any) => <option value={cooldown.id} key={cooldown.id}>{cooldown.name}{cooldown.classSlug !== member?.classSlug ? "（旧分配）" : ""}</option>)}</select></label><label>开始施法<TimeField value={selectedAssignment.atMs} onCommit={(value) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.atMs = snapTime(value, draft.settings.snapMs); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); })} /></label><label>关联机制<select value={selectedAssignment.mechanicId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; const mechanic = draft.mechanics.find((entry) => entry.id === event.target.value); item.mechanicId = mechanic?.id; if (mechanic) { item.atMs = defaultAssignmentStart(draft, selectedCooldown, mechanic); item.offsetMs = item.atMs - mechanicImpactMs(mechanic); item.targets = selectedCooldown.scope === "personal" ? { mode: "members", memberIds: [item.memberId] } : structuredClone(INHERIT_TARGETS); } else { item.offsetMs = undefined; if (item.targets.mode === "inherit") item.targets = structuredClone(ALL_TARGETS); } })}><option value="">自由时间点</option>{plan.mechanics.map((mechanic: any) => <option value={mechanic.id} key={mechanic.id}>{formatTime(mechanic.atMs)} {mechanic.name}</option>)}</select></label>{selectedCooldown.scope === "personal" ? <div className="field-note"><b>实际目标：施放者本人</b><br />个人技能固定作用于当前成员，不能改为其他目标。</div> : <label>实际目标<TargetEditor target={selectedAssignment.targets} plan={plan} allowInherit onChange={(target) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.targets = target; })} /></label>}<label>备注<textarea value={selectedAssignment.note} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.note = event.target.value; })} /></label>{warnings.filter((warning: any) => warning.assignmentId === selectedAssignment.id).map((warning: any, index: number) => <div className="warning-box" key={`${warning.type}-${index}`}>{warning.message}</div>)}<button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.assignments = draft.assignments.filter((entry) => entry.id !== selectedAssignment.id); }, null)}>删除分配</button></div>;
  }
  return null;
}

function PlanSettingsInspector({ plan, warnings, mutate, setSelection }: { plan: RaidPlanDocument; warnings: ConflictWarning[]; mutate: MutatePlan; setSelection: Dispatch<SetStateAction<Selection>> }) {
  return <div className="inspector">
    <header><h2>计划设置</h2><span>PLAN</span></header>
    <label>计划名称<input value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /></label>
    <label>难度<select value={plan.encounter.difficulty} onChange={(event) => mutate((draft) => { draft.encounter.difficulty = event.target.value; })}><option>随机</option><option>普通</option><option>英雄</option><option>史诗</option><option>练习</option></select></label>
    <label>时间轴上限<TimeField value={plan.encounter.durationMs} onCommit={(value) => mutate((draft) => { draft.encounter.durationMs = Math.min(7_200_000, Math.max(10_000, value)); })} /></label>
    <p className="field-note">可设置 00:10–120:00；工具栏提供常用上限。缩短上限不会删除已有内容，越界项会显示提醒。</p>
    <label>时间吸附秒数<NullableNumber value={plan.settings.snapMs} scale={1000} min={0.1} onChange={(value) => mutate((draft) => { draft.settings.snapMs = value ?? 1000; })} /></label>
    <section className="phase-editor">
      <header><b>阶段</b><button onClick={() => mutate((draft) => draft.phases.push({ id: makeId("phase"), name: `P${draft.phases.length + 1}`, atMs: Math.min(draft.encounter.durationMs, (draft.phases.at(-1)?.atMs ?? 0) + 60_000) }))}>＋ 阶段</button></header>
      {plan.phases.map((phase, index) => <div key={phase.id}><input aria-label={`阶段 ${index + 1} 名称`} value={phase.name} onChange={(event) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === phase.id); if (item) item.name = event.target.value; })} /><TimeField label={`阶段 ${index + 1} 时间`} value={phase.atMs} onCommit={(value) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === phase.id); if (item) item.atMs = snapTime(value, draft.settings.snapMs); })} />{plan.phases.length > 1 && <button aria-label={`删除阶段 ${phase.name}`} onClick={() => mutate((draft) => { draft.phases = draft.phases.filter((entry) => entry.id !== phase.id); draft.mechanics.forEach((item) => { if (item.phaseId === phase.id) item.phaseId = undefined; }); })}>×</button>}</div>)}
    </section>
    <Checks warnings={warnings} setSelection={setSelection} />
  </div>;
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

function Checks({ warnings, setSelection }: any) { return <div className="checks"><header><b>排轴检查</b><span>{warnings.length ? `${warnings.length} 项` : "通过"}</span></header>{warnings.slice(0,8).map((warning: any,index: number) => <button key={index} onClick={() => warning.assignmentId ? setSelection({ type:"assignment", id:warning.assignmentId }) : warning.mechanicId ? setSelection({ type:"mechanic", id:warning.mechanicId }) : null}>{warning.message}</button>)}</div>; }
