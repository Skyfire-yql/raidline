"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WOW_CLASS_COLORS, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import { detectConflicts, exportMrtNote, formatTime, makeId, parseTime, snapTime } from "@/lib/core";
import type {
  ApiError,
  RaidAssignment,
  RaidMechanic,
  RaidPlanDocument,
  StoredPlan,
  WclImportAnalysis,
  WclPreview,
} from "@/lib/types";

type Selection = { type: "member" | "mechanic" | "assignment"; id: string } | null;
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

const RECENT_KEY = "raidline:recent";
const roleLabels = { tank: "坦克", healer: "治疗", damage: "输出" } as const;

function clonePlan(plan: RaidPlanDocument) {
  return structuredClone(plan);
}

function ApiMessage({ error }: { error: ApiError | null }) {
  return error ? <div className="inline-error" role="alert">{error.message}</div> : null;
}

function TimeField({ value, onCommit, label = "时间" }: { value: number; onCommit: (value: number) => void; label?: string }) {
  const [draft, setDraft] = useState(formatTime(value));
  useEffect(() => setDraft(formatTime(value)), [value]);
  function commit() {
    const parsed = parseTime(draft);
    if (parsed == null) setDraft(formatTime(value));
    else onCommit(parsed);
  }
  return <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

export function EditorClient({ planId }: { planId: string }) {
  const router = useRouter();
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
  const [paletteSearch, setPaletteSearch] = useState("");
  const undoStack = useRef<RaidPlanDocument[]>([]);
  const redoStack = useRef<RaidPlanDocument[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);

  const rememberPlan = useCallback((value: StoredPlan, editToken: string) => {
    try {
      localStorage.setItem(`raidline:key:${value.id}`, editToken);
      const current = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Array<{ id: string; title: string; updatedAt: number }>;
      const next = [{ id: value.id, title: value.document.encounter.name, updatedAt: value.updatedAt }, ...current.filter((item) => item.id !== value.id)].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Durable plan data remains in D1; recent-plan storage is only a device convenience.
    }
  }, []);

  const loadPlan = useCallback(async (editToken: string) => {
    setFatal("");
    const response = await fetch(`/api/plans/${planId}`, { headers: { authorization: `Bearer ${editToken}` } });
    const payload = (await response.json()) as { data?: StoredPlan; error?: ApiError };
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败");
    setStored(payload.data);
    setPlan(payload.data.document);
    setVersion(payload.data.version);
    setSaveState("saved");
    undoStack.current = [];
    redoStack.current = [];
    rememberPlan(payload.data, editToken);
  }, [planId, rememberPlan]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const source = params.get("wcl") ?? "";
    if (source) {
      setWclInitial(source);
      setShowWcl(true);
    }
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const fromHash = hash.get("key") ?? "";
    const local = localStorage.getItem(`raidline:key:${planId}`) ?? "";
    const editToken = fromHash || local;
    if (fromHash) {
      localStorage.setItem(`raidline:key:${planId}`, fromHash);
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (!editToken) {
      setFatal("这条编辑链接缺少恢复密钥。请打开完整恢复链接，或使用只读分享链接查看。");
      return;
    }
    setToken(editToken);
    loadPlan(editToken).catch((error) => setFatal(error instanceof Error ? error.message : "读取计划失败"));
  }, [loadPlan, planId]);

  function mutate(mutator: (draft: RaidPlanDocument) => void, nextSelection?: Selection) {
    setPlan((current) => {
      if (!current) return current;
      undoStack.current = [...undoStack.current.slice(-49), clonePlan(current)];
      redoStack.current = [];
      const next = clonePlan(current);
      mutator(next);
      return next;
    });
    setSaveState("dirty");
    setConflict(null);
    if (nextSelection !== undefined) setSelection(nextSelection);
  }

  function undo() {
    const previous = undoStack.current.pop();
    if (!previous || !plan) return;
    redoStack.current.push(clonePlan(plan));
    setPlan(previous);
    setSaveState("dirty");
  }

  function redo() {
    const next = redoStack.current.pop();
    if (!next || !plan) return;
    undoStack.current.push(clonePlan(plan));
    setPlan(next);
    setSaveState("dirty");
  }

  useEffect(() => {
    if (!plan || !token || saveState !== "dirty" || conflict) return;
    const captured = plan;
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const response = await fetch(`/api/plans/${planId}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ baseVersion: version, document: captured }),
        });
        const payload = (await response.json()) as { data?: StoredPlan; error?: ApiError };
        if (response.status === 409) {
          setConflict(payload.error?.details as StoredPlan | null);
          setSaveState("conflict");
          return;
        }
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "保存失败");
        setVersion(payload.data.version);
        setStored(payload.data);
        rememberPlan(payload.data, token);
        setPlan((current) => {
          if (current === captured) setSaveState("saved");
          else setSaveState("dirty");
          return current;
        });
      } catch (error) {
        setSaveState("error");
        setToast(error instanceof Error ? error.message : "保存失败");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [conflict, plan, planId, rememberPlan, saveState, token, version]);

  const warnings = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);
  const warningIds = useMemo(() => new Set(warnings.map((item) => item.assignmentId)), [warnings]);

  if (fatal) {
    return <main className="state-page"><div className="state-card"><span className="brand-mark">轴</span><p className="eyebrow">EDIT LINK REQUIRED</p><h1>无法打开编辑器</h1><p>{fatal}</p><a className="button button-gold" href="/">回到首页</a></div></main>;
  }
  if (!plan || !stored) {
    return <main className="state-page"><div className="loading-sigil"><span>轴</span><i /></div><p>正在展开时间线…</p></main>;
  }

  const activePlan = plan;

  const durationSeconds = Math.max(10, activePlan.encounter.durationMs / 1000);
  const pixelsPerSecond = 5 * activePlan.settings.zoom;
  const trackWidth = Math.max(980, Math.round(durationSeconds * pixelsPerSecond));
  const ticks = Array.from({ length: Math.floor(durationSeconds / 15) + 1 }, (_, index) => index * 15);
  const selectedMember = selection?.type === "member" ? plan.roster.find((item) => item.id === selection.id) : null;
  const selectedMechanic = selection?.type === "mechanic" ? plan.mechanics.find((item) => item.id === selection.id) : null;
  const selectedAssignment = selection?.type === "assignment" ? plan.assignments.find((item) => item.id === selection.id) : null;
  const selectedCooldown = selectedAssignment ? plan.cooldowns.find((item) => item.id === selectedAssignment.cooldownId) : null;
  const filteredCooldowns = plan.cooldowns.filter((item) => `${item.name}${WOW_CLASS_LABELS[item.classSlug] ?? item.classSlug}`.toLowerCase().includes(paletteSearch.toLowerCase()));

  function addMember() {
    const id = makeId("member");
    mutate((draft) => {
      draft.roster.push({ id, name: `新成员 ${draft.roster.length + 1}`, classSlug: "Priest", specSlug: "神圣", role: "healer", color: WOW_CLASS_COLORS.Priest });
    }, { type: "member", id });
  }

  function addMechanic(atMs = 30_000) {
    const id = makeId("mechanic");
    mutate((draft) => {
      draft.mechanics.push({ id, name: "新机制", atMs: snapTime(atMs, draft.settings.snapMs), severity: "warning", source: "manual", note: "" });
      draft.mechanics.sort((a, b) => a.atMs - b.atMs);
    }, { type: "mechanic", id });
  }

  function addAssignment(cooldownId: string) {
    if (!activePlan.roster.length) {
      setToast("先添加至少一名团队成员");
      return;
    }
    const id = makeId("assignment");
    const memberId = selectedMember?.id ?? selectedAssignment?.memberId ?? activePlan.roster[0].id;
    const mechanicId = selectedMechanic?.id;
    const atMs = selectedMechanic?.atMs ?? selectedAssignment?.atMs ?? 0;
    mutate((draft) => {
      draft.assignments.push({ id, memberId, cooldownId, mechanicId, atMs, note: "", source: "manual" });
    }, { type: "assignment", id });
  }

  function handleTrackDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const atMs = ((event.clientX - rect.left) / pixelsPerSecond) * 1000;
    addMechanic(atMs);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const assignmentId = event.dataTransfer.getData("application/x-raidline-assignment");
    if (!assignmentId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const atMs = snapTime(((event.clientX - rect.left) / pixelsPerSecond) * 1000, activePlan.settings.snapMs);
    mutate((draft) => {
      const assignment = draft.assignments.find((item) => item.id === assignmentId);
      if (assignment) assignment.atMs = Math.min(draft.encounter.durationMs, atMs);
    }, { type: "assignment", id: assignmentId });
  }

  async function copyText(value: string, message: string) {
    await navigator.clipboard.writeText(value);
    setToast(message);
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(activePlan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activePlan.encounter.name || "raidline"}.raidline.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("JSON 备份已下载");
  }

  async function duplicateLocal() {
    try {
      const createdResponse = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `${activePlan.encounter.name}（副本）` }) });
      const created = (await createdResponse.json()) as { data?: { id: string; editToken: string; version: number }; error?: ApiError };
      if (!created.data) throw new Error(created.error?.message ?? "创建副本失败");
      const cloned = clonePlan(activePlan);
      cloned.encounter.name = `${cloned.encounter.name}（副本）`;
      const savedResponse = await fetch(`/api/plans/${created.data.id}`, { method: "PUT", headers: { authorization: `Bearer ${created.data.editToken}`, "content-type": "application/json" }, body: JSON.stringify({ baseVersion: created.data.version, document: cloned }) });
      if (!savedResponse.ok) throw new Error("保存副本失败");
      localStorage.setItem(`raidline:key:${created.data.id}`, created.data.editToken);
      router.replace(`/plans/${created.data.id}#key=${encodeURIComponent(created.data.editToken)}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "创建副本失败");
    }
  }

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <a className="brand compact" href="/"><span className="brand-mark">轴</span><span><strong>团轴</strong><small>RAIDLINE</small></span></a>
        <div className="plan-title-block">
          <span className="crumb">个人排轴 /</span>
          <input aria-label="排轴名称" value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} />
          <span className={`save-badge ${saveState}`}><i />{{ saved: "已保存", dirty: "待保存", saving: "保存中", error: "保存失败", conflict: "版本冲突" }[saveState]}</span>
        </div>
        <div className="editor-actions">
          <button onClick={undo} disabled={!undoStack.current.length} title="撤销 (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={!redoStack.current.length} title="重做">↷</button>
          <button onClick={() => setShowWcl(true)}>WCL 导入</button>
          <button onClick={() => copyText(exportMrtNote(plan), "MRT 文本已复制")}>复制 MRT</button>
          <button onClick={() => copyText(`${location.origin}/s/${stored.shareSlug}`, "只读链接已复制")}>分享</button>
          <button className="gold-mini" onClick={() => copyText(`${location.origin}/plans/${planId}#key=${encodeURIComponent(token)}`, "编辑恢复链接已复制")}>恢复链接</button>
        </div>
      </header>

      {saveState === "conflict" && (
        <div className="conflict-banner">
          <span>服务器上有另一份更新，本地修改尚未覆盖它。</span>
          <button onClick={() => { if (conflict) { setPlan(conflict.document); setStored(conflict); setVersion(conflict.version); setConflict(null); setSaveState("saved"); } }}>加载服务器版本</button>
          <button onClick={duplicateLocal}>将本地修改另存为新计划</button>
        </div>
      )}

      <div className="editor-grid">
        <aside className="roster-panel panel">
          <div className="panel-heading"><span><small>01</small><strong>团队成员</strong></span><button onClick={addMember} aria-label="添加成员">＋</button></div>
          <div className="roster-summary"><span><b>{plan.roster.length}</b> / 40 人</span><span><b>{plan.roster.filter((item) => item.role === "healer").length}</b> 治疗</span></div>
          <div className="roster-list">
            {plan.roster.map((member) => (
              <button className={`roster-item ${selection?.type === "member" && selection.id === member.id ? "selected" : ""}`} key={member.id} onClick={() => setSelection({ type: "member", id: member.id })}>
                <i style={{ background: member.color }} /><span><strong>{member.name}</strong><small>{WOW_CLASS_LABELS[member.classSlug] ?? member.classSlug} · {roleLabels[member.role]}</small></span><b>›</b>
              </button>
            ))}
            {!plan.roster.length && <div className="panel-empty"><span>＋</span><p>还没有团队成员<br /><small>添加成员后即可安排技能</small></p><button onClick={addMember}>添加第一位成员</button></div>}
          </div>

          <div className="palette-heading"><span>团队技能</span><button onClick={() => {
            const id = makeId("custom-spell");
            mutate((draft) => draft.cooldowns.push({ id, name: "自定义技能", classSlug: "Warrior", cooldownMs: 120000, durationMs: 8000, category: "自定义", color: "#c69b6d" }));
            setToast("已添加自定义技能，可在分配后编辑");
          }}>＋ 自定义</button></div>
          <input className="palette-search" aria-label="搜索团队技能" placeholder="搜索技能或职业…" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} />
          <div className="cooldown-palette">
            {filteredCooldowns.map((cooldown) => (
              <button key={cooldown.id} onClick={() => addAssignment(cooldown.id)} title={`添加 ${cooldown.name}`}>
                <i style={{ borderColor: cooldown.color, color: cooldown.color }}>{cooldown.name.slice(0, 1)}</i><span><strong>{cooldown.name}</strong><small>{Math.round(cooldown.cooldownMs / 1000)}s · {cooldown.category}</small></span><b>＋</b>
              </button>
            ))}
          </div>
        </aside>

        <section className="timeline-panel panel">
          <div className="timeline-toolbar">
            <div><span className="difficulty-tag">{plan.encounter.difficulty}</span><b>{formatTime(plan.encounter.durationMs)}</b><span>{plan.mechanics.length} 个机制</span><span>{plan.assignments.length} 项分配</span></div>
            <div><button onClick={() => addMechanic()}>＋ 添加机制</button><label>缩放 <input type="range" min="0.6" max="1.8" step="0.1" value={plan.settings.zoom} onChange={(event) => mutate((draft) => { draft.settings.zoom = Number(event.target.value); })} /></label></div>
          </div>
          <div className="timeline-scroll" ref={timelineRef}>
            <div className="timeline-canvas" style={{ width: trackWidth }} onDoubleClick={handleTrackDoubleClick} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <div className="tick-layer" aria-hidden="true">{ticks.map((second) => <i key={second} style={{ left: second * pixelsPerSecond }} className={second % 30 === 0 ? "major" : ""} />)}</div>
              <div className="timeline-ruler">{ticks.filter((second) => second % 30 === 0).map((second) => <span key={second} style={{ left: second * pixelsPerSecond }}>{formatTime(second * 1000)}</span>)}</div>
              <div className="mechanic-lane">
                <div className="lane-label">BOSS 机制</div>
                {plan.phases.map((phase) => <span className="phase-flag" key={phase.id} style={{ left: phase.atMs / 1000 * pixelsPerSecond }}>{phase.name}</span>)}
                {plan.mechanics.map((mechanic) => (
                  <button key={mechanic.id} className={`mechanic-marker severity-${mechanic.severity} ${selection?.type === "mechanic" && selection.id === mechanic.id ? "selected" : ""}`} style={{ left: mechanic.atMs / 1000 * pixelsPerSecond }} onClick={() => setSelection({ type: "mechanic", id: mechanic.id })} title={`${formatTime(mechanic.atMs)} ${mechanic.name}`}>
                    <i /><span>{mechanic.name}</span>
                  </button>
                ))}
              </div>
              {plan.roster.map((member) => (
                <div className="member-lane" key={member.id}>
                  <div className="lane-label member-label"><i style={{ background: member.color }} /><span><strong>{member.name}</strong><small>{roleLabels[member.role]}</small></span></div>
                  {plan.assignments.filter((assignment) => assignment.memberId === member.id).map((assignment) => {
                    const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId);
                    if (!cooldown) return null;
                    return (
                      <button draggable key={assignment.id} className={`assignment-chip ${warningIds.has(assignment.id) ? "has-warning" : ""} ${selection?.type === "assignment" && selection.id === assignment.id ? "selected" : ""}`} style={{ left: assignment.atMs / 1000 * pixelsPerSecond, borderColor: cooldown.color }} onDragStart={(event) => event.dataTransfer.setData("application/x-raidline-assignment", assignment.id)} onClick={() => setSelection({ type: "assignment", id: assignment.id })} title={`${formatTime(assignment.atMs)} ${cooldown.name}`}>
                        <i style={{ background: cooldown.color }} />{cooldown.name}{warningIds.has(assignment.id) && <b>!</b>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {!plan.roster.length && <div className="timeline-empty">添加成员与机制，让这条轴开始运转。<small>双击时间线也可以快速创建机制</small></div>}
            </div>
          </div>
          <div className="timeline-legend"><span><i className="legend-danger" />高危机制</span><span><i className="legend-warning" />常规机制</span><span><i className="legend-assignment" />技能分配</span><small>拖动技能块可调整时间 · 双击空白处添加机制</small></div>
        </section>

        <aside className="inspector-panel panel">
          <div className="panel-heading"><span><small>03</small><strong>属性与检查</strong></span></div>
          {!selection && (
            <div className="inspector-form">
              <p className="inspector-kicker">ENCOUNTER</p><h3>战斗设置</h3>
              <label>首领 / 计划名称<input value={plan.encounter.name} onChange={(event) => mutate((draft) => { draft.encounter.name = event.target.value; })} /></label>
              <label>难度<select value={plan.encounter.difficulty} onChange={(event) => mutate((draft) => { draft.encounter.difficulty = event.target.value; })}><option>随机</option><option>普通</option><option>英雄</option><option>史诗</option></select></label>
              <label>战斗时长<TimeField value={plan.encounter.durationMs} label="战斗时长" onCommit={(value) => mutate((draft) => { draft.encounter.durationMs = Math.max(10000, value); })} /></label>
              {plan.encounter.source && <div className="source-card"><span>WCL</span><p><strong>{plan.encounter.source.reportCode}</strong><small>Fight #{plan.encounter.source.fightId} · revision {plan.encounter.source.reportRevision}</small></p></div>}
            </div>
          )}
          {selectedMember && (
            <div className="inspector-form"><p className="inspector-kicker">RAIDER</p><h3>成员设置</h3>
              <label>角色名<input value={selectedMember.name} onChange={(event) => mutate((draft) => { const item = draft.roster.find((member) => member.id === selectedMember.id); if (item) item.name = event.target.value; })} /></label>
              <label>职业<select value={selectedMember.classSlug} onChange={(event) => mutate((draft) => { const item = draft.roster.find((member) => member.id === selectedMember.id); if (item) { item.classSlug = event.target.value; item.color = WOW_CLASS_COLORS[event.target.value] ?? "#b6ad9a"; } })}>{Object.entries(WOW_CLASS_LABELS).map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}</select></label>
              <label>专精<input value={selectedMember.specSlug} onChange={(event) => mutate((draft) => { const item = draft.roster.find((member) => member.id === selectedMember.id); if (item) item.specSlug = event.target.value; })} /></label>
              <label>职责<select value={selectedMember.role} onChange={(event) => mutate((draft) => { const item = draft.roster.find((member) => member.id === selectedMember.id); if (item) item.role = event.target.value as typeof item.role; })}><option value="tank">坦克</option><option value="healer">治疗</option><option value="damage">输出</option></select></label>
              <button className="danger-button" onClick={() => { if (confirm(`删除成员“${selectedMember.name}”及其全部分配？`)) mutate((draft) => { draft.roster = draft.roster.filter((item) => item.id !== selectedMember.id); draft.assignments = draft.assignments.filter((item) => item.memberId !== selectedMember.id); }, null); }}>删除成员</button>
            </div>
          )}
          {selectedMechanic && (
            <div className="inspector-form"><p className="inspector-kicker">MECHANIC</p><h3>机制设置</h3>
              <label>机制名称<input value={selectedMechanic.name} onChange={(event) => mutate((draft) => { const item = draft.mechanics.find((mechanic) => mechanic.id === selectedMechanic.id); if (item) item.name = event.target.value; })} /></label>
              <label>发生时间<TimeField value={selectedMechanic.atMs} onCommit={(value) => mutate((draft) => { const item = draft.mechanics.find((mechanic) => mechanic.id === selectedMechanic.id); if (item) item.atMs = Math.min(draft.encounter.durationMs, snapTime(value, draft.settings.snapMs)); })} /></label>
              <label>危险等级<select value={selectedMechanic.severity} onChange={(event) => mutate((draft) => { const item = draft.mechanics.find((mechanic) => mechanic.id === selectedMechanic.id); if (item) item.severity = event.target.value as typeof item.severity; })}><option value="info">提示</option><option value="warning">常规</option><option value="danger">高危</option></select></label>
              <label>备注<textarea value={selectedMechanic.note} onChange={(event) => mutate((draft) => { const item = draft.mechanics.find((mechanic) => mechanic.id === selectedMechanic.id); if (item) item.note = event.target.value; })} /></label>
              <button className="danger-button" onClick={() => mutate((draft) => { draft.mechanics = draft.mechanics.filter((item) => item.id !== selectedMechanic.id); draft.assignments = draft.assignments.map((item) => item.mechanicId === selectedMechanic.id ? { ...item, mechanicId: undefined } : item); }, null)}>删除机制</button>
            </div>
          )}
          {selectedAssignment && (
            <div className="inspector-form"><p className="inspector-kicker">ASSIGNMENT</p><h3>技能分配</h3>
              <label>成员<select value={selectedAssignment.memberId} onChange={(event) => mutate((draft) => { const item = draft.assignments.find((assignment) => assignment.id === selectedAssignment.id); if (item) item.memberId = event.target.value; })}>{plan.roster.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>
              <label>技能<select value={selectedAssignment.cooldownId} onChange={(event) => mutate((draft) => { const item = draft.assignments.find((assignment) => assignment.id === selectedAssignment.id); if (item) item.cooldownId = event.target.value; })}>{plan.cooldowns.map((cooldown) => <option value={cooldown.id} key={cooldown.id}>{cooldown.name}</option>)}</select></label>
              {selectedCooldown && <><label>技能名称<input value={selectedCooldown.name} onChange={(event) => mutate((draft) => { const item = draft.cooldowns.find((cooldown) => cooldown.id === selectedCooldown.id); if (item) item.name = event.target.value; })} /></label><label>冷却秒数<input type="number" min="0" max="3600" value={Math.round(selectedCooldown.cooldownMs / 1000)} onChange={(event) => mutate((draft) => { const item = draft.cooldowns.find((cooldown) => cooldown.id === selectedCooldown.id); if (item) item.cooldownMs = Math.max(0, Number(event.target.value) * 1000); })} /></label><label>持续秒数<input type="number" min="0" max="600" value={Math.round(selectedCooldown.durationMs / 1000)} onChange={(event) => mutate((draft) => { const item = draft.cooldowns.find((cooldown) => cooldown.id === selectedCooldown.id); if (item) item.durationMs = Math.max(0, Number(event.target.value) * 1000); })} /></label></>}
              <label>施放时间<TimeField value={selectedAssignment.atMs} onCommit={(value) => mutate((draft) => { const item = draft.assignments.find((assignment) => assignment.id === selectedAssignment.id); if (item) item.atMs = Math.min(draft.encounter.durationMs, snapTime(value, draft.settings.snapMs)); })} /></label>
              <label>关联机制<select value={selectedAssignment.mechanicId ?? ""} onChange={(event) => mutate((draft) => { const item = draft.assignments.find((assignment) => assignment.id === selectedAssignment.id); if (item) { item.mechanicId = event.target.value || undefined; const mechanic = draft.mechanics.find((candidate) => candidate.id === event.target.value); if (mechanic) item.atMs = mechanic.atMs; } })}><option value="">自由时间点</option>{plan.mechanics.map((mechanic) => <option value={mechanic.id} key={mechanic.id}>{formatTime(mechanic.atMs)} {mechanic.name}</option>)}</select></label>
              <label>备注<textarea value={selectedAssignment.note} onChange={(event) => mutate((draft) => { const item = draft.assignments.find((assignment) => assignment.id === selectedAssignment.id); if (item) item.note = event.target.value; })} /></label>
              {warnings.filter((warning) => warning.assignmentId === selectedAssignment.id).map((warning) => <div className="warning-box" key={warning.type}>! {warning.message}</div>)}
              <button className="danger-button" onClick={() => mutate((draft) => { draft.assignments = draft.assignments.filter((item) => item.id !== selectedAssignment.id); }, null)}>删除分配</button>
            </div>
          )}
          <div className="checks-card"><div><span>排轴检查</span><b className={warnings.length ? "warn" : "ok"}>{warnings.length ? `${warnings.length} 项` : "通过"}</b></div>{warnings.slice(0, 4).map((warning, index) => <button key={`${warning.assignmentId}-${warning.type}-${index}`} onClick={() => setSelection({ type: "assignment", id: warning.assignmentId })}><i>!</i>{warning.message}</button>)}{!warnings.length && <p><i>✓</i>当前没有发现冷却或时间冲突</p>}</div>
          <div className="backup-actions"><button onClick={downloadJson}>下载 JSON 备份</button><button onClick={() => copyText(`${location.origin}/plans/${planId}#key=${encodeURIComponent(token)}`, "恢复链接已复制")}>复制编辑恢复链接</button></div>
        </aside>
      </div>

      {showWcl && <WclModal planId={planId} token={token} version={version} initialSource={wclInitial} onClose={() => { setShowWcl(false); setWclInitial(""); }} onImported={(value) => { undoStack.current.push(clonePlan(activePlan)); setPlan(value.document); setStored(value); setVersion(value.version); setSaveState("saved"); setSelection(null); setShowWcl(false); rememberPlan(value, token); setToast("WCL 战报已导入"); }} />}
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")} aria-label="关闭">×</button></div>}
    </main>
  );
}

function WclModal({ planId, token, version, initialSource, onClose, onImported }: { planId: string; token: string; version: number; initialSource: string; onClose: () => void; onImported: (plan: StoredPlan) => void }) {
  const [source, setSource] = useState(initialSource);
  const [preview, setPreview] = useState<WclPreview | null>(null);
  const [fightId, setFightId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<WclImportAnalysis | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeCooldowns, setIncludeCooldowns] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function requestPreview() {
    setBusy(true); setError(null); setAnalysis(null);
    try {
      const response = await fetch(`/api/plans/${planId}/wcl/preview`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ source }) });
      const payload = (await response.json()) as { data?: WclPreview; error?: ApiError };
      if (!response.ok || !payload.data) throw payload.error ?? { code: "UNKNOWN", message: "读取战报失败" };
      setPreview(payload.data);
      const embedded = source.match(/(?:[?#&]fight=)(\d+)/i)?.[1];
      const preferred = embedded ? Number(embedded) : payload.data.fights.at(-1)?.id ?? null;
      setFightId(preferred);
    } catch (caught) {
      setError(caught as ApiError);
    } finally { setBusy(false); }
  }

  useEffect(() => { if (initialSource) requestPreview(); /* run once for the deep-linked source */ }, []);

  async function analyze() {
    if (!preview || fightId == null) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plans/${planId}/wcl/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reportCode: preview.reportCode, fightId }) });
      const payload = (await response.json()) as { data?: { analysis: WclImportAnalysis }; error?: ApiError };
      if (!response.ok || !payload.data) throw payload.error ?? { code: "UNKNOWN", message: "分析战斗失败" };
      setAnalysis(payload.data.analysis);
      setSelected(new Set());
    } catch (caught) { setError(caught as ApiError); } finally { setBusy(false); }
  }

  async function applyImport() {
    if (!analysis) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plans/${planId}/wcl/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reportCode: analysis.reportCode, fightId: analysis.fight.id, selectedAbilityIds: Array.from(selected), includeObservedCooldowns: includeCooldowns, baseVersion: version }) });
      const payload = (await response.json()) as { data?: StoredPlan; error?: ApiError };
      if (!response.ok || !payload.data) throw payload.error ?? { code: "UNKNOWN", message: "导入失败" };
      onImported(payload.data);
    } catch (caught) { setError(caught as ApiError); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="wcl-modal" role="dialog" aria-modal="true" aria-labelledby="wcl-title">
        <header><div><span className="wcl-logo">WCL</span><p><small>WARCRAFT LOGS</small><strong id="wcl-title">导入真实战斗时间线</strong></p></div><button onClick={onClose} aria-label="关闭">×</button></header>
        {!preview && <div className="wcl-step"><p>粘贴公开战报链接。首版不会请求你的 WCL 账号或私密战报权限。</p><label>战报链接 / 报告代码<div><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://www.warcraftlogs.com/reports/…" /><button className="button button-gold" onClick={requestPreview} disabled={busy}>{busy ? "读取中…" : "读取战报"}</button></div></label><ApiMessage error={error} /></div>}
        {preview && !analysis && <div className="wcl-step"><div className="wcl-report"><span><small>报告</small><strong>{preview.title}</strong></span><span><small>公开场次</small><strong>{preview.fights.length}</strong></span><button onClick={() => { setPreview(null); setError(null); }}>更换战报</button></div><h3>选择要分析的 Boss 场次</h3><div className="fight-list">{preview.fights.map((fight) => <button className={fightId === fight.id ? "selected" : ""} key={fight.id} onClick={() => setFightId(fight.id)}><i>{fight.kill ? "✓" : `${Math.max(0, Math.round(fight.durationMs / 1000 / 60))}m`}</i><span><strong>{fight.name}</strong><small>{fight.difficultyLabel} · Fight #{fight.id} · {formatTime(fight.durationMs)}</small></span><b>{fightId === fight.id ? "●" : "○"}</b></button>)}</div><ApiMessage error={error} /><footer><span>将读取敌方施法与已识别的团队技能</span><button className="button button-gold" onClick={analyze} disabled={busy || fightId == null}>{busy ? "分析中…" : "分析这个场次"}</button></footer></div>}
        {analysis && <div className="wcl-step"><div className="analysis-heading"><span><small>已识别场次</small><strong>{analysis.fight.name}</strong><em>{analysis.fight.difficultyLabel} · {formatTime(analysis.fight.durationMs)} · {analysis.roster.length} 人</em></span><button onClick={() => setAnalysis(null)}>返回场次</button></div><div className="ability-toolbar"><h3>勾选要放进时间线的 Boss 技能</h3><span><button onClick={() => setSelected(new Set(analysis.abilityGroups.map((group) => group.spellId)))}>全选</button><button onClick={() => setSelected(new Set())}>清空</button></span></div><div className="ability-list">{analysis.abilityGroups.map((group) => <label key={group.spellId}><input type="checkbox" checked={selected.has(group.spellId)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(group.spellId); else next.delete(group.spellId); return next; })} /><i>{group.name.slice(0, 1)}</i><span><strong>{group.name}</strong><small>#{group.spellId} · 首次 {formatTime(group.timestamps[0] ?? 0)}</small></span><b>{group.count} 次</b></label>)}</div><label className="observed-toggle"><input type="checkbox" checked={includeCooldowns} onChange={(event) => setIncludeCooldowns(event.target.checked)} /><span><strong>导入已识别的团队技能施放</strong><small>检测到 {analysis.suggestedAssignments.length} 次，可作为上一把的参考</small></span></label><ApiMessage error={error} /><footer><span>已选择 {selected.size} 个技能，共 {analysis.abilityGroups.filter((group) => selected.has(group.spellId)).reduce((sum, group) => sum + group.count, 0)} 个时间点</span><button className="button button-gold" onClick={applyImport} disabled={busy}>{busy ? "正在写入…" : "导入并替换当前时间线"}</button></footer></div>}
      </section>
    </div>
  );
}
