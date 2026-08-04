"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Inspector JSX edits heterogeneous v2 unions in-place; runtime documents are normalized before use. */
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim loads a second React instance in the client bundle. */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cooldownsForClass, WOW_CLASS_COLORS, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import {
  ALL_TARGETS, INHERIT_TARGETS, defaultAssignmentStart, detectConflicts,
  exportMrtNote, formatTime, makeId, mechanicImpactMs,
  normalizePlanDocument, parseTime, snapTime, syncLinkedAssignments,
} from "@/lib/core";
import type { ConflictWarning } from "@/lib/core";
import { applyBuiltInPreset, BUILT_IN_PRESETS, createPersonalPreset, parsePresetJson, stringifyPreset, type RaidPlanPreset } from "@/lib/presets";
import type { ApiError, CooldownDefinition, RaidAssignment, RaidGroup, RaidMechanic, RaidPlanDocument, RosterMember, StoredPlan, TargetSelection } from "@/lib/types";
import { anchoredScroll, defaultOrientation, shouldInterceptTimelineWheel, viewPreferenceKey, zoomFromWheel, type TimelineOrientation } from "@/lib/view";
import { ThemeControl } from "./ThemeControl";
import { TimelineView } from "./TimelineView";
import { ZoomControl } from "./ZoomControl";
import { deletePersonalPreset, listPersonalPresets, savePersonalPreset } from "./preset-store";

type Selection = { type: "member" | "group" | "mechanic" | "cooldown" | "assignment"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type LeftTab = "members" | "skills" | "groups" | "presets";
const RECENT_KEY = "raidline:recent";
const roleLabels = { tank: "å¦å…‹", healer: "æ²»ç–—", damage: "è¾“å‡º" } as const;

function clonePlan(plan: RaidPlanDocument) { return structuredClone(plan); }

function TimeField({ value, onCommit, label = "æ—¶é—´" }: { value: number; onCommit: (value: number) => void; label?: string }) {
  const [draft, setDraft] = useState(formatTime(value));
  useEffect(() => {
    const timer = setTimeout(() => setDraft(formatTime(value)), 0);
    return () => clearTimeout(timer);
  }, [value]);
  function commit() { const parsed = parseTime(draft); if (parsed == null) setDraft(formatTime(value)); else onCommit(parsed); }
  return <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function NullableNumber({ value, onChange, scale = 1, min = 0, placeholder = "æœªè®¾ç½®" }: { value: number | null; onChange: (value: number | null) => void; scale?: number; min?: number; placeholder?: string }) {
  return <input type="number" min={min} placeholder={placeholder} value={value == null ? "" : value / scale} onChange={(event) => onChange(event.target.value === "" ? null : Math.max(min, Number(event.target.value)) * scale)} />;
}

function TargetEditor({ target, plan, allowInherit, onChange }: { target: TargetSelection; plan: RaidPlanDocument; allowInherit?: boolean; onChange: (target: TargetSelection) => void }) {
  const modes = [...(allowInherit ? [{ value: "inherit", label: "è·Ÿéšæœºåˆ¶" }] : []), { value: "all", label: "å…¨å›¢" }, { value: "groups", label: "è‡ªå®šä¹‰åˆ†ç»„" }, { value: "roles", label: "èŒè´£" }, { value: "members", label: "å…·ä½“æˆå‘˜" }];
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
  const [leftTab, setLeftTab] = useState<LeftTab>("members");
  const [skillClassSlug, setSkillClassSlug] = useState("");
  const [skillCooldownId, setSkillCooldownId] = useState("");
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
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "è¯»å–è®¡åˆ’å¤±è´¥");
    const document = normalizePlanDocument(payload.data.document);
    setStored({ ...payload.data, document }); setPlan(document); setVersion(payload.data.version); setSaveState("saved");
    undoStack.current = []; redoStack.current = []; editRevision.current = 0; setHistoryState({ canUndo: false, canRedo: false }); rememberPlan(payload.data, editToken);
  }, [planId, rememberPlan]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("key") ?? "";
      const editToken = fromHash || localStorage.getItem(`raidline:key:${planId}`) || "";
      if (fromHash) { localStorage.setItem(`raidline:key:${planId}`, fromHash); history.replaceState(null, "", `${location.pathname}${location.search}`); }
      if (!editToken) { setFatal("è¿™æ¡ç¼–è¾‘é“¾æ¥ç¼ºå°‘æ¢å¤å¯†é’¥ã€‚è¯·æ‰“å¼€å®Œæ•´æ¢å¤é“¾æ¥ã€‚"); return; }
      setToken(editToken); loadPlan(editToken).catch((error) => { if (!cancelled) setFatal(error instanceof Error ? error.message : "è¯»å–è®¡åˆ’å¤±è´¥"); });
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
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "ä¿å­˜å¤±è´¥");
        setVersion(payload.data.version); setStored(payload.data); rememberPlan(payload.data, token);
        setSaveState(editRevision.current === capturedRevision ? "saved" : "dirty");
      } catch (error) { setSaveState("error"); setToast(error instanceof Error ? error.message : "ä¿å­˜å¤±è´¥"); }
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
  const classCooldowns = useMemo(() => cooldownsForClass(plan?.cooldowns ?? [], skillClassSlug), [plan?.cooldowns, skillClassSlug]);

  if (fatal) return <main className="state-page"><div className="state-card"><h1>æ— æ³•æ‰“å¼€ç¼–è¾‘å™¨</h1><p>{fatal}</p><a className="primary-action" href="/">å›åˆ°é¦–é¡µ</a></div></main>;
  if (!plan || !stored) return <main className="state-page"><p>æ­£åœ¨è¯»å–è®¡åˆ’â€¦</p></main>;
  const activePlan = plan;

  const selectedMember = selection?.type === "member" ? plan.roster.find((item) => item.id === selection.id) : null;
  const selectedGroup = selection?.type === "group" ? plan.groups.find((item) => item.id === selection.id) : null;
  const selectedMechanic = selection?.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : null;
  const selectedCooldownDirect = selection?.type === "cooldown" ? plan.cooldowns.find((item) => item.id === selection.id) : null;
  const selectedAssignment = selection?.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : null;
  const selectedCooldown = selectedCooldownDirect ?? (selectedAssignment ? plan.cooldowns.find((item) => item.id === selectedAssignment.cooldownId) : null);
  const selectedSkill = classCooldowns.find((item) =>ç­¼¶‰ËkºwµçM1MM}1	1L¤¹µ…À ¡mÍ±Õœ±±…‰•±t¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õíÍ±Õô­•äõíÍ±Õôùí±…‰•±ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°øñ±…‰•°û’âOÊøñ¥¹ÁÕĞÙ…±Õ”õíÍ•±•Ñ•‘5•µ‰•È¹ÍÁ•M±Õô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹É½ÍÑ•È¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘5•µ‰•È¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹ÍÁ•M±Õœ€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°øñ±…‰•°û¢3¢ÒŒñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘5•µ‰•È¹É½±•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹É½ÍÑ•È¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘5•µ‰•È¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹É½±”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”…Ì…¹äìô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ô‰Ñ…¹¬ˆû–v›–,ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰¡•…±•ÈˆûšÊïZ\ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰‘…µ…”ˆû¢úO–èğ½½ÁÑ¥½¸øğ½Í•±•Ğøğ½±…‰•°øñ±…‰•°û¢«–ºk’æ'–"îñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘5•µ‰•È¹É½ÕÁ%€üü€ˆ‰ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹É½ÍÑ•È¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘5•µ‰•È¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹É½ÕÁ%€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ñğÕ¹‘•™¥¹•ìô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ôˆˆûšr«–"îğ½½ÁÑ¥½¸ùíÁ±…¸¹É½ÕÁÌ¹µ…À ¡É½ÕÀè…¹ä¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õíÉ½ÕÀ¹¥‘ô­•äõíÉ½ÕÀ¹¥‘ôùíÉ½ÕÀ¹¹…µ•ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°øñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰‘…¹•Èµ‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøì¥˜€¡½¹™¥É´¡ƒ–"ƒ¦f“š"C–FcŠp‘íÍ•±•Ñ•‘5•µ‰•È¹¹…µ•÷Šw–>+–Û–"¦7¾ò}€¤¤µÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì‘É…™Ğ¹É½ÍÑ•È€ô‘É…™Ğ¹É½ÍÑ•È¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôôÍ•±•Ñ•‘5•µ‰•È¹¥¤ì‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹µ•µ‰•É%€„ôôÍ•±•Ñ•‘5•µ‰•È¹¥¤ìô°¹Õ±°¤ìõôû–"ƒ¦f“š"C–F`ğ½‰ÕÑÑ½¸øğ½‘¥Øøì(€¥˜€¡Í•±•Ñ•‘É½ÕÀ¤É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½Èˆøñ¡•…‘•Èøñ Èû–"îğ½ ÈøñÍÁ…¸ùI=U@ğ½ÍÁ…¸øğ½¡•…‘•Èøñ±…‰•°û–B7Àñ¥¹ÁÕĞÙ…±Õ”õíÍ•±•Ñ•‘É½ÕÀ¹¹…µ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹É½ÕÁÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘É½ÕÀ¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹¹…µ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°øñ±…‰•°ûš‚¢¾¢&Èñ¥¹ÁÕĞÑåÁ”ô‰½±½ÈˆÙ…±Õ”õíÍ•±•Ñ•‘É½ÕÀ¹½±½Éô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹É½ÕÁÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘É½ÕÀ¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹½±½È€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°øñÀ±…ÍÍ9…µ”ô‰™¥•±µ¹½Ñ”ˆùíÁ±…¸¹É½ÍÑ•È¹™¥±Ñ•È ¡µ•µ‰•Èè…¹ä¤€ôøµ•µ‰•È¹É½ÕÁ%€ôôôÍ•±•Ñ•‘É½ÕÀ¹¥¤¹µ…À ¡µ•µ‰•Èè…¹ä¤€ôøµ•µ‰•È¹¹…µ”¤¹©½¥¸ ‹ˆ¤ñğ€‹šjš^ƒš"C–F`‰ôğ½Àøñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰‘…¹•Èµ‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì‘É…™Ğ¹É½ÕÁÌ€ô‘É…™Ğ¹É½ÕÁÌ¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôôÍ•±•Ñ•‘É½ÕÀ¹¥¤ì‘É…™Ğ¹É½ÍÑ•È¹™½É…  ¡µ•µ‰•È¤€ôøì¥˜€¡µ•µ‰•È¹É½ÕÁ%€ôôôÍ•±•Ñ•‘É½ÕÀ¹¥¤µ•µ‰•È¹É½ÕÁ%€ôÕ¹‘•™¥¹•ìô¤ìô°¹Õ±°¥ôû–"ƒ¦f“–"îğ½‰ÕÑÑ½¸øğ½‘¥Øøì(€¥˜€¡Í•±•Ñ•‘5•¡…¹¥Œ¤É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½Èˆøñ¡•…‘•Èøñ Èûšrë–"Øğ½ ÈøñÍÁ…¸ù5!9%ğ½ÍÁ…¸øğ½¡•…‘•Èøñ±…‰•°û–B7Àñ¥¹ÁÕĞÙ…±Õ”õíÍ•±•Ñ•‘5•¡…¹¥Œ¹¹…µ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ•5•¡…¹¥Œ ¡¥Ñ•´¤€ôøì¥Ñ•´¹¹…µ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°øñ±…‰•°û¢¾Óšb8ñÑ•áÑ…É•„É½İÌõìÕôÙ…±Õ”õíÍ•±•Ñ•‘5•¡…¹¥Œ¹‘•ÍÉ¥ÁÑ¥½¹ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ•5•¡…¹¥Œ ¡¥Ñ•´¤€ôøì¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°øñ±…‰•°ûš^Û¦^Ó
äñQ¥µ•¥•±Ù…±Õ”õíÍ•±•Ñ•‘5•¡…¹¥Œ¹…Ñ5Íô½¹½µµ¥Ğõì¡Ù…±Õ”¤€ôøÕÁ‘…Ñ•5•¡…¹¥Œ ¡¥Ñ•´¤€ôøì¥Ñ•´¹…Ñ5Ì€ôÍ¹…ÁQ¥µ”¡Ù…±Õ”°Á±…¸¹Í•ÑÑ¥¹Ì¹Í¹…Á5Ì¤ìô¥ô€¼øğ½±…‰•°øñ±…‰•°ûš&–Æ{¦bÛšºÔñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘5•¡…¹¥Œ¹Á¡…Í•%€üü€ˆ‰ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ•5•¡…¹¥Œ ¡¥Ñ•´¤€ôøì¥Ñ•´¹Á¡…Í•%€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ñğÕ¹‘•™¥¹•ìô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ôˆˆûšr«š2–ºhğ½½ÁÑ¥½¸ùíÁ±…¸¹Á¡…Í•Ì¹µ…À ¡Á¡…Í”¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õíÁ¡…Í”¹¥‘ô­•äõíÁ¡…Í”¹¥‘ôùí™½Éµ…ÑQ¥µ”¡Á¡…Í”¹…Ñ5Ì¥ôíÁ¡…Í”¹¹…µ•ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°øñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰‘…¹•Èµ‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì‘É…™Ğ¹µ•¡…¹¥Ì€ô‘É…™Ğ¹µ•¡…¹¥Ì¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôôÍ•±•Ñ•‘5•¡…¹¥Œ¹¥¤ì‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹µ•¡…¹¥%€ôôôÍ•±•Ñ•‘5•¡…¹¥Œ¹¥€üì€¸¸¹•¹ÑÉä°µ•¡…¹¥%èÕ¹‘•™¥¹•°½™™Í•Ñ5ÌèÕ¹‘•™¥¹•°Ñ…É•ÑÌè•¹ÑÉä¹Ñ…É•ÑÌ¹µ½‘”€ôôô€‰¥¹¡•É¥Ğˆ€üÍÑÉÕÑÕÉ•‘±½¹”¡11}QIQL¤€è•¹ÑÉä¹Ñ…É•ÑÌô€è•¹ÑÉä¤ìô°¹Õ±°¥ôû–"ƒ¦f“šrë–"Øğ½‰ÕÑÑ½¸øğ½‘¥Øøì(€¥˜€¡Í•±•Ñ•‘½½±‘½İ¸€˜˜€…Í•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¤É•ÑÕÉ¸€ñM­¥±±%¹ÍÁ•Ñ½È½½±‘½İ¸õíÍ•±•Ñ•‘½½±‘½İ¹ôÕÁ‘…Ñ”õíÕÁ‘…Ñ•½½±‘½İ¹ôµÕÑ…Ñ”õíµÕÑ…Ñ•ô€¼øì(€¥˜€¡Í•±•Ñ•‘ÍÍ¥¹µ•¹Ğ€˜˜Í•±•Ñ•‘½½±‘½İ¸¤ì(€€€½¹ÍĞµ•µ‰•È€ôÁ±…¸¹É½ÍÑ•È¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹µ•µ‰•É%¤ì(€€€½¹ÍĞ½µÁ…Ñ¥‰±•½½±‘½İ¹Ì€ôÁ±…¸¹½½±‘½İ¹Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹±…ÍÍM±Õœ€ôôôµ•µ‰•Èü¹±…ÍÍM±Õœñğ¥Ñ•´¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹½½±‘½İ¹%¤ì(€€€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½Èˆøñ¡•…‘•Èøñ Èûš*¢÷–"¦4ğ½ ÈøñÍÁ…¸ùMM%959Pğ½ÍÁ…¸øğ½¡•…‘•Èøñ±…‰•°ûš"C–F`ñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹µ•µ‰•É%‘ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€ …¥Ñ•´¤É•ÑÕÉ¸ì¥Ñ•´¹µ•µ‰•É%€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ì½¹ÍĞ¹•áÑ5•µ‰•È€ô‘É…™Ğ¹É½ÍÑ•È¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô¥Ñ•´¹µ•µ‰•É%¤ì½¹ÍĞÕÉÉ•¹Ñ½½±‘½İ¸€ô‘É…™Ğ¹½½±‘½İ¹Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô¥Ñ•´¹½½±‘½İ¹%¤ì½¹ÍĞ™¥ÉÍÑ½µÁ…Ñ¥‰±”€ô‘É…™Ğ¹½½±‘½İ¹Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹±…ÍÍM±Õœ€ôôô¹•áÑ5•µ‰•Èü¹±…ÍÍM±Õœ¤ì¥˜€¡ÕÉÉ•¹Ñ½½±‘½İ¸ü¹±…ÍÍM±Õœ€„ôô¹•áÑ5•µ‰•Èü¹±…ÍÍM±Õœ€˜˜™¥ÉÍÑ½µÁ…Ñ¥‰±”¤¥Ñ•´¹½½±‘½İ¹%€ô™¥ÉÍÑ½µÁ…Ñ¥‰±”¹¥ì½¹ÍĞ½½±‘½İ¸€ô‘É…™Ğ¹½½±‘½İ¹Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô¥Ñ•´¹½½±‘½İ¹%¤ì¥˜€¡½½±‘½İ¸ü¹Í½Á”€ôôô€‰Á•ÉÍ½¹…°ˆ¤¥Ñ•´¹Ñ…É•ÑÌ€ôìµ½‘”è€‰µ•µ‰•ÉÌˆ°µ•µ‰•É%‘Ìèm¥Ñ•´¹µ•µ‰•É%‘tôìô¥ôùíÁ±…¸¹É½ÍÑ•È¹µ…À ¡•¹ÑÉäè…¹ä¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õí•¹ÑÉä¹¥‘ô­•äõí•¹ÑÉä¹¥‘ôùí•¹ÑÉä¹¹…µ•ôƒ
Üí]=]}1MM}1	1Mm•¹ÑÉä¹±…ÍÍM±Õt€üü€‹–ú¦'š.§¢3’âh‰ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°øñ±…‰•°ûš*¢ôñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹½½±‘½İ¹%‘ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€ …¥Ñ•´¤É•ÑÕÉ¸ì¥Ñ•´¹½½±‘½İ¹%€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ì½¹ÍĞ½½±‘½İ¸€ô‘É…™Ğ¹½½±‘½İ¹Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô¥Ñ•´¹½½±‘½İ¹%¤ì¥˜€¡½½±‘½İ¸ü¹Í½Á”€ôôô€‰Á•ÉÍ½¹…°ˆ¤¥Ñ•´¹Ñ…É•ÑÌ€ôìµ½‘”è€‰µ•µ‰•ÉÌˆ°µ•µ‰•É%‘Ìèm¥Ñ•´¹µ•µ‰•É%‘tôìô¥ôùí½µÁ…Ñ¥‰±•½½±‘½İ¹Ì¹µ…À ¡½½±‘½İ¸è…¹ä¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õí½½±‘½İ¸¹¥‘ô­•äõí½½±‘½İ¸¹¥‘ôùí½½±‘½İ¸¹¹…µ•õí½½±‘½İ¸¹±…ÍÍM±Õœ€„ôôµ•µ‰•Èü¹±…ÍÍM±Õœ€ü€‹¾ò#š^Ÿ–"¦7¾ò$ˆ€è€ˆ‰ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°øñ±…‰•°û–ò–/šZ÷šÎTñQ¥µ•¥•±Ù…±Õ”õíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹…Ñ5Íô½¹½µµ¥Ğõì¡Ù…±Õ”¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€ …¥Ñ•´¤É•ÑÕÉ¸ì¥Ñ•´¹…Ñ5Ì€ôÍ¹…ÁQ¥µ”¡Ù…±Õ”°‘É…™Ğ¹Í•ÑÑ¥¹Ì¹Í¹…Á5Ì¤ì½¹ÍĞµ•¡…¹¥Œ€ô¥Ñ•´¹µ•¡…¹¥%€ü‘É…™Ğ¹µ•¡…¹¥Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô¥Ñ•´¹µ•¡…¹¥%¤€èÕ¹‘•™¥¹•ì¥˜€¡µ•¡…¹¥Œ¤¥Ñ•´¹½™™Í•Ñ5Ì€ô¥Ñ•´¹…Ñ5Ì€´µ•¡…¹¥%µÁ…Ñ5Ì¡µ•¡…¹¥Œ¤ìô¥ô€¼øğ½±…‰•°øñ±…‰•°û–Ï¢Sšrë–"ØñÍ•±•ĞÙ…±Õ”õíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹µ•¡…¹¥%€üü€ˆ‰ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€ …¥Ñ•´¤É•ÑÕÉ¸ì½¹ÍĞµ•¡…¹¥Œ€ô‘É…™Ğ¹µ•¡…¹¥Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”¤ì¥Ñ•´¹µ•¡…¹¥%€ôµ•¡…¹¥Œü¹¥ì¥˜€¡µ•¡…¹¥Œ¤ì¥Ñ•´¹…Ñ5Ì€ô‘•™…Õ±ÑÍÍ¥¹µ•¹ÑMÑ…ÉĞ¡‘É…™Ğ°Í•±•Ñ•‘½½±‘½İ¸°µ•¡…¹¥Œ¤ì¥Ñ•´¹½™™Í•Ñ5Ì€ô¥Ñ•´¹…Ñ5Ì€´µ•¡…¹¥%µÁ…Ñ5Ì¡µ•¡…¹¥Œ¤ì¥Ñ•´¹Ñ…É•ÑÌ€ôÍ•±•Ñ•‘½½±‘½İ¸¹Í½Á”€ôôô€‰Á•ÉÍ½¹…°ˆ€üìµ½‘”è€‰µ•µ‰•ÉÌˆ°µ•µ‰•É%‘Ìèm¥Ñ•´¹µ•µ‰•É%‘tô€èÍÑÉÕÑÕÉ•‘±½¹”¡%9!I%Q}QIQL¤ìô•±Í”ì¥Ñ•´¹½™™Í•Ñ5Ì€ôÕ¹‘•™¥¹•ì¥˜€¡¥Ñ•´¹Ñ…É•ÑÌ¹µ½‘”€ôôô€‰¥¹¡•É¥Ğˆ¤¥Ñ•´¹Ñ…É•ÑÌ€ôÍÑÉÕÑÕÉ•‘±½¹”¡11}QIQL¤ìôô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ôˆˆû¢«RÇš^Û¦^Ó
äğ½½ÁÑ¥½¸ùíÁ±…¸¹µ•¡…¹¥Ì¹µ…À ¡µ•¡…¹¥Œè…¹ä¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õíµ•¡…¹¥Œ¹¥‘ô­•äõíµ•¡…¹¥Œ¹¥‘ôùí™½Éµ…ÑQ¥µ”¡µ•¡…¹¥Œ¹…Ñ5Ì¥ôíµ•¡…¹¥Œ¹¹…µ•ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°ùíÍ•±•Ñ•‘½½±‘½İ¸¹Í½Á”€ôôô€‰Á•ÉÍ½¹…°ˆ€ü€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µ¹½Ñ”ˆøñˆû–º{¦fn»š‚¾òkšZ÷šRû¢šr³’êèğ½ˆøñ‰È€¼û’â«’êëš*¢÷–në–ºk’ösR£’ê;–öO–&7š"C–Fc¾ò3’â7¢÷šRç’âë–Û’î[n»š‚ğ½‘¥Øø€è€ñ±…‰•°û–º{¦fn»š‚ñQ…É•Ñ‘¥Ñ½ÈÑ…É•ĞõíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹Ñ…É•ÑÍôÁ±…¸õíÁ±…¹ô…±±½İ%¹¡•É¥Ğ½¹¡…¹”õì¡Ñ…É•Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹Ñ…É•ÑÌ€ôÑ…É•Ğìô¥ô€¼øğ½±…‰•°ùôñ±…‰•°û–’šÎ ñÑ•áÑ…É•„Ù…±Õ”õíÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¹½Ñ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹¹½Ñ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°ùíİ…É¹¥¹Ì¹™¥±Ñ•È ¡İ…É¹¥¹œè…¹ä¤€ôøİ…É¹¥¹œ¹…ÍÍ¥¹µ•¹Ñ%€ôôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤¹µ…À ¡İ…É¹¥¹œè…¹ä°¥¹‘•àè¹Õµ‰•È¤€ôø€ñ‘¥Ø±…ÍÍ9…µ”ô‰İ…É¹¥¹œµ‰½àˆ­•äõí€‘íİ…É¹¥¹œ¹ÑåÁ•ô´‘í¥¹‘•áõôùíİ…É¹¥¹œ¹µ•ÍÍ…•ôğ½‘¥Øø¥ôñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰‘…¹•Èµ‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøµÕÑ…Ñ” ¡‘É…™ĞèI…¥‘A±…¹½Õµ•¹Ğ¤€ôøì‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôôÍ•±•Ñ•‘ÍÍ¥¹µ•¹Ğ¹¥¤ìô°¹Õ±°¥ôû–"ƒ¦f“–"¦4ğ½‰ÕÑÑ½¸øğ½‘¥Øøì(€ô(€É•ÑÕÉ¸¹Õ±°ì)ô()™Õ¹Ñ¥½¸A±…¹M•ÑÑ¥¹Í%¹ÍÁ•Ñ½È¡ìÁ±…¸°İ…É¹¥¹Ì°µÕÑ…Ñ”°Í•ÑM•±•Ñ¥½¸ôèìÁ±…¸èI…¥‘A±…¹½Õµ•¹Ğìİ…É¹¥¹Ìè½¹™±¥Ñ]…É¹¥¹mtìµÕÑ…Ñ”è5ÕÑ…Ñ•A±…¸ìÍ•ÑM•±•Ñ¥½¸è¥ÍÁ…Ñ ñM•ÑMÑ…Ñ•Ñ¥½¸ñM•±•Ñ¥½¸øøô¤ì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½Èˆø(€€€€ñ¡•…‘•Èøñ Èû¢º‡–"K¢ºûö¸ğ½ ÈøñÍÁ…¸ùA18ğ½ÍÁ…¸øğ½¡•…‘•Èø(€€€€ñ±…‰•°û¢º‡–"K–B7Àñ¥¹ÁÕĞÙ…±Õ”õíÁ±…¸¹•¹½Õ¹Ñ•È¹¹…µ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹•¹½Õ¹Ñ•È¹¹…µ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€ñ±…‰•°û¦jû–ê˜ñÍ•±•ĞÙ…±Õ”õíÁ±…¸¹•¹½Õ¹Ñ•È¹‘¥™™¥Õ±Ñåô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹•¹½Õ¹Ñ•È¹‘¥™™¥Õ±Ñä€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ôøñ½ÁÑ¥½¸û¦j?šrèğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸ûšf»¦hğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸û¢.Ç¦nğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸û–>Ë¢¾\ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸ûî’æ€ğ½½ÁÑ¥½¸øğ½Í•±•Ğøğ½±…‰•°ø(€€€€ñ±…‰•°ûš"cšZ_š^Û¦VüñQ¥µ•¥•±Ù…±Õ”õíÁ±…¸¹•¹½Õ¹Ñ•È¹‘ÕÉ…Ñ¥½¹5Íô½¹½µµ¥Ğõì¡Ù…±Õ”¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹•¹½Õ¹Ñ•È¹‘ÕÉ…Ñ¥½¹5Ì€ô5…Ñ ¹µ…à ÄÁ|ÀÀÀ°Ù…±Õ”¤ìô¥ô€¼øğ½±…‰•°ø(€€€€ñ±…‰•°ûš^Û¦^Ó–Bã¦fKšVÀñ9Õ±±…‰±•9Õµ‰•ÈÙ…±Õ”õíÁ±…¸¹Í•ÑÑ¥¹Ì¹Í¹…Á5ÍôÍ…±”õìÄÀÀÁôµ¥¸õìÀ¸Åô½¹¡…¹”õì¡Ù…±Õ”¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹Í•ÑÑ¥¹Ì¹Í¹…Á5Ì€ôÙ…±Õ”€üü€ÄÀÀÀìô¥ô€¼øğ½±…‰•°ø(€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰Á¡…Í”µ•‘¥Ñ½Èˆø(€€€€€€ñ¡•…‘•Èøñˆû¦bÛšºÔğ½ˆøñ‰ÕÑÑ½¸½¹±¥¬õì ¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôø‘É…™Ğ¹Á¡…Í•Ì¹ÁÕÍ ¡ì¥èµ…­•% ‰Á¡…Í”ˆ¤°¹…µ”è@‘í‘É…™Ğ¹Á¡…Í•Ì¹±•¹Ñ €¬€Åõ€°…Ñ5Ìè5…Ñ ¹µ¥¸¡‘É…™Ğ¹•¹½Õ¹Ñ•È¹‘ÕÉ…Ñ¥½¹5Ì°€¡‘É…™Ğ¹Á¡…Í•Ì¹…Ğ ´Ä¤ü¹…Ñ5Ì€üü€À¤€¬€ØÁ|ÀÀÀ¤ô¤¥ôû¾ò,ƒ¦bÛšºÔğ½‰ÕÑÑ½¸øğ½¡•…‘•Èø(€€€€€íÁ±…¸¹Á¡…Í•Ì¹µ…À ¡Á¡…Í”°¥¹‘•à¤€ôø€ñ‘¥Ø­•äõíÁ¡…Í”¹¥‘ôøñ¥¹ÁÕĞ…É¥„µ±…‰•°õíƒ¦bÛšºÔ€‘í¥¹‘•à€¬€Åôƒ–B7ÁôÙ…±Õ”õíÁ¡…Í”¹¹…µ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹Á¡…Í•Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÁ¡…Í”¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹¹…µ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øñQ¥µ•¥•±±…‰•°õíƒ¦bÛšºÔ€‘í¥¹‘•à€¬€Åôƒš^Û¦^ÑôÙ…±Õ”õíÁ¡…Í”¹…Ñ5Íô½¹½µµ¥Ğõì¡Ù…±Õ”¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì½¹ÍĞ¥Ñ•´€ô‘É…™Ğ¹Á¡…Í•Ì¹™¥¹ ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€ôôôÁ¡…Í”¹¥¤ì¥˜€¡¥Ñ•´¤¥Ñ•´¹…Ñ5Ì€ôÍ¹…ÁQ¥µ”¡Ù…±Õ”°‘É…™Ğ¹Í•ÑÑ¥¹Ì¹Í¹…Á5Ì¤ìô¥ô€¼ùíÁ±…¸¹Á¡…Í•Ì¹±•¹Ñ €ø€Ä€˜˜€ñ‰ÕÑÑ½¸…É¥„µ±…‰•°õíƒ–"ƒ¦f“¦bÛšºÔ€‘íÁ¡…Í”¹¹…µ•õô½¹±¥¬õì ¤€ôøµÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹Á¡…Í•Ì€ô‘É…™Ğ¹Á¡…Í•Ì¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôôÁ¡…Í”¹¥¤ì‘É…™Ğ¹µ•¡…¹¥Ì¹™½É…  ¡¥Ñ•´¤€ôøì¥˜€¡¥Ñ•´¹Á¡…Í•%€ôôôÁ¡…Í”¹¥¤¥Ñ•´¹Á¡…Í•%€ôÕ¹‘•™¥¹•ìô¤ìô¥ôû\ğ½‰ÕÑÑ½¸ùôğ½‘¥Øø¥ô(€€€€ğ½Í•Ñ¥½¸ø(€€€€ñ¡•­Ìİ…É¹¥¹Ìõíİ…É¹¥¹ÍôÍ•ÑM•±•Ñ¥½¸õíÍ•ÑM•±•Ñ¥½¹ô€¼ø(€€ğ½‘¥Øøì)ô()™Õ¹Ñ¥½¸M­¥±±%¹ÍÁ•Ñ½È¡ì½½±‘½İ¸°ÕÁ‘…Ñ”°µÕÑ…Ñ”ôèì½½±‘½İ¸è½½±‘½İ¹•™¥¹¥Ñ¥½¸ìÕÁ‘…Ñ”è€¡™¸è€¡¥Ñ•´è½½±‘½İ¹•™¥¹¥Ñ¥½¸¤€ôøÙ½¥¤€ôøÙ½¥ìµÕÑ…Ñ”è5ÕÑ…Ñ•A±…¸ô¤ì(€½¹ÍĞÍÑ…ÑÕÌ€ô½½±‘½İ¸¹‘…Ñ…MÑ…ÑÕÌ€ôôô€‰Õ¹½¹™¥ÕÉ•ˆ€ü€‹šVÃ–ó–ú¢†”ˆ€è½½±‘½İ¸¹‘…Ñ…MÑ…ÑÕÌ€ôôô€‰±•…äˆ€ü€‹š^ŸšVÃš6¸ˆ€è€‹–ŞË¢«–ºk’æ$ˆì(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½Èˆø(€€€€ñ¡•…‘•Èøñ Èûš*¢÷–ºk’æ$ğ½ ÈøñÍÁ…¸ùíÍÑ…ÑÕÍôğ½ÍÁ…¸øğ½¡•…‘•Èø(€€€€ñ±…‰•°û–B7Àñ¥¹ÁÕĞÙ…±Õ”õí½½±‘½İ¸¹¹…µ•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹¹…µ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€ñ±…‰•°ûº’î,ñÑ•áÑ…É•„Ù…±Õ”õí½½±‘½İ¸¹‘•ÍÉ¥ÁÑ¥½¹ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ¥ˆø(€€€€€€ñ±…‰•°û¢2–nĞñÍ•±•ĞÙ…±Õ”õí½½±‘½İ¸¹Í½Á•ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹Í½Á”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”…Ì½½±‘½İ¹•™¥¹¥Ñ¥½¹l‰Í½Á”‰tì¥˜€¡¥Ñ•´¹Í½Á”€ôôô€‰Á•ÉÍ½¹…°ˆ¤¥Ñ•´¹µ…áQ…É•ÑÌ€ô€Äìô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ô‰Ñ•…´ˆû–n‹¦b|ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰•áÑ•É¹…°ˆû–6W’öO–’[¦ ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰Á•ÉÍ½¹…°ˆû’â«’êèğ½½ÁÑ¥½¸øğ½Í•±•Ğøğ½±…‰•°ø(€€€€€€ñ±…‰•°ûÆï–"¬ñÍ•±•ĞÙ…±Õ”õí½½±‘½İ¸¹…Ñ•½Éåô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹…Ñ•½Éä€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”…Ì½½±‘½İ¹•™¥¹¥Ñ¥½¹l‰…Ñ•½Éä‰tìô¥ôùíl‹–n‹¦b–?’òˆ°‹–’[¦£–?’òˆ°‹’â«’êë–?’òˆ°‹šÊïZ\ˆ°‹–7Z¬ˆ°‹’ö7ìˆ°‹¢«–ºk’æ$‰t¹µ…À ¡Ù…±Õ”¤€ôø€ñ½ÁÑ¥½¸­•äõíÙ…±Õ•ôùíÙ…±Õ•ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°ø(€€€€ğ½‘¥Øø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ¥ˆø(€€€€€€ñ±…‰•°û¢3’âhñÍ•±•ĞÙ…±Õ”õí½½±‘½İ¸¹±…ÍÍM±Õô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹±…ÍÍM±Õœ€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”ì¥Ñ•´¹½±½È€ô]=]}1MM}=1=IMm•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ•tìô¥ôùí=‰©•Ğ¹•¹ÑÉ¥•Ì¡]=]}1MM}1	1L¤¹µ…À ¡mÍ±Õœ±±…‰•±t¤€ôø€ñ½ÁÑ¥½¸Ù…±Õ”õíÍ±Õô­•äõíÍ±Õôùí±…‰•±ôğ½½ÁÑ¥½¸ø¥ôğ½Í•±•Ğøğ½±…‰•°ø(€€€€€€ñ±…‰•°û’âOÊû–öK–Æxñ¥¹ÁÕĞÁ±…•¡½±‘•Èô‹–’k’â«’âOÊûR£¦_–>ß–"¦jPˆÙ…±Õ”õí½½±‘½İ¸¹ÍÁ•M±ÕÌ¹©½¥¸ ‹ˆ¥ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹ÍÁ•M±ÕÌ€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”¹ÍÁ±¥Ğ ½o³¾ò1t¼¤¹µ…À ¡Ù…±Õ”¤€ôøÙ…±Õ”¹ÑÉ¥´ ¤¤¹™¥±Ñ•È¡	½½±•…¸¤ìô¥ô€¼øğ½±…‰•°ø(€€€€ğ½‘¥Øø(€€€€ñ±…‰•°û–ß–6ÓKšVÀñ9Õ±±…‰±•9Õµ‰•ÈÙ…±Õ”õí½½±‘½İ¸¹½½±‘½İ¹5ÍôÍ…±”õìÄÀÀÁô½¹¡…¹”õì¡Ù…±Õ”¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹½½±‘½İ¹5Ì€ôÙ…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ¥ˆø(€€€€€€ñ±…‰•°ûšZ÷šÎWKšVÀñ9Õ±±…‰±•9Õµ‰•ÈÙ…±Õ”õí½½±‘½İ¸¹…ÍÑQ¥µ•5ÍôÍ…±”õìÄÀÀÁô½¹¡…¹”õì¡Ù…±Õ”¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹…ÍÑQ¥µ•5Ì€ôÙ…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€€€ñ±…‰•°ûš2î·KšVÀñ9Õ±±…‰±•9Õµ‰•ÈÙ…±Õ”õí½½±‘½İ¸¹‘ÕÉ…Ñ¥½¹5ÍôÍ…±”õìÄÀÀÁô½¹¡…¹”õì¡Ù…±Õ”¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹‘ÕÉ…Ñ¥½¹5Ì€ôÙ…±Õ”ìô¥ô€¼øğ½±…‰•°ø(€€€€ğ½‘¥Øø(€€€€ñÀ±…ÍÍ9…µ”ô‰™¥•±µ¹½Ñ”ˆûVg¦ë¢†£’ëšr«~—¾òo–†¯–d€Àƒ¢†£’ëšb;†»z³–>Gš"[š^ƒš2î·š^Û¦^Ón»–öTí½½±‘½İ¸¹…Ñ…±½Y•ÉÍ¥½¹ôğ½Àø(€€€€ñ±…‰•°ùñÍ•±•ĞÙ…±Õ”õí½½±‘½İ¸¹ÑÉ¥•ÉÍ€ôô¹Õ±°€ü€‰Õ¹­¹½İ¸ˆ€è½½±‘½İ¸¹ÑÉ¥•ÉÍ€ü€‰å•Ìˆ€è€‰¹¼‰ô½¹¡…¹”õì¡•Ù•¹Ğ¤€ôøÕÁ‘…Ñ” ¡¥Ñ•´¤€ôøì¥Ñ•´¹ÑÉ¥•ÉÍ€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”€ôôô€‰Õ¹­¹½İ¸ˆ€ü¹Õ±°€è•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”€ôôô€‰å•Ìˆìô¥ôøñ½ÁÑ¥½¸Ù…±Õ”ô‰Õ¹­¹½İ¸ˆûšr«¢ºûö¸ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰å•Ìˆû–6ƒR ğ½½ÁÑ¥½¸øñ½ÁÑ¥½¸Ù…±Õ”ô‰¹¼ˆû’â7–6ƒR ğ½½ÁÑ¥½¸øğ½Í•±•Ğøğ½±…‰•°ø(€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰‘…¹•Èµ‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøì¥˜€¡½¹™¥É´¡ƒ–"ƒ¦f“š*¢÷Šp‘í½½±‘½İ¸¹¹…µ•÷Šw–>+–Û–"¦7¾ò}€¤¤µÕÑ…Ñ” ¡‘É…™Ğ¤€ôøì‘É…™Ğ¹½½±‘½İ¹Ì€ô‘É…™Ğ¹½½±‘½İ¹Ì¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥€„ôô½½±‘½İ¸¹¥¤ì‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ€ô‘É…™Ğ¹…ÍÍ¥¹µ•¹ÑÌ¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹½½±‘½İ¹%€„ôô½½±‘½İ¸¹¥¤ìô°¹Õ±°¤ìõôû–"ƒ¦f“š*¢ôğ½‰ÕÑÑ½¸ø(€€ğ½‘¥Øøì)ô()™Õ¹Ñ¥½¸¡•­Ì¡ìİ…É¹¥¹Ì°Í•ÑM•±•Ñ¥½¸ôè…¹ä¤ìÉ•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¡•­Ìˆøñ¡•…‘•Èøñˆûš:K¢öÓšš~”ğ½ˆøñÍÁ…¸ùíİ…É¹¥¹Ì¹±•¹Ñ €ü€‘íİ…É¹¥¹Ì¹±•¹Ñ¡ôƒ¦†å€€è€‹¦k¢ş‰ôğ½ÍÁ…¸øğ½¡•…‘•Èùíİ…É¹¥¹Ì¹Í±¥” À°à¤¹µ…À ¡İ…É¹¥¹œè…¹ä±¥¹‘•àè¹Õµ‰•È¤€ôø€ñ‰ÕÑÑ½¸­•äõí¥¹‘•áô½¹±¥¬õì ¤€ôøİ…É¹¥¹œ¹…ÍÍ¥¹µ•¹Ñ%€üÍ•ÑM•±•Ñ¥½¸¡ìÑåÁ”è‰…ÍÍ¥¹µ•¹Ğˆ°¥éİ…É¹¥¹œ¹…ÍÍ¥¹µ•¹Ñ%ô¤€èİ…É¹¥¹œ¹µ•¡…¹¥%€üÍ•ÑM•±•Ñ¥½¸¡ìÑåÁ”è‰µ•¡…¹¥Œˆ°¥éİ…É¹¥¹œ¹µ•¡…¹¥%ô¤€è¹Õ±±ôùíİ…É¹¥¹œ¹µ•ÍÍ…•ôğ½‰ÕÑÑ½¸ø¥ôğ½‘¥Øøìô(