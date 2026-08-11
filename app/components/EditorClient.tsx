"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */

import { useEffect, useMemo, useRef, useState } from "react";
import { catalogDifference, ensureCatalogSkillSnapshot, SEED_CATALOG, upgradeCatalogSkillSnapshots } from "@/lib/catalog";
import { cooldownsForMember, specializationFor, specializationsForClass, WOW_CLASS_COLORS, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import {
  ALL_TARGETS,
  INHERIT_TARGETS,
  buildTimelineScene,
  createMechanicDefinition,
  defaultAssignmentAnchor,
  detectConflicts,
  exportPlan,
  formatTime,
  hasBlockingDiagnostics,
  makeId,
  moveAnchorTo,
  parsePlanDocument,
  parseTime,
  resolveMechanicPoint,
  resolveTimelineAnchor,
  snapTime,
  validatePlanSemantics,
} from "@/lib/core";
import type { ConflictWarning, PlanDiagnostic } from "@/lib/core";
import { hashPlanDocument } from "@/lib/hashing";
import { randomBase62 } from "@/lib/publication-ids";
import { memberSkillVariantId, resolveSkillForMember, resolveSkillVariant, setMemberSkillVariant, skillDataStatusLabel } from "@/lib/skills";
import type {
  ApiError,
  CatalogRelease,
  CatalogSkillDefinition,
  LocalPlanRecord,
  MemberSelector,
  MechanicDefinitionSnapshot,
  MechanicOccurrence,
  PlanSnapshot,
  PlayerSkillDefinitionSnapshot,
  PublicPublication,
  PublicationBinding,
  RaidPhase,
  RaidPlanDocument,
  RosterSlot,
  SkillAssignment,
  SkillTargetSelector,
  TacticalDirective,
  TimelineAnchor,
} from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView, type TimelineSelectionKey } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { cacheCatalog, createLocalPlan, createPlanSnapshot, getCachedCatalog, getLocalPlan, listPlanSnapshots, LocalRevisionConflictError, saveLocalPlan, setPlanPublication } from "./local-store";

type TimelineObjectSelection = { type: "mechanic" | "assignment" | "phase" | "directive"; id: string };
type Selection = TimelineObjectSelection | { type: "member" | "skill"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type PanelMode = "object" | "skills" | "history" | "checks" | "catalog";
type MutatePlan = (mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) => void;

const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;
const castTypeLabels = { unknown: "待配置", instant: "瞬发", cast: "读条", channel: "引导" } as const;

function clonePlan(plan: RaidPlanDocument) { return structuredClone(plan); }
function catalogSkillForPicker(item: CatalogSkillDefinition): PlayerSkillDefinitionSnapshot {
  const { enabled: _enabled, ...definition } = item;
  void _enabled;
  return structuredClone(definition);
}
function entityCounts(plan: RaidPlanDocument) {
  return [plan.roster.members.length, plan.roster.groups.length, plan.definitions.mechanics.length, plan.definitions.skills.length, plan.timeline.phases.length, plan.timeline.mechanics.length, plan.timeline.directives.length, plan.timeline.skillAssignments.length];
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
  return `mechanic:${anchor.mechanicOccurrenceId}:${anchor.point}`;
}

function anchorForRelation(plan: RaidPlanDocument, relation: string, atMs: number): TimelineAnchor {
  const snapped = snapTime(atMs);
  if (relation === "pull") return { kind: "pull", offsetMs: snapped };
  const [kind, id, point] = relation.split(":");
  if (kind === "phase") {
    const phase = plan.timeline.phases.find((item) => item.id === id);
    return phase ? { kind: "phase", phaseId: id, offsetMs: Math.round((snapped - phase.estimatedStartMs) / 1000) * 1000 } : { kind: "pull", offsetMs: snapped };
  }
  const base = resolveMechanicPoint(plan, id, point as "cast-start" | "impact" | "end");
  return base.ok ? { kind: "mechanic", mechanicOccurrenceId: id, point: point as "cast-start" | "impact" | "end", offsetMs: Math.round((snapped - base.atMs) / 1000) * 1000 } : { kind: "pull", offsetMs: snapped };
}

function AnchorEditor({ plan, anchor, onChange }: { plan: RaidPlanDocument; anchor: TimelineAnchor; onChange: (anchor: TimelineAnchor) => void }) {
  const absolute = anchorAbsoluteTime(plan, anchor);
  return <>
    <label>时间关系<select value={anchorRelationValue(anchor)} onChange={(event) => onChange(anchorForRelation(plan, event.target.value, absolute))}>
      <option value="pull">开怪后</option>
      {plan.timeline.phases.map((phase) => <option key={phase.id} value={`phase:${phase.id}`}>{phase.name} 开始后</option>)}
      {plan.timeline.mechanics.flatMap((occurrence) => {
        const name = plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId)?.name ?? "未知机制";
        return (["cast-start", "impact", "end"] as const).map((point) => <option key={`${occurrence.id}:${point}`} value={`mechanic:${occurrence.id}:${point}`}>{name} · {{ "cast-start": "施法开始", impact: "命中", end: "结束" }[point]}</option>);
      })}
    </select></label>
    <label>解析时间<TimeField value={absolute} onCommit={(value) => onChange(moveAnchorTo(plan, anchor, value))} /></label>
    {anchor.kind !== "pull" && <p className="field-note">拖动只改变相对偏移，不会解除当前关联。</p>}
  </>;
}

function TargetEditor({ target, plan, allowMechanicTargets = false, onChange }: { target: MemberSelector | SkillTargetSelector; plan: RaidPlanDocument; allowMechanicTargets?: boolean; onChange: (target: MemberSelector | SkillTargetSelector) => void }) {
  const modes = [
    ...(allowMechanicTargets ? [{ value: "mechanic-targets", label: "继承锚定机制目标" }] : []),
    { value: "all", label: "全团" }, { value: "groups", label: "策略组" }, { value: "roles", label: "职责" }, { value: "subgroups", label: "小队" }, { value: "members", label: "具体成员" },
  ];
  function changeKind(kind: string) {
    if (kind === "mechanic-targets") onChange({ kind });
    else if (kind === "all") onChange({ kind });
    else if (kind === "groups") onChange({ kind, groupIds: [] });
    else if (kind === "roles") onChange({ kind, roles: [] });
    else if (kind === "subgroups") onChange({ kind, subgroups: [] });
    else onChange({ kind: "members", memberIds: [] });
  }
  function toggleString(kind: "groups" | "roles" | "members", value: string) {
    if (kind === "groups" && target.kind === "groups") {
      const current = new Set(target.groupIds); if (current.has(value)) current.delete(value); else current.add(value); onChange({ kind, groupIds: [...current] });
    } else if (kind === "roles" && target.kind === "roles") {
      const role = value as keyof typeof roleLabels; const current = new Set(target.roles); if (current.has(role)) current.delete(role); else current.add(role); onChange({ kind, roles: [...current] });
    } else if (kind === "members" && target.kind === "members") {
      const current = new Set(target.memberIds); if (current.has(value)) current.delete(value); else current.add(value); onChange({ kind, memberIds: [...current] });
    }
  }
  function toggleSubgroup(value: number) {
    if (target.kind !== "subgroups") return;
    const current = new Set(target.subgroups);
    if (current.has(value)) current.delete(value); else current.add(value);
    onChange({ kind: "subgroups", subgroups: [...current].sort((a, b) => a - b) });
  }
  return <div className="target-editor"><select value={target.kind} onChange={(event) => changeKind(event.target.value)}>{modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select>
    {target.kind === "groups" && <div className="check-grid">{plan.roster.groups.map((group) => <label key={group.id}><input type="checkbox" checked={target.groupIds.includes(group.id)} onChange={() => toggleString("groups", group.id)} />{group.name}</label>)}</div>}
    {target.kind === "roles" && <div className="check-grid">{Object.entries(roleLabels).map(([role, label]) => <label key={role}><input type="checkbox" checked={target.roles.includes(role as keyof typeof roleLabels)} onChange={() => toggleString("roles", role)} />{label}</label>)}</div>}
    {target.kind === "subgroups" && <div className="check-grid">{Array.from({ length: 8 }, (_, index) => index + 1).map((subgroup) => <label key={subgroup}><input type="checkbox" checked={target.subgroups.includes(subgroup)} onChange={() => toggleSubgroup(subgroup)} />{subgroup} 队</label>)}</div>}
    {target.kind === "members" && <div className="check-grid">{plan.roster.members.map((member) => <label key={member.id}><input type="checkbox" checked={target.memberIds.includes(member.id)} onChange={() => toggleString("members", member.id)} />{member.name}</label>)}</div>}
  </div>;
}

function skillTimingSummary(skill: PlayerSkillDefinitionSnapshot) {
  const cooldown = skill.cooldownMs == null ? "冷却待补" : `${skill.cooldownMs / 1000} 秒冷却`;
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
      try {
        const [local, localSnapshots, cached] = await Promise.all([getLocalPlan(planId), listPlanSnapshots(planId), getCachedCatalog()]);
        if (!local) throw new Error("这条本地轴不存在，可能已被删除或属于旧版测试数据。");
        const document = parsePlanDocument(local.document);
        if (cancelled) return;
        setRecord({ ...local, document }); setPlan(document); planRef.current = document;
        setLocalRevision(local.localRevision); localRevisionRef.current = local.localRevision;
        setSnapshots(localSnapshots); if (cached) setCatalog(cached);
        const view = JSON.parse(localStorage.getItem(viewPreferenceKey("plan", planId, innerWidth)) ?? "null") as { orientation?: TimelineOrientation; zoom?: number; leftCollapsed?: boolean } | null;
        setViewWidth(innerWidth); setOrientation(view?.orientation ?? defaultOrientation(innerWidth)); setZoom(Math.max(1, view?.zoom ?? 1)); setLeftCollapsed(view?.leftCollapsed ?? innerWidth < 720); setViewReady(true);
        fetch("/api/catalog/current").then(async (response) => {
          const payload = await response.json() as { data?: CatalogRelease };
          if (response.ok && payload.data) { await cacheCatalog(payload.data); if (!cancelled) setCatalog(payload.data); }
        }).catch(() => undefined);
      } catch (error) { if (!cancelled) setFatal(error instanceof Error ? error.message : "读取本地计划失败"); }
    });
    return () => { cancelled = true; };
  }, [planId]);

  useEffect(() => { if (viewReady) localStorage.setItem(viewPreferenceKey("plan", planId, viewWidth), JSON.stringify({ orientation, zoom, leftCollapsed })); }, [leftCollapsed, orientation, planId, viewReady, viewWidth, zoom]);

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

  const scene = useMemo(() => plan ? buildTimelineScene(plan) : null, [plan]);
  const conflicts = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);
  const diagnostics = useMemo(() => scene?.diagnostics ?? [], [scene]);
  const warningIds = useMemo(() => new Set([...conflicts.map((item) => item.assignmentId), ...diagnostics.flatMap((item) => item.objectId ? [item.objectId] : [])]), [conflicts, diagnostics]);
  const skillMember = plan?.roster.members.find((item) => item.id === skillMemberId);
  const availableSkills = useMemo(() => {
    const merged = new Map((plan?.definitions.skills ?? []).map((item) => [item.id, item]));
    for (const item of catalog.playerSkills) if (item.enabled && !merged.has(item.id)) merged.set(item.id, catalogSkillForPicker(item));
    return cooldownsForMember([...merged.values()], skillMember);
  }, [catalog.playerSkills, plan?.definitions.skills, skillMember]);

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
    mutate((draft) => draft.roster.members.push({ id, name: `成员 ${String(draft.roster.members.length + 1).padStart(2, "0")}`, classSlug: null, specSlug: null, role: null, color: "#7b8490", groupIds: [], subgroup: null }), { type: "member", id });
    setPanelMode("object"); setLeftCollapsed(false);
  }
  function addMechanic(atMs: number) {
    const definition = createMechanicDefinition(); definition.gameVersion = activePlan.encounter.gameVersion;
    const occurrence: MechanicOccurrence = { id: makeId(), definitionId: definition.id, anchor: { kind: "pull", offsetMs: snapTime(atMs) } };
    mutate((draft) => { draft.definitions.mechanics.push(definition); draft.timeline.mechanics.push(occurrence); }, { type: "mechanic", id: occurrence.id }); setPanelMode("object"); setLeftCollapsed(false);
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
  function addCustomSkill() {
    if (!skillMember?.classSlug) { setToast("请先为成员选择职业"); return; }
    const skill: PlayerSkillDefinitionSnapshot = { id: makeId(), name: "自定义技能", description: "", gameVersion: activePlan.encounter.gameVersion, classSlug: skillMember.classSlug, specSlugs: skillMember.specSlug ? [skillMember.specSlug] : [], scope: "team", cooldownMs: null, castType: "unknown", castTimeMs: null, durationMs: null, triggersGcd: null, maxCharges: 1, maxTargets: null, effects: [], variants: [], limitations: [], category: "自定义", color: WOW_CLASS_COLORS[skillMember.classSlug] ?? "#7b8490", dataStatus: "custom" };
    mutate((draft) => draft.definitions.skills.push(skill), { type: "skill", id: skill.id }); setPanelMode("object");
  }
  function addAssignment(skillDefinitionId: string, variantId?: string) {
    const member = activePlan.roster.members.find((item) => item.id === skillMemberId); if (!member) return;
    const preview = clonePlan(activePlan);
    let skill: PlayerSkillDefinitionSnapshot;
    try { skill = ensureCatalogSkillSnapshot(preview, catalog, skillDefinitionId); }
    catch { setToast("目录中找不到可用的技能定义"); return; }
    const currentVariant = memberSkillVariantId(activePlan, member.id, skill.id);
    const hasUses = activePlan.timeline.skillAssignments.some((item) => item.memberId === member.id && item.skillDefinitionId === skill.id);
    if (currentVariant !== variantId && hasUses && !confirm(`将 ${member.name} 的“${skill.name}”全部切换为${variantId ? `“${skill.variants.find((item) => item.id === variantId)?.name}”` : "基础版本"}？`)) return;
    setMemberSkillVariant(preview, member.id, skill.id, variantId); const resolved = resolveSkillForMember(preview, member.id, skill.id); if (!resolved) return;
    const selectedOccurrence = selection?.type === "mechanic" ? activePlan.timeline.mechanics.find((item) => item.id === selection.id) : undefined;
    const anchor = selectedOccurrence ? defaultAssignmentAnchor(activePlan, resolved, selectedOccurrence) : { kind: "pull" as const, offsetMs: snapTime(skillInsertionMs) };
    const assignment: SkillAssignment = { id: makeId(), memberId: member.id, skillDefinitionId: skill.id, anchor, targets: resolved.scope === "personal" ? { kind: "members", memberIds: [member.id] } : selectedOccurrence ? structuredClone(INHERIT_TARGETS) : structuredClone(ALL_TARGETS), note: "" };
    mutate((draft) => { ensureCatalogSkillSnapshot(draft, catalog, skill.id); setMemberSkillVariant(draft, member.id, skill.id, variantId); draft.timeline.skillAssignments.push(assignment); }, { type: "assignment", id: assignment.id }); setPanelMode("object");
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
  async function upgradeCatalog() {
    const difference = catalogDifference(activePlan, catalog);
    if (!difference.versionChanged || difference.addedSkills + difference.changedSkills + difference.removedSkills === 0) { setToast("当前计划已使用最新技能目录"); return; }
    if (!confirm(`升级到目录 ${difference.availableVersion}？计划内技能定义会更新，自定义技能与时间轴不会改变。`)) return;
    await createPlanSnapshot(planId, "catalog-upgrade", activePlan, localRevisionRef.current);
    try { replacePlan(upgradeCatalogSkillSnapshots(activePlan, catalog)); setPanelMode("object"); await refreshSnapshots(); setToast("技能目录已升级；时间轴和机制快照保持不变"); }
    catch (error) { setToast(error instanceof Error ? error.message : "技能目录升级失败"); }
  }
  async function confirmPublication(shareId: string, editId: string, expectedHash: string) {
    const response = await fetch(`/api/publications/${shareId}`); const payload = await response.json() as { data?: PublicPublication };
    if (!response.ok || payload.data?.contentHash !== expectedHash) return null;
    return { shareId, editId, revisionId: payload.data.revisionId, publishedAt: payload.data.publishedAt, contentHash: payload.data.contentHash } satisfies PublicationBinding;
  }
  async function publish(mode: "new" | "overwrite") {
    const semantic = validatePlanSemantics(activePlan); if (hasBlockingDiagnostics(semantic)) { setToast(semantic.find((item) => item.severity === "error")?.message ?? "计划存在阻断错误"); setPanelMode("checks"); setLeftCollapsed(false); return; }
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
    const result = exportPlan({ target: "mrt-reading", document: activePlan }); const error = result.diagnostics.find((item) => item.severity === "error");
    if (error) { setToast(error.message); setPanelMode("checks"); setLeftCollapsed(false); return; }
    copyText(result.text, result.diagnostics.length ? `MRT 已复制，含 ${result.diagnostics.length} 项降级提示` : "MRT 已复制");
  }

  const timelineSelection: TimelineSelectionKey = selection && ["mechanic", "assignment", "phase", "directive"].includes(selection.type) ? `${selection.type as TimelineObjectSelection["type"]}:${selection.id}` : null;
  const catalogUpdate = catalogDifference(plan, catalog); const hasCatalogUpdate = catalogUpdate.versionChanged && catalogUpdate.addedSkills + catalogUpdate.changedSkills + catalogUpdate.removedSkills > 0;
  const publicationDirty = Boolean(record.activePublication && currentHash && record.activePublication.contentHash !== currentHash);

  return <main className="editor-workspace" data-local-revision={localRevision}>
    <header className="editor-utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>团轴</strong></a><div className="plan-name"><input aria-label="计划名称" value={plan.metadata.title} onChange={(event) => mutate((draft) => { draft.metadata.title = event.target.value; })} /><span className={`save-state ${saveState}`}>{{ saved: "本地已保存", dirty: "本地待保存", saving: "本地保存中", error: "本地保存失败", conflict: "标签页冲突" }[saveState]}</span><span className={`publication-state ${publicationDirty ? "dirty" : record.activePublication ? "published" : "unpublished"}`}>{record.activePublication ? publicationDirty ? "存在未发布修改" : "服务器已发布" : "尚未发布"}</span></div><div className="header-actions"><button onClick={undo} disabled={!historyState.canUndo}>撤销</button><button onClick={redo} disabled={!historyState.canRedo}>重做</button><button onClick={exportMrt}>MRT</button><details className="header-menu"><summary>工具</summary><div><button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanelMode("history"); setLeftCollapsed(false); }}>历史</button>{hasCatalogUpdate && <button onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setPanelMode("catalog"); setLeftCollapsed(false); }}>查看技能更新</button>}</div></details>{record.activePublication && <><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}`, "只读链接已复制")}>复制分享链接</button><button onClick={() => copyText(`${location.origin}/s/${record.activePublication!.shareId}/${record.activePublication!.editId}`, "编辑链接已复制")}>复制编辑链接</button><button disabled={Boolean(publishing)} onClick={() => publish("overwrite")}>覆盖当前链接</button></>}<button disabled={Boolean(publishing)} onClick={() => publish("new")}>{record.activePublication ? "发布为新链接" : "发布并创建链接"}</button>{record.activePublication && <button className="danger-link" disabled={Boolean(publishing)} onClick={removePublication}>删除发布</button>}<ThemeControl compact /></div></header>
    {saveState === "conflict" && <div className="conflict-banner"><span>另一个标签页已保存了更新；当前标签页没有覆盖它。</span><button onClick={() => { if (conflict) { const next = parsePlanDocument(conflict.document); setPlan(next); planRef.current = next; setRecord(conflict); setLocalRevision(conflict.localRevision); localRevisionRef.current = conflict.localRevision; setConflict(null); setSaveState("saved"); } }}>加载较新本地版本</button><button onClick={async () => { const copy = await createLocalPlan(activePlan); location.assign(`/plans/${copy.id}`); }}>将当前内容另存为副本</button></div>}
    <div className={`editor-table-grid ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`left-table-panel context-panel ${leftCollapsed ? "collapsed" : ""}`}><button className="panel-collapse" onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "›" : "‹"}</button>{!leftCollapsed && <>
        {panelMode === "skills" && <div className="panel-body skill-picker"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>选择技能与变体</b></header><p className="skill-target">分配给：<b>{skillMember?.name}</b><small>{formatTime(skillInsertionMs)} 附近</small></p>{skillMember && !skillMember.specSlug && <p className="field-note">未选择专精；当前只显示职业通用技能。</p>}<button className="secondary-action" onClick={addCustomSkill}>＋ 添加自定义技能</button><div className="skill-list grouped-skill-list">{availableSkills.map((skill) => <section className="skill-group" key={skill.id}><button className="skill-definition" onClick={() => { setSelection({ type: "skill", id: skill.id }); setPanelMode("object"); }}><i style={{ background: skill.color }} /><span><strong>{skill.name}</strong><small>{skill.category} · {skillDataStatusLabel(skill.dataStatus)}</small></span></button><div className="skill-variant-list"><button className={!memberSkillVariantId(plan, skillMemberId, skill.id) ? "active" : ""} onClick={() => addAssignment(skill.id)}><span>基础</span><small>{skillTimingSummary(skill)}</small><b>＋</b></button>{skill.variants.map((variant) => { const resolved = resolveSkillVariant(skill, variant.id); return <button key={variant.id} className={memberSkillVariantId(plan, skillMemberId, skill.id) === variant.id ? "active" : ""} onClick={() => addAssignment(skill.id, variant.id)}><span>{variant.name}</span><small>{skillTimingSummary(resolved)}</small><b>＋</b></button>; })}</div></section>)}{!availableSkills.length && <p className="table-empty">当前职业或专精暂无可用技能，可创建自定义技能。</p>}</div></div>}
        {panelMode === "history" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>历史检查点</b></header><div className="snapshot-list">{snapshots.slice(0, 30).map((snapshot) => <button key={snapshot.id} onClick={async () => { if (!confirm(`恢复 ${new Date(snapshot.createdAt).toLocaleString("zh-CN")} 的检查点？`)) return; await createPlanSnapshot(planId, "destructive", activePlan, localRevisionRef.current); replacePlan(snapshot.document); setPanelMode("object"); await refreshSnapshots(); }}><span>{new Date(snapshot.createdAt).toLocaleString("zh-CN")}</span><small>{{ minute: "自动", publish: "发布前", preset: "预设前", "catalog-upgrade": "目录升级前", destructive: "操作前", manual: "手动" }[snapshot.reason]}</small></button>)}{!snapshots.length && <p className="table-empty">尚无可恢复的检查点。</p>}</div></div>}
        {panelMode === "checks" && <Checks conflicts={conflicts} diagnostics={diagnostics} onSelect={(type, id) => revealSelection({ type, id }, true)} onBack={() => setPanelMode("object")} />}
        {panelMode === "catalog" && <div className="panel-body"><header className="context-heading"><button onClick={() => setPanelMode("object")}>← 返回</button><b>技能目录更新</b></header><div className="catalog-summary"><p>技能新增 {catalogUpdate.addedSkills} 项、更新 {catalogUpdate.changedSkills} 项、移除 {catalogUpdate.removedSkills} 项。</p><small>只更新计划内的目录技能定义；自定义技能、机制和时间轴保持不变。</small><button className="primary-action" onClick={upgradeCatalog}>确认升级</button></div></div>}
        {panelMode === "object" && <Inspector plan={plan} selection={selection} mutate={mutate} conflicts={conflicts} />}
      </>}</aside>
      <section className="timeline-work-panel"><div className="axis-toolbar"><strong>时间轴</strong><div><button onClick={() => setOrientation((value) => value === "horizontal" ? "vertical" : "horizontal")}>{orientation === "horizontal" ? "时间横向" : "时间纵向"}</button><ZoomControl zoom={zoom} onChange={setZoom} /></div></div><div className="axis-scroll" ref={timelineRef} onScroll={(event) => setTimelineScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}><TimelineView scene={scene} orientation={orientation} zoom={zoom} scrollOffset={timelineScroll} selected={timelineSelection} warningIds={warningIds} onSelect={(key) => { if (!key) return; const separator = key.indexOf(":"); revealSelection({ type: key.slice(0, separator) as TimelineObjectSelection["type"], id: key.slice(separator + 1) }); }} onSelectMember={(id) => revealSelection({ type: "member", id })} onOpenMemberSkills={openMemberSkills} onAddMember={addMember} onAddPhase={addPhase} onAddDirective={addDirective} onAddMechanic={addMechanic} onMovePhase={(id, atMs) => moveTimelineObject("phase", id, atMs)} onMoveDirective={(id, atMs) => moveTimelineObject("directive", id, atMs)} onMoveMechanic={(id, atMs) => moveTimelineObject("mechanic", id, atMs)} onMoveAssignment={(id, atMs) => moveTimelineObject("assignment", id, atMs)} /></div><div className="axis-statusbar"><span>Ctrl + 滚轮缩放 · 拖动只改变锚点偏移 · 左侧显示当前对象</span><button className={conflicts.length + diagnostics.length ? "warn" : "ok"} onClick={() => { setPanelMode("checks"); setLeftCollapsed(false); }}>{conflicts.length + diagnostics.length ? `${conflicts.length + diagnostics.length} 项提醒` : "检查通过"}</button></div></section>
    </div>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
  </main>;
}

function Checks({ conflicts, diagnostics, onSelect, onBack }: { conflicts: ConflictWarning[]; diagnostics: PlanDiagnostic[]; onSelect: (type: TimelineObjectSelection["type"], id: string) => void; onBack: () => void }) {
  return <div className="panel-body"><header className="context-heading"><button onClick={onBack}>← 返回</button><b>排轴检查</b></header><div className="checks"><header><b>结构与语义</b><span>{diagnostics.length}</span></header>{diagnostics.map((item, index) => <button key={`${item.code}-${item.objectId}-${index}`} className={item.severity === "error" ? "danger-text" : ""} onClick={() => { if (!item.objectId) return; if (["MISSING_SKILL_DEFINITION", "SKILL_MEMBER_MISMATCH", "INVALID_INHERITED_TARGETS"].includes(item.code)) onSelect("assignment", item.objectId); else if (["MISSING_MECHANIC_DEFINITION", "ANCHOR_CYCLE", "MISSING_MECHANIC"].includes(item.code)) onSelect("mechanic", item.objectId); else if (item.code.includes("PHASE")) onSelect("phase", item.objectId); else onSelect("directive", item.objectId); }}>{item.severity === "error" ? "阻断：" : "提醒："}{item.message}</button>)}{!diagnostics.length && <p className="table-empty">结构与引用检查通过。</p>}</div><div className="checks"><header><b>技能安排</b><span>{conflicts.length}</span></header>{conflicts.map((item, index) => <button key={`${item.assignmentId}-${item.type}-${index}`} onClick={() => onSelect("assignment", item.assignmentId)}>{item.message}</button>)}{!conflicts.length && <p className="table-empty">技能冷却与施法检查通过。</p>}</div></div>;
}

function Inspector({ plan, selection, mutate, conflicts }: { plan: RaidPlanDocument; selection: Selection; mutate: MutatePlan; conflicts: ConflictWarning[] }) {
  const member = selection?.type === "member" ? plan.roster.members.find((item) => item.id === selection.id) : undefined;
  const phase = selection?.type === "phase" ? plan.timeline.phases.find((item) => item.id === selection.id) : undefined;
  const directive = selection?.type === "directive" ? plan.timeline.directives.find((item) => item.id === selection.id) : undefined;
  const occurrence = selection?.type === "mechanic" ? plan.timeline.mechanics.find((item) => item.id === selection.id) : undefined;
  const assignment = selection?.type === "assignment" ? plan.timeline.skillAssignments.find((item) => item.id === selection.id) : undefined;
  const directSkill = selection?.type === "skill" ? plan.definitions.skills.find((item) => item.id === selection.id) : undefined;
  const skill = directSkill ?? (assignment ? plan.definitions.skills.find((item) => item.id === assignment.skillDefinitionId) : undefined);
  const definition = occurrence ? plan.definitions.mechanics.find((item) => item.id === occurrence.definitionId) : undefined;

  if (!selection) return <div className="inspector"><header><h2>计划与遭遇</h2><span>PLAN</span></header><label>Boss / 遭遇名称<input value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /></label><label>游戏版本<input value={plan.encounter.gameVersion} onChange={(event) => mutate((draft) => { draft.encounter.gameVersion = event.target.value; })} /></label><p className="field-note">点击右侧成员、机制、阶段、任务、说明或技能安排，可在这里编辑。计划名称在页头独立维护。</p></div>;
  if (member) return <MemberInspector plan={plan} member={member} mutate={mutate} />;
  if (phase) return <PhaseInspector phase={phase} mutate={mutate} />;
  if (directive) return <DirectiveInspector plan={plan} directive={directive} mutate={mutate} />;
  if (occurrence && definition) return <MechanicInspector plan={plan} occurrence={occurrence} definition={definition} mutate={mutate} />;
  if (assignment && skill) return <AssignmentInspector plan={plan} assignment={assignment} skill={skill} conflicts={conflicts.filter((item) => item.assignmentId === assignment.id)} mutate={mutate} />;
  if (directSkill) return <SkillInspector plan={plan} skill={directSkill} mutate={mutate} />;
  return <div className="context-empty"><b>对象已不存在</b><p>它可能刚刚被删除。</p></div>;
}

function MemberInspector({ plan, member, mutate }: { plan: RaidPlanDocument; member: RosterSlot; mutate: MutatePlan }) {
  const specs = specializationsForClass(member.classSlug ?? "");
  function update(fn: (item: RosterSlot) => void) { mutate((draft) => { const item = draft.roster.members.find((entry) => entry.id === member.id); if (item) fn(item); }); }
  return <div className="inspector"><header><h2>成员</h2><span>ROSTER SLOT</span></header><label>角色名<input value={member.name} onChange={(event) => update((item) => { item.name = event.target.value; })} /></label><label>职业<select value={member.classSlug ?? ""} onChange={(event) => update((item) => { item.classSlug = event.target.value || null; item.specSlug = null; item.role = null; item.color = event.target.value ? WOW_CLASS_COLORS[event.target.value] ?? item.color : "#7b8490"; })}><option value="">待选择</option>{Object.entries(WOW_CLASS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>专精<select disabled={!member.classSlug} value={member.specSlug ?? ""} onChange={(event) => update((item) => { item.specSlug = event.target.value || null; item.role = event.target.value ? specializationFor(item.classSlug ?? "", event.target.value)?.role ?? item.role : null; })}><option value="">待选择</option>{specs.map((spec) => <option key={spec.slug} value={spec.slug}>{spec.label}</option>)}</select></label><label>职责<select value={member.role ?? ""} onChange={(event) => update((item) => { item.role = event.target.value ? event.target.value as RosterSlot["role"] : null; })}><option value="">待选择</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>小队<select value={member.subgroup ?? ""} onChange={(event) => update((item) => { item.subgroup = event.target.value ? Number(event.target.value) : null; })}><option value="">未指定</option>{Array.from({ length: 8 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 队</option>)}</select></label><fieldset className="inline-group-editor"><legend>策略组（可多选）</legend>{plan.roster.groups.map((group) => <label className="inline-check" key={group.id}><input type="checkbox" checked={member.groupIds.includes(group.id)} onChange={() => update((item) => { item.groupIds = item.groupIds.includes(group.id) ? item.groupIds.filter((id) => id !== group.id) : [...item.groupIds, group.id]; })} />{group.name}</label>)}<button onClick={() => mutate((draft) => { const id = makeId(); draft.roster.groups.push({ id, name: `策略组 ${draft.roster.groups.length + 1}`, color: "#85601c" }); const item = draft.roster.members.find((entry) => entry.id === member.id); if (item) item.groupIds.push(id); })}>＋ 新建策略组</button>{plan.roster.groups.map((group) => <label key={`edit-${group.id}`}>{group.name}<span style={{ display: "flex", gap: 5 }}><input value={group.name} onChange={(event) => mutate((draft) => { const item = draft.roster.groups.find((entry) => entry.id === group.id); if (item) item.name = event.target.value; })} /><button className="danger-link" onClick={() => { if (!confirm(`删除策略组“${group.name}”？`)) return; mutate((draft) => { draft.roster.groups = draft.roster.groups.filter((entry) => entry.id !== group.id); draft.roster.members.forEach((entry) => { entry.groupIds = entry.groupIds.filter((id) => id !== group.id); }); for (const directive of draft.timeline.directives) if (directive.kind === "task" && directive.assignees.kind === "groups") directive.assignees.groupIds = directive.assignees.groupIds.filter((id) => id !== group.id); }); }}>×</button></span></label>)}</fieldset><button className="danger-button" onClick={() => { if (!confirm(`删除成员“${member.name}”及其技能安排？`)) return; mutate((draft) => { draft.roster.members = draft.roster.members.filter((item) => item.id !== member.id); draft.roster.memberSkills = draft.roster.memberSkills.filter((item) => item.memberId !== member.id); draft.timeline.skillAssignments = draft.timeline.skillAssignments.filter((item) => item.memberId !== member.id); }); }}>删除成员</button></div>;
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
  return <div className="inspector"><header><h2>{directive.kind === "task" ? "战术任务" : "说明"}</h2><span>{directive.kind.toUpperCase()}</span></header><label>内容<textarea rows={6} value={directive.text} onChange={(event) => update((item) => { item.text = event.target.value; })} /></label><label>范围<select value={directive.scope.kind} onChange={(event) => changeScope(event.target.value as "timed" | "phase" | "plan")}><option value="timed">精确时间</option><option value="phase">整个阶段</option>{directive.kind === "note" && <option value="plan">全计划</option>}</select></label>{directive.scope.kind === "timed" && <AnchorEditor plan={plan} anchor={directive.scope.anchor} onChange={(anchor) => update((item) => { item.scope = { kind: "timed", anchor }; })} />}{directive.scope.kind === "phase" && <label>阶段<select value={directive.scope.phaseId} onChange={(event) => update((item) => { item.scope = { kind: "phase", phaseId: event.target.value }; })}>{plan.timeline.phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></label>}<label>持续秒数<NullableNumber value={directive.durationMs} scale={1000} onChange={(value) => update((item) => { item.durationMs = value; })} /></label>{directive.kind === "task" && <><label>执行者<TargetEditor target={directive.assignees} plan={plan} onChange={(target) => update((item) => { if (item.kind === "task" && target.kind !== "mechanic-targets") item.assignees = target; })} /></label><label>提前提醒秒数<NullableNumber value={directive.reminder?.leadMs ?? null} scale={1000} onChange={(value) => update((item) => { if (item.kind === "task") item.reminder = value == null ? undefined : { leadMs: value }; })} /></label></>}<button className="danger-button" onClick={() => mutate((draft) => { draft.timeline.directives = draft.timeline.directives.filter((item) => item.id !== directive.id); })}>删除{directive.kind === "task" ? "任务" : "说明"}</button></div>;
}

function MechanicInspector({ plan, occurrence, definition, mutate }: { plan: RaidPlanDocument; occurrence: MechanicOccurrence; definition: MechanicDefinitionSnapshot; mutate: MutatePlan }) {
  function updateOccurrence(fn: (item: MechanicOccurrence) => void) { mutate((draft) => { const item = draft.timeline.mechanics.find((entry) => entry.id === occurrence.id); if (item) fn(item); }); }
  function updateDefinition(fn: (item: MechanicDefinitionSnapshot) => void) { mutate((draft) => { const item = draft.definitions.mechanics.find((entry) => entry.id === definition.id); if (item) { fn(item); item.dataStatus = "custom"; item.verification = undefined; } }); }
  return <div className="inspector"><header><h2>Boss 机制</h2><span>INSTANCE + DEFINITION</span></header><label>名称<input value={definition.name} onChange={(event) => updateDefinition((item) => { item.name = event.target.value; })} /></label><label>说明<textarea rows={4} value={definition.description} onChange={(event) => updateDefinition((item) => { item.description = event.target.value; })} /></label><AnchorEditor plan={plan} anchor={occurrence.anchor} onChange={(anchor) => updateOccurrence((item) => { item.anchor = anchor; })} /><div className="field-grid"><label>施法秒数<NullableNumber value={definition.castTimeMs} scale={1000} onChange={(value) => updateDefinition((item) => { item.castTimeMs = value; })} /></label><label>持续秒数<NullableNumber value={definition.durationMs} scale={1000} onChange={(value) => updateDefinition((item) => { item.durationMs = value; })} /></label></div><label>危险度<select value={definition.severity} onChange={(event) => updateDefinition((item) => { item.severity = event.target.value as MechanicDefinitionSnapshot["severity"]; })}><option value="info">提示</option><option value="warning">警告</option><option value="danger">危险</option></select></label><label>本次目标<TargetEditor target={occurrence.targets ?? definition.defaultTargets} plan={plan} onChange={(target) => updateOccurrence((item) => { if (target.kind !== "mechanic-targets") item.targets = target; })} /></label><p className="field-note">编辑共享定义会影响计划内所有引用实例。如需独立差异，请先复制为新定义。</p><button onClick={() => mutate((draft) => { const copy = structuredClone(definition); copy.id = makeId(); copy.name = `${copy.name}（副本）`; copy.dataStatus = "custom"; delete copy.origin; delete copy.verification; draft.definitions.mechanics.push(copy); const item = draft.timeline.mechanics.find((entry) => entry.id === occurrence.id); if (item) item.definitionId = copy.id; })}>复制为独立定义</button><button className="danger-button" onClick={() => { if (!confirm(`删除机制“${definition.name}”？关联锚点将保留为解析后的绝对时间。`)) return; mutate((draft) => { const times = new Map<string, number>(); for (const item of draft.timeline.mechanics) { const resolved = resolveTimelineAnchor(draft, item.anchor); if (resolved.ok) times.set(item.id, resolved.atMs); } for (const assignment of draft.timeline.skillAssignments) if (assignment.anchor.kind === "mechanic" && assignment.anchor.mechanicOccurrenceId === occurrence.id) { const resolved = resolveTimelineAnchor(draft, assignment.anchor); assignment.anchor = { kind: "pull", offsetMs: resolved.ok ? snapTime(resolved.atMs) : 0 }; if (assignment.targets.kind === "mechanic-targets") assignment.targets = { kind: "all" }; } for (const directive of draft.timeline.directives) if (directive.scope.kind === "timed" && directive.scope.anchor.kind === "mechanic" && directive.scope.anchor.mechanicOccurrenceId === occurrence.id) { const resolved = resolveTimelineAnchor(draft, directive.scope.anchor); directive.scope.anchor = { kind: "pull", offsetMs: resolved.ok ? snapTime(resolved.atMs) : 0 }; } for (const item of draft.timeline.mechanics) if (item.id !== occurrence.id && item.anchor.kind === "mechanic" && item.anchor.mechanicOccurrenceId === occurrence.id) item.anchor = { kind: "pull", offsetMs: snapTime(times.get(item.id) ?? 0) }; draft.timeline.mechanics = draft.timeline.mechanics.filter((item) => item.id !== occurrence.id); if (!draft.timeline.mechanics.some((item) => item.definitionId === definition.id)) draft.definitions.mechanics = draft.definitions.mechanics.filter((item) => item.id !== definition.id); }); }}>删除机制实例</button></div>;
}

function AssignmentInspector({ plan, assignment, skill, conflicts, mutate }: { plan: RaidPlanDocument; assignment: SkillAssignment; skill: PlayerSkillDefinitionSnapshot; conflicts: ConflictWarning[]; mutate: MutatePlan }) {
  const member = plan.roster.members.find((item) => item.id === assignment.memberId); const resolved = resolveSkillForMember(plan, assignment.memberId, skill) ?? skill;
  function update(fn: (item: SkillAssignment) => void) { mutate((draft) => { const item = draft.timeline.skillAssignments.find((entry) => entry.id === assignment.id); if (item) fn(item); }); }
  const compatible = member ? [...cooldownsForMember(plan.definitions.skills, member), ...plan.definitions.skills.filter((item) => item.id === skill.id && !cooldownsForMember(plan.definitions.skills, member).some((candidate) => candidate.id === item.id))] : plan.definitions.skills;
  return <div className="inspector"><header><h2>技能安排</h2><span>{skillDataStatusLabel(skill.dataStatus)}</span></header>{conflicts.map((item) => <div className="warning-box" key={`${item.type}-${item.message}`}>{item.message}</div>)}<label>成员<select value={assignment.memberId} onChange={(event) => update((item) => { item.memberId = event.target.value; if (resolveSkillForMember(plan, event.target.value, item.skillDefinitionId)?.scope === "personal") item.targets = { kind: "members", memberIds: [event.target.value] }; })}>{plan.roster.members.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>技能<select value={assignment.skillDefinitionId} onChange={(event) => update((item) => { item.skillDefinitionId = event.target.value; })}>{compatible.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{skill.variants.length > 0 && <label>成员技能变体<select value={memberSkillVariantId(plan, assignment.memberId, skill.id) ?? ""} onChange={(event) => mutate((draft) => setMemberSkillVariant(draft, assignment.memberId, skill.id, event.target.value || undefined))}><option value="">基础</option>{skill.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label>}<AnchorEditor plan={plan} anchor={assignment.anchor} onChange={(anchor) => update((item) => { item.anchor = anchor; if (anchor.kind !== "mechanic" && item.targets.kind === "mechanic-targets") item.targets = { kind: "all" }; })} /><label>目标<TargetEditor target={assignment.targets} plan={plan} allowMechanicTargets={assignment.anchor.kind === "mechanic"} onChange={(target) => update((item) => { item.targets = target as SkillTargetSelector; })} /></label><label>备注<textarea value={assignment.note} onChange={(event) => update((item) => { item.note = event.target.value; })} /></label><section className="skill-detail-section"><b>{resolved.name}</b><small>{castTypeLabels[resolved.castType]} · {skillTimingSummary(resolved)}</small>{resolved.limitations.map((item) => <p key={item}>{item}</p>)}</section><button className="danger-button" onClick={() => mutate((draft) => { draft.timeline.skillAssignments = draft.timeline.skillAssignments.filter((item) => item.id !== assignment.id); })}>删除技能安排</button></div>;
}

function SkillInspector({ plan, skill, mutate }: { plan: RaidPlanDocument; skill: PlayerSkillDefinitionSnapshot; mutate: MutatePlan }) {
  function update(fn: (item: PlayerSkillDefinitionSnapshot) => void) { mutate((draft) => { const item = draft.definitions.skills.find((entry) => entry.id === skill.id); if (item) { fn(item); item.dataStatus = "custom"; item.verification = undefined; } }); }
  return <div className="inspector"><header><h2>技能定义</h2><span>{skillDataStatusLabel(skill.dataStatus)}</span></header><label>名称<input value={skill.name} onChange={(event) => update((item) => { item.name = event.target.value; })} /></label><label>说明<textarea rows={4} value={skill.description} onChange={(event) => update((item) => { item.description = event.target.value; })} /></label><div className="field-grid"><label>冷却秒数<NullableNumber value={skill.cooldownMs} scale={1000} onChange={(value) => update((item) => { item.cooldownMs = value; })} /></label><label>充能<input type="number" min={1} max={10} value={skill.maxCharges} onChange={(event) => update((item) => { item.maxCharges = Math.max(1, Math.min(10, Number(event.target.value) || 1)); })} /></label><label>施法类型<select value={skill.castType} onChange={(event) => update((item) => { item.castType = event.target.value as PlayerSkillDefinitionSnapshot["castType"]; if (item.castType === "instant") item.castTimeMs = 0; })}>{Object.entries(castTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>施法秒数<NullableNumber value={skill.castTimeMs} scale={1000} onChange={(value) => update((item) => { item.castTimeMs = value; })} /></label><label>持续秒数<NullableNumber value={skill.durationMs} scale={1000} onChange={(value) => update((item) => { item.durationMs = value; })} /></label><label>GCD<select value={skill.triggersGcd == null ? "unknown" : skill.triggersGcd ? "yes" : "no"} onChange={(event) => update((item) => { item.triggersGcd = event.target.value === "unknown" ? null : event.target.value === "yes"; })}><option value="unknown">待配置</option><option value="yes">占用</option><option value="no">不占用</option></select></label></div><label>限制<textarea rows={4} value={skill.limitations.join("\n")} onChange={(event) => update((item) => { item.limitations = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); })} /></label>{skill.verification && <p className="field-note">核准版本：{skill.verification.gameVersion}<br />来源：{skill.verification.sources.map((item) => item.label).join("、") || "未记录"}</p>}<button className="danger-button" onClick={() => { if (!confirm(`删除技能“${skill.name}”及其所有安排？`)) return; mutate((draft) => { draft.definitions.skills = draft.definitions.skills.filter((item) => item.id !== skill.id); draft.roster.memberSkills = draft.roster.memberSkills.filter((item) => item.skillDefinitionId !== skill.id); draft.timeline.skillAssignments = draft.timeline.skillAssignments.filter((item) => item.skillDefinitionId !== skill.id); }); }}>删除技能定义</button><p className="field-note">计划内定义是独立快照；修改不会回写目录。</p><span hidden>{plan.metadata.title}</span></div>;
}
