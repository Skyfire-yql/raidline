"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Inspector JSX edits heterogeneous v2 unions in-place; runtime documents are normalized before use. */
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim loads a second React instance in the client bundle. */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { WOW_CLASS_COLORS, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import {
  ALL_TARGETS, INHERIT_TARGETS, calculateMechanicPressure, defaultAssignmentStart, detectConflicts,
  exportMrtNote, formatCompactNumber, formatTime, makeId, mechanicImpactMs,
  normalizePlanDocument, parseTime, snapTime, syncLinkedAssignments,
} from "@/lib/core";
import type { ConflictWarning, MechanicPressureResult } from "@/lib/core";
import { applyBuiltInPreset, BUILT_IN_PRESETS, createPersonalPreset, parsePresetJson, stringifyPreset, type RaidPlanPreset } from "@/lib/presets";
import type { ApiError, CooldownDefinition, CooldownEffect, RaidAssignment, RaidGroup, RaidMechanic, RaidPlanDocument, RosterMember, StoredPlan, TargetSelection, WclImportAnalysis, WclPreview } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { deletePersonalPreset, listPersonalPresets, savePersonalPreset } from "./preset-store";

type Selection = { type: "member" | "group" | "mechanic" | "cooldown" | "assignment"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type LeftTab = "members" | "skills" | "groups" | "presets";
const RECENT_KEY = "raidline:recent";
const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;

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
  const [token, setToken] = useState("");
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [plan, setPlan] = useState<RaidPlanDocument | null>(null);
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState("");
  const [conflict, setConflict] = useState<StoredPlan | null>(null);
  const [showWcl, setShowWcl] = useState(false);
  const [wclInitial, setWclInitial] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("members");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [orientation, setOrientation] = useState<TimelineOrientation>("horizontal");
  const [zoom, setZoom] = useState(1);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [viewWidth, setViewWidth] = useState(1024);
  const [viewReady, setViewReady] = useState(false);
  const [personalPresets, setPersonalPresets] = useState<RaidPlanPreset[]>([]);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const undoStack = useRef<RaidPlanDocument[]>([]);
  const redoStack = useRef<RaidPlanDocument[]>([]);
  const editRevision = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const importPresetRef = useRef<HTMLInputElement>(null);

  const rememberPlan = useCallback((value: StoredPlan, editToken: string) => {
    try {
      localStorage.setItem(`raidline:key:${value.id}`, editToken);
      const current = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Array<{ id: string; title: string; updatedAt: number }>;
      localStorage.setItem(RECENT_KEY, JSON.stringify([{ id: value.id, title: value.document.encounter.name, updatedAt: value.updatedAt }, ...current.filter((item) => item.id !== value.id)].slice(0, 8)));
    } catch { /* device convenience only */ }
  }, []);

  const loadPlan = useCallback(async (editToken: string) => {
    const response = await fetch(`/api/plans/${planId}`, { headers: { authorization: `Bearer ${editToken}` } });
    const payload = await response.json() as { data?: StoredPlan; error?: ApiError };
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败");
    const document = normalizePlanDocument(payload.data.document);
    setStored({ ...payload.data, document }); setPlan(document); setVersion(payload.data.version); setSaveState("saved");
    undoStack.current = []; redoStack.current = []; editRevision.current = 0; setHistoryState({ canUndo: false, canRedo: false }); rememberPlan(payload.data, editToken);
  }, [planId, rememberPlan]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const source = new URLSearchParams(location.search).get("wcl") ?? "";
      if (source) { setWclInitial(source); setShowWcl(true); }
      const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("key") ?? "";
      const editToken = fromHash || localStorage.getItem(`raidline:key:${planId}`) || "";
      if (fromHash) { localStorage.setItem(`raidline:key:${planId}`, fromHash); history.replaceState(null, "", `${location.pathname}${location.search}`); }
      if (!editToken) { setFatal("这条编辑链接缺少恢复密钥。请打开完整恢复链接。"); return; }
      setToken(editToken); loadPlan(editToken).catch((error) => { if (!cancelled) setFatal(error instanceof Error ? error.message : "读取计划失败"); });
      try {
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("plan", planId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number; leftCollapsed?: boolean; rightCollapsed?: boolean } | null;
        const mobile = innerWidth < 720;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(view?.zoom ?? 1); setLeftCollapsed(view?.leftCollapsed ?? mobile); setRightCollapsed(view?.rightCollapsed ?? mobile);
      } catch { setViewWidth(innerWidth); setOrientation(defaultOrientation(innerWidth)); setLeftCollapsed(innerWidth < 720); setRightCollapsed(innerWidth < 720); }
      setViewReady(true);
      listPersonalPresets().then((items) => { if (!cancelled) setPersonalPresets(items); }).catch(() => { if (!cancelled) setPersonalPresets([]); });
    });
    return () => { cancelled = true; };
  }, [loadPlan, planId]);

  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("plan", planId, viewWidth), JSON.stringify({ orientation, zoom, leftCollapsed, rightCollapsed })); }, [leftCollapsed, orientation, planId, rightCollapsed, viewReady, viewWidth, zoom]);

  function mutate(mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) {
    setPlan((current) => {
      if (!current) return current;
      undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)]; redoStack.current = [];
      const next = clonePlan(current); mutator(next); return normalizePlanDocument(next);
    });
    editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: false });
    setSaveState("dirty"); setConflict(null); if (nextSelection !== undefined) setSelection(nextSelection);
  }

  function replacePlan(next: RaidPlanDocument) {
    if (plan) undoStack.current = [...undoStack.current.slice(-49), clonePlan(plan)];
    redoStack.current = []; editRevision.current += 1; setHistoryState({ canUndo: Boolean(plan), canRedo: false }); setPlan(normalizePlanDocument(next)); setSelection(null); setSaveState("dirty"); setConflict(null);
  }

  function undo() { const previous = undoStack.current.pop(); if (!previous || !plan) return; redoStack.current.push(clonePlan(plan)); editRevision.current += 1; setHistoryState({ canUndo: undoStack.current.length > 0, canRedo: true }); setPlan(previous); setSaveState("dirty"); }
  function redo() { const next = redoStack.current.pop(); if (!next || !plan) return; undoStack.current.push(clonePlan(plan)); editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: redoStack.current.length > 0 }); setPlan(next); setSaveState("dirty"); }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault(); if (event.shiftKey) redo(); else undo();
    };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!plan || !token || saveState !== "dirty" || conflict) return;
    const captured = plan;
    const capturedRevision = editRevision.current;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const response = await fetch(`/api/plans/${planId}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ baseVersion: version, document: captured }) });
        const payload = await response.json() as { data?: StoredPlan; error?: ApiError };
        if (response.status === 409) { setConflict(payload.error?.details as StoredPlan | null); setSaveState("conflict"); return; }
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "保存失败");
        setVersion(payload.data.version); setStored(payload.data); rememberPlan(payload.data, token);
        setSaveState(editRevision.current === capturedRevision ? "saved" : "dirty");
      } catch (error) { setSaveState("error"); setToast(error instanceof Error ? error.message : "保存失败"); }
    }, 800);
    return () => clearTimeout(timer);
  }, [conflict, plan, planId, rememberPlan, saveState, token, version]);

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
  const pressure = useMemo(() => plan ? calculateMechanicPressure(plan) : [], [plan]);
  const pressureMap = useMemo(() => new Map(pressure.map((item) => [item.mechanicId, item])), [pressure]);

  if (fatal) return <main className="state-page"><div className="state-card"><h1>无法打开编辑器</h1><p>{fatal}</p><a className="primary-action" href="/">回到首页</a></div></main>;
  if (!plan || !stored) return <main className="state-page"><p>正在读取计划…</p></main>;
  const activePlan = plan;

  const selectedMember = selection?.type === "member" ? plan.roster.find((item) => item.id === selection.id) : null;
  const selectedGroup = selection?.type === "group" ? plan.groups.find((item) => item.id === selection.id) : null;
  const selectedMechanic = selection?.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : null;
  const selectedCooldownDirect = selection?.type === "cooldown" ? plan.cooldowns.find((item) => item.id === selection.id) : null;
  const selectedAssignment = selection?.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : null;
  const selectedCooldown = selectedCooldownDirect ?? (selectedAssignment ? plan.cooldowns.find((item) => item.id === selectedAssignment.cooldownId) : null);
  const activeMember = selectedMember ?? plan.roster[0];
  const filteredCooldowns = plan.cooldowns.filter((item) => (showAllSkills || !activeMember || item.classSlug === activeMember.classSlug) && `${item.name}${WOW_CLASS_LABELS[item.classSlug] ?? item.classSlug}`.toLowerCase().includes(paletteSearch.toLowerCase()));

  function addMember() {
    const id = makeId("member");
    mutate((draft) => draft.roster.push({ id, name: `新成员 ${draft.roster.length + 1}`, classSlug: "Priest", specSlug: "未知专精", role: "damage", color: WOW_CLASS_COLORS.Priest }), { type: "member", id });
  }
  function addGroup() { const id = makeId("group"); mutate((draft) => draft.groups.push({ id, name: `分组 ${draft.groups.length + 1}`, color: "#6f7f91" }), { type: "group", id }); }
  function addMechanic(atMs = 30_000) {
    const id = makeId("mechanic"); mutate((draft) => draft.mechanics.push({ id, name: "新机制", description: "", atMs: snapTime(atMs, draft.settings.snapMs), castTimeMs: 0, durationMs: 0, damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false }, targets: structuredClone(ALL_TARGETS), severity: "warning", source: "manual", note: "" }), { type: "mechanic", id });
  }
  function addCustomSkill() {
    const id = makeId("custom-spell"); const classSlug = activeMember?.classSlug ?? "Warrior";
    mutate((draft) => draft.cooldowns.push({ id, name: "自定义技能", description: "", classSlug, specSlugs: [], scope: "team", cooldownMs: null, castTimeMs: null, durationMs: null, triggersGcd: null, maxTargets: null, effects: [], category: "自定义", color: WOW_CLASS_COLORS[classSlug], catalogVersion: "custom", dataStatus: "custom" }), { type: "cooldown", id });
  }
  function addAssignment(cooldownId: string) {
    const cooldown = activePlan.cooldowns.find((item) => item.id === cooldownId); if (!cooldown) return;
    const member = selectedMember ?? (selectedAssignment ? activePlan.roster.find((item) => item.id === selectedAssignment.memberId) : null) ?? activePlan.roster.find((item) => item.classSlug === cooldown.classSlug) ?? activePlan.roster[0];
    if (!member) { setToast("先添加至少一名团队成员"); return; }
    const mechanic = selectedMechanic ?? (selectedAssignment?.mechanicId ? activePlan.mechanics.find((item) => item.id === selectedAssignment.mechanicId) : null);
    const id = makeId("assignment"); const atMs = mechanic ? defaultAssignmentStart(activePlan, cooldown, mechanic) : 0;
    mutate((draft) => draft.assignments.push({ id, memberId: member.id, cooldownId, ...(mechanic ? { mechanicId: mechanic.id, offsetMs: atMs - mechanicImpactMs(mechanic) } : {}), atMs, targets: cooldown.scope === "personal" ? { mode: "members", memberIds: [member.id] } : mechanic ? structuredClone(INHERIT_TARGETS) : structuredClone(ALL_TARGETS), note: "", source: "manual" }), { type: "assignment", id });
  }
  function moveAssignment(id: string, atMs: number) {
    mutate((draft) => { const item = draft.assignments.find((entry) => entry.id === id); if (!item) return; item.atMs = snapTime(atMs, draft.settings.snapMs); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); }, { type: "assignment", id });
  }

  async function copyText(value: string, message: string) { await navigator.clipboard.writeText(value); setToast(message); }
  function download(value: string, filename: string, type = "application/json") { const url = URL.createObjectURL(new Blob([value], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
  async function saveConflictAsNew() {
    setSaveState("saving");
    try {
      const createdResponse = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `${activePlan.encounter.name}（副本）` }) });
      const created = await createdResponse.json() as { data?: { id: string; editToken: string; version: number }; error?: ApiError };
      if (!createdResponse.ok || !created.data) throw new Error(created.error?.message ?? "创建新计划失败");
      const savedResponse = await fetch(`/api/plans/${created.data.id}`, { method: "PUT", headers: { authorization: `Bearer ${created.data.editToken}`, "content-type": "application/json" }, body: JSON.stringify({ baseVersion: created.data.version, document: activePlan }) });
      const saved = await savedResponse.json() as { data?: StoredPlan; error?: ApiError };
      if (!savedResponse.ok || !saved.data) throw new Error(saved.error?.message ?? "另存计划失败");
      rememberPlan(saved.data, created.data.editToken);
      location.assign(`/plans/${created.data.id}#key=${encodeURIComponent(created.data.editToken)}`);
    } catch (error) {
      setSaveState("conflict");
      setToast(error instanceof Error ? error.message : "另存计划失败");
    }
  }

  async function saveAsPreset() {
    const name = prompt("个人预设名称", activePlan.encounter.name); if (!name) return;
    const preset = createPersonalPreset(name, activePlan); await savePersonalPreset(preset); setPersonalPresets(await listPersonalPresets()); setToast("完整计划已保存为当前设备预设");
  }
  function applyPreset(preset: RaidPlanPreset) {
    if (!confirm(`应用“${preset.name}”？当前计划内容会被替换，可使用撤销恢复。`)) return;
    replacePlan(preset.kind === "built-in" ? applyBuiltInPreset(activePlan, preset) : preset.document); setToast("预设已应用");
  }
  async function importPreset(file: File) {
    try { const preset = parsePresetJson(await file.text()); await savePersonalPreset(preset); setPersonalPresets(await listPersonalPresets()); setToast("个人预设已导入"); } catch (error) { setToast(error instanceof Error ? error.message : "导入预设失败"); }
  }

  const timelineSelection = selection?.type === "mechanic" ? `mechanic:${selection.id}` as const : selection?.type === "assignment" ? `assignment:${selection.id}` as const : null;
  const gridClass = `${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`;
  return <main className="editor-workspace">
    <header className="editor-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="plan-name"><input aria-label="计划名称" value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /><span className={`save-state ${saveState}`}>{{ saved: "已保存", dirty: "待保存", saving: "保存中", error: "保存失败", conflict: "版本冲突" }[saveState]}</span></div><div className="header-actions"><button onClick={undo} disabled={!historyState.canUndo}>撤销</button><button onClick={redo} disabled={!historyState.canRedo}>重做</button><button onClick={() => setShowWcl(true)}>WCL</button><button onClick={() => copyText(exportMrtNote(plan), "MRT 已复制")}>MRT</button><button onClick={() => download(JSON.stringify(plan, null, 2), "raidline-plan.json")}>JSON</button><button onClick={() => copyText(`${location.origin}/s/${stored.shareSlug}`, "只读链接已复制")}>分享</button><button onClick={() => copyText(`${location.origin}/plans/${planId}#key=${encodeURIComponent(token)}`, "恢复链接已复制")}>恢复链接</button><ThemeControl compact /></div></header>
    {saveState === "conflict" && <div className="conflict-banner"><span>服务器已有更新，本地修改尚未覆盖。</span><button onClick={() => { if (conflict) { setPlan(normalizePlanDocument(conflict.document)); setVersion(conflict.version); setConflict(null); setSaveState("saved"); } }}>加载服务器版本</button><button onClick={saveConflictAsNew}>另存为新计划</button></div>}
    <div className={`editor-table-grid ${gridClass}`}>
      <aside className={`left-table-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <><nav className="panel-tabs">{([['members','成员'],['skills','技能'],['groups','分组'],['presets','预设']] as const).map(([id,label]) => <button className={leftTab === id ? "active" : ""} key={id} onClick={() => setLeftTab(id)}>{label}</button>)}</nav>
        {leftTab === "members" && <div className="panel-body"><div className="table-tools"><span>{plan.roster.length}/40 人</span><button onClick={addMember}>＋ 添加</button></div><div className="dense-list">{plan.roster.map((member) => <button className={selection?.type === "member" && selection.id === member.id ? "selected" : ""} key={member.id} onClick={() => setSelection({ type: "member", id: member.id })}><i style={{ background: member.color }} /><span><strong>{member.name}</strong><small>{WOW_CLASS_LABELS[member.classSlug]} · {roleLabels[member.role]} · {plan.groups.find((group) => group.id === member.groupId)?.name ?? "未分组"}</small></span></button>)}</div></div>}
        {leftTab === "skills" && <div className="panel-body"><div className="table-tools"><button onClick={addCustomSkill}>＋ 自定义</button><label><input type="checkbox" checked={showAllSkills} onChange={(event) => setShowAllSkills(event.target.checked)} />显示全部</label></div><input className="panel-search" placeholder="搜索技能" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} /><div className="skill-list">{filteredCooldowns.map((cooldown) => <div className={selection?.type === "cooldown" && selection.id === cooldown.id ? "selected" : ""} key={cooldown.id}><button onClick={() => setSelection({ type: "cooldown", id: cooldown.id })}><i style={{ background: cooldown.color }} /><span><strong>{cooldown.name}</strong><small>{WOW_CLASS_LABELS[cooldown.classSlug]} · {cooldown.category} · {cooldown.durationMs == null ? "持续待补" : `${cooldown.durationMs / 1000}s`}</small></span></button><button title="添加分配" onClick={() => addAssignment(cooldown.id)}>＋</button></div>)}</div></div>}
        {leftTab === "groups" && <div className="panel-body"><div className="table-tools"><span>每人最多一个自定义组</span><button onClick={addGroup}>＋ 添加</button></div><div className="dense-list">{plan.groups.map((group) => <button className={selection?.type === "group" && selection.id === group.id ? "selected" : ""} key={group.id} onClick={() => setSelection({ type: "group", id: group.id })}><i style={{ background: group.color }} /><span><strong>{group.name}</strong><small>{plan.roster.filter((member) => member.groupId === group.id).length} 人</small></span></button>)}{!plan.groups.length && <p className="table-empty">可建立左场、右场等站位组。</p>}</div></div>}
        {leftTab === "presets" && <div className="panel-body"><div className="preset-actions"><button onClick={saveAsPreset}>保存当前完整计划</button><button onClick={() => importPresetRef.current?.click()}>导入 JSON</button><input ref={importPresetRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importPreset(file); event.currentTarget.value = ""; }} /></div><div className="preset-list">{[...BUILT_IN_PRESETS, ...personalPresets].map((preset) => <div key={preset.id}><span><strong>{preset.name}</strong><small>{preset.kind === "built-in" ? "内置" : "当前设备"} · {preset.description}</small></span><button onClick={() => applyPreset(preset)}>应用</button>{preset.kind === "personal" && <><button onClick={() => download(stringifyPreset(preset), `${preset.name}.raidline-preset.json`)}>导出</button><button onClick={async () => { if (confirm(`删除预设“${preset.name}”？`)) { await deletePersonalPreset(preset.id); setPersonalPresets(await listPersonalPresets()); } }}>删除</button></>}</div>)}</div></div>}
      </>}</aside>
      <section className="timeline-work-panel"><div className="axis-toolbar"><div><button onClick={() => setLeftCollapsed((value) => !value)}>成员/技能</button><b>{plan.encounter.difficulty}</b><span>{formatTime(plan.encounter.durationMs)}</span><span>{plan.mechanics.length} 机制</span><span>{plan.assignments.length} 分配</span></div><div><button onClick={() => addMechanic()}>＋ 机制</button><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /><button onClick={() => { setSelection(null); setRightCollapsed(false); }}>计划设置</button><button onClick={() => setRightCollapsed((value) => !value)}>属性/检查</button></div></div><div className="axis-scroll" ref={timelineRef}><TimelineView plan={plan} orientation={orientation} zoom={zoom} selected={timelineSelection} warningIds={warningIds} pressure={pressureMap} onSelect={(key) => { if (!key) setSelection(null); else { const [type,id] = key.split(":"); setSelection({ type: type as "mechanic" | "assignment", id }); } }} onAddMechanic={addMechanic} onMoveAssignment={moveAssignment} /></div><div className="axis-statusbar"><span>Ctrl + 滚轮缩放 · 双击空白添加机制 · 拖动技能调整开始时间</span><b className={warnings.length ? "warn" : "ok"}>{warnings.length ? `${warnings.length} 项提醒` : "检查通过"}</b></div></section>
      <aside className={`right-table-panel ${rightCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setRightCollapsed((value) => !value)}>{rightCollapsed ? "‹" : "›"}</button>{!rightCollapsed && <Inspector plan={plan} selection={selection} selectedMember={selectedMember} selectedGroup={selectedGroup} selectedMechanic={selectedMechanic} selectedCooldown={selectedCooldown} selectedAssignment={selectedAssignment} warnings={warnings} pressureMap={pressureMap} mutate={mutate} setSelection={setSelection} />}</aside>
    </div>
    {showWcl && <WclModal planId={planId} token={token} version={version} initialSource={wclInitial} onClose={() => { setShowWcl(false); setWclInitial(""); }} onImported={(value) => { undoStack.current.push(clonePlan(plan)); redoStack.current = []; editRevision.current += 1; setHistoryState({ canUndo: true, canRedo: false }); const document = normalizePlanDocument(value.document); setPlan(document); setStored({ ...value, document }); setVersion(value.version); setSaveState("saved"); setSelection(null); setShowWcl(false); rememberPlan(value, token); setToast("WCL 战报已导入，伤害数据等待补充"); }} />}
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
  pressureMap: Map<string, MechanicPressureResult>;
  mutate: MutatePlan;
  setSelection: Dispatch<SetStateAction<Selection>>;
}

function Inspector({ plan, selection, selectedMember, selectedGroup, selectedMechanic, selectedCooldown, selectedAssignment, warnings, pressureMap, mutate, setSelection }: InspectorProps) {
  const updateMechanic = (fn: (item: any) => void) => mutate((draft) => { const item = draft.mechanics.find((entry) => entry.id === selectedMechanic?.id); if (item) { fn(item); syncLinkedAssignments(draft, item.id); } });
  const updateCooldown = (fn: (item: CooldownDefinition) => void) => mutate((draft: RaidPlanDocument) => { const item = draft.cooldowns.find((entry) => entry.id === selectedCooldown?.id); if (item) { fn(item); item.dataStatus = "custom"; if (item.scope === "personal") { item.maxTargets = 1; for (const assignment of draft.assignments.filter((entry) => entry.cooldownId === item.id)) assignment.targets = { mode: "members", memberIds: [assignment.memberId] }; } } });
  if (!selection) return <PlanSettingsInspector plan={plan} warnings={warnings} mutate={mutate} setSelection={setSelection} />;
  if (selectedMember) return <div className="inspector"><header><h2>成员</h2><span>RAIDER</span></header><label>角色名<input value={selectedMember.name} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.name = event.target.value; })} /></label><label>职业<select value={selectedMember.classSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) { item.classSlug = event.target.value; item.color = WOW_CLASS_COLORS[event.target.value]; } })}>{Object.entries(WOW_CLASS_LABELS).map(([slug,label]) => <option value={slug} key={slug}>{label}</option>)}</select></label><label>专精<input value={selectedMember.specSlug} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.specSlug = event.target.value; })} /></label><label>职责<select value={selectedMember.role} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.role = event.target.value as any; })}><option value="tank">坦克</option><option value="healer">治疗</option><option value="damage">输出</option></select></label><label>自定义分组<select value={selectedMember.groupId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.roster.find((entry) => entry.id === selectedMember.id); if (item) item.groupId = event.target.value || undefined; })}><option value="">未分组</option>{plan.groups.map((group: any) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label><button className="danger-button" onClick={() => { if (confirm(`删除成员“${selectedMember.name}”及其分配？`)) mutate((draft: RaidPlanDocument) => { draft.roster = draft.roster.filter((entry) => entry.id !== selectedMember.id); draft.assignments = draft.assignments.filter((entry) => entry.memberId !== selectedMember.id); }, null); }}>删除成员</button></div>;
  if (selectedGroup) return <div className="inspector"><header><h2>分组</h2><span>GROUP</span></header><label>名称<input value={selectedGroup.name} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.groups.find((entry) => entry.id === selectedGroup.id); if (item) item.name = event.target.value; })} /></label><label>标识色<input type="color" value={selectedGroup.color} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.groups.find((entry) => entry.id === selectedGroup.id); if (item) item.color = event.target.value; })} /></label><p className="field-note">{plan.roster.filter((member: any) => member.groupId === selectedGroup.id).map((member: any) => member.name).join("、") || "暂无成员"}</p><button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.groups = draft.groups.filter((entry) => entry.id !== selectedGroup.id); draft.roster.forEach((member) => { if (member.groupId === selectedGroup.id) member.groupId = undefined; }); }, null)}>删除分组</button></div>;
  if (selectedMechanic) { const result = pressureMap.get(selectedMechanic.id); return <div className="inspector"><header><h2>机制</h2><span>MECHANIC</span></header><label>名称<input value={selectedMechanic.name} onChange={(event) => updateMechanic((item) => { item.name = event.target.value; })} /></label><label>简介<textarea value={selectedMechanic.description} onChange={(event) => updateMechanic((item) => { item.description = event.target.value; })} /></label><label>Boss 开始施法<TimeField value={selectedMechanic.atMs} onCommit={(value) => updateMechanic((item) => { item.atMs = snapTime(value, plan.settings.snapMs); })} /></label><label>所属阶段<select value={selectedMechanic.phaseId ?? ""} onChange={(event) => updateMechanic((item) => { item.phaseId = event.target.value || undefined; })}><option value="">未指定</option>{plan.phases.map((phase) => <option value={phase.id} key={phase.id}>{formatTime(phase.atMs)} {phase.name}</option>)}</select></label><div className="field-grid"><label>施法秒数<NullableNumber value={selectedMechanic.castTimeMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.castTimeMs = value; })} /></label><label>持续秒数<NullableNumber value={selectedMechanic.durationMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.durationMs = value; })} /></label></div><label>伤害类型<select value={selectedMechanic.damage.school} onChange={(event) => updateMechanic((item) => { item.damage.school = event.target.value; })}><option value="magic">魔法</option><option value="physical">物理</option></select></label><div className="field-grid"><label>直接伤害<NullableNumber value={selectedMechanic.damage.directAmount} onChange={(value) => updateMechanic((item) => { item.damage.directAmount = value; })} /></label><label>每跳伤害<NullableNumber value={selectedMechanic.damage.periodicAmount} onChange={(value) => updateMechanic((item) => { item.damage.periodicAmount = value; })} /></label></div><div className="field-grid"><label>跳伤间隔秒<NullableNumber value={selectedMechanic.damage.periodicIntervalMs} scale={1000} onChange={(value) => updateMechanic((item) => { item.damage.periodicIntervalMs = value; })} /></label><label className="inline-check"><input type="checkbox" checked={selectedMechanic.damage.tickOnStart} onChange={(event) => updateMechanic((item) => { item.damage.tickOnStart = event.target.checked; })} />首跳立即</label></div><label>目标<TargetEditor target={selectedMechanic.targets} plan={plan} onChange={(target) => updateMechanic((item) => { item.targets = target; })} /></label><label>危险等级<select value={selectedMechanic.severity} onChange={(event) => updateMechanic((item) => { item.severity = event.target.value; })}><option value="info">提示</option><option value="warning">常规</option><option value="danger">高危</option></select></label><label>计划备注<textarea value={selectedMechanic.note} onChange={(event) => updateMechanic((item) => { item.note = event.target.value; })} /></label><div className={`pressure-card ${result?.members.some((item: any) => item.lethal) ? "lethal" : ""}`}><span>最高个人治疗需求</span><strong>{formatCompactNumber(result?.headlinePressure)}</strong><small>单目标原始总量 {formatCompactNumber(result?.rawPerTarget)} · 平均 DPS {formatCompactNumber(result?.averageDps)}</small><small>团队本次伤害 {formatCompactNumber(result?.teamCurrentDamage)} · 团队相邻压力 {formatCompactNumber(result?.teamPressure)}</small>{result?.missing.map((item: string) => <em key={item}>{item}</em>)}{result?.members.map((item: any) => <p key={item.memberId}><b>{plan.roster.find((member: any) => member.id === item.memberId)?.name}</b><span>{formatCompactNumber(item.currentDamage)} + {formatCompactNumber(item.previousDamage)} = {formatCompactNumber(item.pressure)}</span>{item.lethal && <i>致死</i>}</p>)}</div><button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.mechanics = draft.mechanics.filter((entry) => entry.id !== selectedMechanic.id); draft.assignments = draft.assignments.map((entry) => entry.mechanicId === selectedMechanic.id ? { ...entry, mechanicId: undefined, offsetMs: undefined, targets: entry.targets.mode === "inherit" ? structuredClone(ALL_TARGETS) : entry.targets } : entry); }, null)}>删除机制</button></div>; }
  if (selectedCooldown && !selectedAssignment) return <SkillInspector cooldown={selectedCooldown} update={updateCooldown} mutate={mutate} />;
  if (selectedAssignment && selectedCooldown) return <div className="inspector"><header><h2>技能分配</h2><span>ASSIGNMENT</span></header><label>成员<select value={selectedAssignment.memberId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.memberId = event.target.value; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{plan.roster.map((member: any) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label><label>技能<select value={selectedAssignment.cooldownId} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.cooldownId = event.target.value; const cooldown = draft.cooldowns.find((entry) => entry.id === item.cooldownId); if (cooldown?.scope === "personal") item.targets = { mode: "members", memberIds: [item.memberId] }; })}>{plan.cooldowns.map((cooldown: any) => <option value={cooldown.id} key={cooldown.id}>{cooldown.name}</option>)}</select></label><label>开始施法<TimeField value={selectedAssignment.atMs} onCommit={(value) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; item.atMs = snapTime(value, draft.settings.snapMs); const mechanic = item.mechanicId ? draft.mechanics.find((entry) => entry.id === item.mechanicId) : undefined; if (mechanic) item.offsetMs = item.atMs - mechanicImpactMs(mechanic); })} /></label><label>关联机制<select value={selectedAssignment.mechanicId ?? ""} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (!item) return; const mechanic = draft.mechanics.find((entry) => entry.id === event.target.value); item.mechanicId = mechanic?.id; if (mechanic) { item.atMs = defaultAssignmentStart(draft, selectedCooldown, mechanic); item.offsetMs = item.atMs - mechanicImpactMs(mechanic); item.targets = selectedCooldown.scope === "personal" ? { mode: "members", memberIds: [item.memberId] } : structuredClone(INHERIT_TARGETS); } else { item.offsetMs = undefined; if (item.targets.mode === "inherit") item.targets = structuredClone(ALL_TARGETS); } })}><option value="">自由时间点</option>{plan.mechanics.map((mechanic: any) => <option value={mechanic.id} key={mechanic.id}>{formatTime(mechanic.atMs)} {mechanic.name}</option>)}</select></label>{selectedCooldown.scope === "personal" ? <div className="field-note"><b>实际目标：施放者本人</b><br />个人技能固定作用于当前成员，不能改为其他目标。</div> : <label>实际目标<TargetEditor target={selectedAssignment.targets} plan={plan} allowInherit onChange={(target) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.targets = target; })} /></label>}<label>备注<textarea value={selectedAssignment.note} onChange={(event) => mutate((draft: RaidPlanDocument) => { const item = draft.assignments.find((entry) => entry.id === selectedAssignment.id); if (item) item.note = event.target.value; })} /></label>{warnings.filter((warning: any) => warning.assignmentId === selectedAssignment.id).map((warning: any, index: number) => <div className="warning-box" key={`${warning.type}-${index}`}>{warning.message}</div>)}<button className="danger-button" onClick={() => mutate((draft: RaidPlanDocument) => { draft.assignments = draft.assignments.filter((entry) => entry.id !== selectedAssignment.id); }, null)}>删除分配</button></div>;
  return null;
}

function PlanSettingsInspector({ plan, warnings, mutate, setSelection }: { plan: RaidPlanDocument; warnings: ConflictWarning[]; mutate: MutatePlan; setSelection: Dispatch<SetStateAction<Selection>> }) {
  return <div className="inspector">
    <header><h2>计划设置</h2><span>PLAN</span></header>
    <label>计划名称<input value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /></label>
    <label>难度<select value={plan.encounter.difficulty} onChange={(event) => mutate((draft) => { draft.encounter.difficulty = event.target.value; })}><option>随机</option><option>普通</option><option>英雄</option><option>史诗</option><option>练习</option></select></label>
    <label>战斗时长<TimeField value={plan.encounter.durationMs} onCommit={(value) => mutate((draft) => { draft.encounter.durationMs = Math.max(10_000, value); })} /></label>
    <div className="field-grid"><label>参考最大生命<NullableNumber value={plan.settings.referenceMaxHealth} onChange={(value) => mutate((draft) => { draft.settings.referenceMaxHealth = value; })} /></label><label>时间吸附秒数<NullableNumber value={plan.settings.snapMs} scale={1000} min={0.1} onChange={(value) => mutate((draft) => { draft.settings.snapMs = value ?? 1000; })} /></label></div>
    <div className="field-grid"><label>压力刷新秒数<NullableNumber value={plan.settings.pressureResetMs} scale={1000} onChange={(value) => mutate((draft) => { draft.settings.pressureResetMs = value ?? 10_000; })} /></label><label>防御默认提前秒数<NullableNumber value={plan.settings.defensiveLeadMs} scale={1000} onChange={(value) => mutate((draft) => { draft.settings.defensiveLeadMs = value ?? 3000; })} /></label></div>
    <label className="inline-check"><input type="checkbox" checked={plan.settings.showMinorMechanics} onChange={(event) => mutate((draft) => { draft.settings.showMinorMechanics = event.target.checked; })} />显示次要机制</label>
    <section className="phase-editor">
      <header><b>阶段</b><button onClick={() => mutate((draft) => draft.phases.push({ id: makeId("phase"), name: `P${draft.phases.length + 1}`, atMs: Math.min(draft.encounter.durationMs, (draft.phases.at(-1)?.atMs ?? 0) + 60_000) }))}>＋ 阶段</button></header>
      {plan.phases.map((phase, index) => <div key={phase.id}><input aria-label={`阶段 ${index + 1} 名称`} value={phase.name} onChange={(event) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === phase.id); if (item) item.name = event.target.value; })} /><TimeField label={`阶段 ${index + 1} 时间`} value={phase.atMs} onCommit={(value) => mutate((draft) => { const item = draft.phases.find((entry) => entry.id === phase.id); if (item) item.atMs = snapTime(value, draft.settings.snapMs); })} />{plan.phases.length > 1 && <button aria-label={`删除阶段 ${phase.name}`} onClick={() => mutate((draft) => { draft.phases = draft.phases.filter((entry) => entry.id !== phase.id); draft.mechanics.forEach((item) => { if (item.phaseId === phase.id) item.phaseId = undefined; }); })}>×</button>}</div>)}
    </section>
    <Checks warnings={warnings} setSelection={setSelection} />
  </div>;
}

function SkillInspector({ cooldown, update, mutate }: { cooldown: CooldownDefinition; update: (fn: (item: CooldownDefinition) => void) => void; mutate: MutatePlan }) {
  function addEffect(type: CooldownEffect["type"]) {
    update((item) => {
      if (type === "damageReduction") item.effects.push({ type, percent: null, schools: ["physical", "magic"] });
      if (type === "absorb") item.effects.push({ type, amount: null, allocation: "perTarget", schools: ["physical", "magic"] });
      if (type === "maxHealth") item.effects.push({ type, percent: null });
      if (type === "immunity") item.effects.push({ type, schools: ["physical", "magic"] });
    });
  }
  function effectUpdate(index: number, values: Record<string, unknown>) {
    update((item) => Object.assign(item.effects[index] as unknown as Record<string, unknown>, values));
  }
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
    <div className="field-grid">
      <label>冷却秒数<NullableNumber value={cooldown.cooldownMs} scale={1000} onChange={(value) => update((item) => { item.cooldownMs = value; })} /></label>
      <label>最大目标数{cooldown.scope === "personal" ? <input value="1" disabled /> : <NullableNumber value={cooldown.maxTargets} onChange={(value) => update((item) => { item.maxTargets = value; })} />}</label>
    </div>
    <div className="field-grid">
      <label>施法秒数<NullableNumber value={cooldown.castTimeMs} scale={1000} onChange={(value) => update((item) => { item.castTimeMs = value; })} /></label>
      <label>持续秒数<NullableNumber value={cooldown.durationMs} scale={1000} onChange={(value) => update((item) => { item.durationMs = value; })} /></label>
    </div>
    <p className="field-note">留空表示未知；填写 0 表示明确瞬发或无持续时间。目录 {cooldown.catalogVersion}</p>
    <label>GCD<select value={cooldown.triggersGcd == null ? "unknown" : cooldown.triggersGcd ? "yes" : "no"} onChange={(event) => update((item) => { item.triggersGcd = event.target.value === "unknown" ? null : event.target.value === "yes"; })}><option value="unknown">未设置</option><option value="yes">占用 GCD</option><option value="no">不占用 GCD</option></select></label>
    <div className="effect-list">
      <div className="effect-tools"><span>计算效果</span><select defaultValue="" onChange={(event) => { if (event.target.value) addEffect(event.target.value as CooldownEffect["type"]); event.currentTarget.value = ""; }}><option value="">＋ 添加效果</option><option value="damageReduction">减伤</option><option value="absorb">吸收盾</option><option value="maxHealth">最大生命提升</option><option value="immunity">免疫</option></select></div>
      {cooldown.effects.map((effect,index) => <div className="effect-card" key={index}>
        <header><b>{{ damageReduction: "减伤", absorb: "吸收盾", maxHealth: "最大生命提升", immunity: "免疫" }[effect.type]}</b><button onClick={() => update((item) => { item.effects.splice(index,1); })}>删除</button></header>
        {effect.type === "damageReduction" && <label>减伤百分比<NullableNumber value={effect.percent} onChange={(value) => effectUpdate(index,{ percent:value })} /></label>}
        {effect.type === "absorb" && <><label>吸收量<NullableNumber value={effect.amount} onChange={(value) => effectUpdate(index,{ amount:value })} /></label><label>分配方式<select value={effect.allocation} onChange={(event) => effectUpdate(index,{ allocation:event.target.value })}><option value="perTarget">每目标独立</option><option value="shared">共享总池</option></select></label></>}
        {effect.type === "maxHealth" && <label>提升百分比<NullableNumber value={effect.percent} onChange={(value) => effectUpdate(index,{ percent:value })} /></label>}
        {effect.type !== "maxHealth" && <div className="check-grid">{(["physical","magic"] as const).map((school) => <label key={school}><input type="checkbox" checked={effect.schools.includes(school)} onChange={() => effectUpdate(index,{ schools: effect.schools.includes(school) ? effect.schools.filter((item) => item !== school) : [...effect.schools,school] })} />{school === "physical" ? "物理" : "魔法"}</label>)}</div>}
      </div>)}
    </div>
    <button className="danger-button" onClick={() => { if (confirm(`删除技能“${cooldown.name}”及其分配？`)) mutate((draft) => { draft.cooldowns = draft.cooldowns.filter((entry) => entry.id !== cooldown.id); draft.assignments = draft.assignments.filter((entry) => entry.cooldownId !== cooldown.id); }, null); }}>删除技能</button>
  </div>;
}

function Checks({ warnings, setSelection }: any) { return <div className="checks"><header><b>排轴检查</b><span>{warnings.length ? `${warnings.length} 项` : "通过"}</span></header>{warnings.slice(0,8).map((warning: any,index: number) => <button key={index} onClick={() => warning.assignmentId ? setSelection({ type:"assignment", id:warning.assignmentId }) : warning.mechanicId ? setSelection({ type:"mechanic", id:warning.mechanicId }) : null}>{warning.message}</button>)}</div>; }

function WclModal({ planId, token, version, initialSource, onClose, onImported }: { planId: string; token: string; version: number; initialSource: string; onClose: () => void; onImported: (plan: StoredPlan) => void }) {
  const [source,setSource] = useState(initialSource); const [preview,setPreview] = useState<WclPreview|null>(null); const [fightId,setFightId] = useState<number|null>(null); const [analysis,setAnalysis] = useState<WclImportAnalysis|null>(null); const [selected,setSelected] = useState<Set<number>>(new Set()); const [includeCooldowns,setIncludeCooldowns] = useState(true); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  async function request(body: unknown) { const response = await fetch(`/api/plans/${planId}/wcl/${analysis ? "import" : "preview"}`, { method:"POST", headers:{ authorization:`Bearer ${token}`, "content-type":"application/json" }, body:JSON.stringify(body) }); const payload = await response.json() as { data?: any; error?: ApiError }; if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "WCL 请求失败"); return payload.data; }
  async function previewReport() { setBusy(true); setError(""); try { const value = await request({ source }); setPreview(value); setFightId(value.fights[0]?.id ?? null); } catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败"); } finally { setBusy(false); } }
  async function analyzeFight() { if (!preview || fightId == null) return; setBusy(true); setError(""); try { const response = await fetch(`/api/plans/${planId}/wcl/import`, { method:"POST", headers:{ authorization:`Bearer ${token}`, "content-type":"application/json" }, body:JSON.stringify({ reportCode:preview.reportCode,fightId }) }); const payload = await response.json() as { data?: { analysis:WclImportAnalysis }; error?:ApiError }; if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "分析失败"); setAnalysis(payload.data.analysis); setSelected(new Set()); } catch(caught){ setError(caught instanceof Error?caught.message:"分析失败"); } finally { setBusy(false); } }
  async function applyImport() { if(!analysis)return; setBusy(true); setError(""); try { const response=await fetch(`/api/plans/${planId}/wcl/import`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({reportCode:analysis.reportCode,fightId:analysis.fight.id,selectedAbilityIds:[...selected],includeObservedCooldowns:includeCooldowns,baseVersion:version})}); const payload=await response.json() as {data?:StoredPlan;error?:ApiError}; if(!response.ok||!payload.data)throw new Error(payload.error?.message??"导入失败"); onImported(payload.data); }catch(caught){setError(caught instanceof Error?caught.message:"导入失败");}finally{setBusy(false);} }
  return <div className="modal-backdrop"><div className="wcl-dialog"><header><div><strong>WCL 导入</strong><small>仅公开战报</small></div><button onClick={onClose}>×</button></header>{!preview && <div className="dialog-body"><label>战报链接或代码<input value={source} onChange={(event)=>setSource(event.target.value)} /></label><button className="primary-action" onClick={previewReport} disabled={busy}>{busy?"读取中…":"读取场次"}</button>{error&&<p className="dialog-error">{error}</p>}</div>}{preview&&!analysis&&<div className="dialog-body"><label>选择场次<select value={fightId??""} onChange={(event)=>setFightId(Number(event.target.value))}>{preview.fights.map((fight)=><option value={fight.id} key={fight.id}>{fight.name} · {fight.difficultyLabel} · {formatTime(fight.durationMs)}</option>)}</select></label><button className="primary-action" onClick={analyzeFight} disabled={busy||fightId==null}>{busy?"分析中…":"分析敌方施法"}</button>{error&&<p className="dialog-error">{error}</p>}</div>}{analysis&&<div className="dialog-body"><h3>{analysis.fight.name}</h3><p>勾选要加入时间线的 Boss 施法。伤害、施法长度和持续时间会保持待补充。</p><div className="ability-checks">{analysis.abilityGroups.map((group)=><label key={group.spellId}><input type="checkbox" checked={selected.has(group.spellId)} onChange={(event)=>setSelected((current)=>{const next=new Set(current);if(event.target.checked){next.add(group.spellId);}else{next.delete(group.spellId);}return next;})}/><span><b>{group.name}</b><small>{group.count} 次 · 首次 {formatTime(group.timestamps[0]??0)}</small></span></label>)}</div><label className="inline-check"><input type="checkbox" checked={includeCooldowns} onChange={(event)=>setIncludeCooldowns(event.target.checked)} />导入已识别的玩家技能施放</label><button className="primary-action" onClick={applyImport} disabled={busy}>{busy?"导入中…":"替换当前时间线"}</button>{error&&<p className="dialog-error">{error}</p>}</div>}</div></div>;
}
