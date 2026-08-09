"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */
/* eslint-disable react-hooks/immutability -- Catalog entries are edited as a detached draft and cloned into state after each form event. */

import { useEffect, useMemo, useState } from "react";
import { validateCatalogRelease } from "@/lib/catalog";
import { formatTime } from "@/lib/core";
import type { ApiError, BossMechanic, CatalogRelease, PlayerSkill, TimelinePreset } from "@/lib/types";
import { ThemeControl } from "./ThemeControl";

type Tab = "skills" | "mechanics" | "presets";

function copyId(id: string) { return `${id}-copy-${Date.now().toString(36)}`.slice(0, 80); }

export function AdminClient() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState<CatalogRelease | null>(null);
  const [tab, setTab] = useState<Tab>("skills");
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadCatalog() {
    const response = await fetch("/api/catalog/current");
    const payload = await response.json() as { data?: CatalogRelease; error?: ApiError };
    if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取目录失败");
    const next = structuredClone(payload.data);
    next.manifest.version = `${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}-1`;
    setDraft(next);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/admin/session").then((response) => response.json() as Promise<{ data?: { authenticated: boolean } }>),
      fetch("/api/catalog/current").then((response) => response.json() as Promise<{ data?: CatalogRelease }>),
    ]).then(([session, catalog]) => {
      if (cancelled) return;
      setAuthenticated(Boolean(session.data?.authenticated));
      if (catalog.data) {
        const next = structuredClone(catalog.data as CatalogRelease);
        next.manifest.version = `${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}-1`;
        setDraft(next);
      }
    }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "加载失败"); });
    return () => { cancelled = true; };
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const payload = await response.json() as { data?: { authenticated: boolean }; error?: ApiError };
      if (!response.ok) throw new Error(payload.error?.message ?? "登录失败");
      setAuthenticated(true); setPassword(""); await loadCatalog();
    } catch (error) { setMessage(error instanceof Error ? error.message : "登录失败"); }
    finally { setBusy(false); }
  }

  function update(next: CatalogRelease) { setDraft(structuredClone(next)); }
  const items = useMemo(() => !draft ? [] : tab === "skills" ? draft.playerSkills : tab === "mechanics" ? draft.bossMechanics : draft.timelinePresets, [draft, tab]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  function addItem() {
    if (!draft) return;
    const id = `${tab.slice(0, -1)}-${Date.now().toString(36)}`;
    if (tab === "skills") draft.playerSkills.push({ id, name: "新技能", description: "", classSlug: "Priest", specSlugs: [], scope: "team", cooldownMs: null, castTimeMs: null, durationMs: null, triggersGcd: null, maxTargets: null, effects: [], category: "自定义", color: "#e7e7e7", catalogVersion: draft.manifest.version, dataStatus: "unconfigured", enabled: false, gameVersion: draft.manifest.gameVersion });
    if (tab === "mechanics") draft.bossMechanics.push({ id, name: "新机制", description: "", gameVersion: draft.manifest.gameVersion, raidId: "", bossId: "", difficulties: [], enabled: false, castTimeMs: 0, durationMs: 0, damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false }, targets: { mode: "all" }, severity: "warning", note: "" });
    if (tab === "presets") draft.timelinePresets.push({ id, name: "新预设", description: "", gameVersion: draft.manifest.gameVersion, raidId: "", bossId: "", difficulties: [], enabled: false, encounter: { name: "新首领", difficulty: "史诗", durationMs: 600_000 }, phases: [{ id: "p1", name: "P1", atMs: 0 }], mechanics: [] });
    update(draft); setSelectedId(id);
  }

  function copyItem() {
    if (!draft || !selected) return;
    const copy = structuredClone(selected); copy.id = copyId(copy.id); copy.name += "（副本）"; copy.enabled = false;
    if (tab === "skills") draft.playerSkills.push(copy as PlayerSkill);
    if (tab === "mechanics") draft.bossMechanics.push(copy as BossMechanic);
    if (tab === "presets") draft.timelinePresets.push(copy as TimelinePreset);
    update(draft); setSelectedId(copy.id);
  }

  function removeItem() {
    if (!draft || !selected || !confirm(`删除“${selected.name}”？`)) return;
    if (tab === "skills") draft.playerSkills = draft.playerSkills.filter((item) => item.id !== selected.id);
    if (tab === "mechanics") draft.bossMechanics = draft.bossMechanics.filter((item) => item.id !== selected.id);
    if (tab === "presets") draft.timelinePresets = draft.timelinePresets.filter((item) => item.id !== selected.id);
    update(draft); setSelectedId("");
  }

  function validate() {
    try { if (!draft) return; validateCatalogRelease(draft); setMessage("校验通过，可以显式发布这个版本。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "校验失败"); }
  }

  async function publish() {
    if (!draft || !confirm(`发布目录版本 ${draft.manifest.version}？current.json 只会在全部文件写入后更新。`)) return;
    setBusy(true); setMessage("");
    try {
      const validated = validateCatalogRelease(draft);
      const response = await fetch("/api/admin/catalog/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validated) });
      const payload = await response.json() as { data?: CatalogRelease; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "发布失败");
      setDraft(payload.data); setMessage(`目录 ${payload.data.manifest.version} 已发布。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "发布失败"); }
    finally { setBusy(false); }
  }

  if (authenticated == null || !draft) return <main className="state-page"><p>正在读取目录…</p></main>;
  if (!authenticated) return <main className="state-page"><form className="state-card admin-login" onSubmit={login}><h1>目录管理</h1><p>请输入独立管理员口令。口令只用于发布技能、Boss 机制与预设目录。</p><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员口令" /><button className="primary-action" disabled={busy}>登录</button>{message && <p className="form-error">{message}</p>}<a href="/">返回首页</a></form></main>;

  return <main className="admin-workspace">
    <header className="utility-header"><a className="utility-brand" href="/"><span>轴</span><strong>目录管理</strong></a><div><button onClick={validate}>校验</button><button className="primary-action" disabled={busy} onClick={publish}>显式发布版本</button><button onClick={async () => { await fetch("/api/admin/session", { method: "DELETE" }); setAuthenticated(false); }}>退出</button><ThemeControl compact /></div></header>
    <section className="admin-release-bar"><label>版本<input value={draft.manifest.version} onChange={(event) => { draft.manifest.version = event.target.value; update(draft); }} /></label><label>游戏版本<input value={draft.manifest.gameVersion} onChange={(event) => { draft.manifest.gameVersion = event.target.value; update(draft); }} /></label><label>标题<input value={draft.manifest.title} onChange={(event) => { draft.manifest.title = event.target.value; update(draft); }} /></label><span>{draft.playerSkills.length} 技能 · {draft.bossMechanics.length} 机制 · {draft.timelinePresets.length} 预设</span></section>
    {message && <div className="admin-message">{message}<button onClick={() => setMessage("")}>×</button></div>}
    <div className="admin-grid">
      <aside><nav>{([['skills','玩家技能'],['mechanics','Boss 机制'],['presets','时间轴预设']] as const).map(([id,label]) => <button className={tab === id ? "active" : ""} key={id} onClick={() => { setTab(id); setSelectedId(""); }}>{label}</button>)}</nav><button className="secondary-action" onClick={addItem}>＋ 新建条目</button><div className="admin-item-list">{items.map((item) => <button className={selectedId === item.id ? "selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><span><b>{item.name}</b><small>{item.id}</small></span><i className={item.enabled ? "enabled" : "disabled"}>{item.enabled ? "启用" : "停用"}</i></button>)}</div></aside>
      <section className="admin-editor">{!selected && <div className="table-empty">选择一个条目进行表单编辑，或创建新条目。</div>}{selected && <><header><div><h1>{selected.name}</h1><code>{selected.id}</code></div><div><button onClick={copyItem}>复制</button><button onClick={() => { selected.enabled = !selected.enabled; update(draft); }}>{selected.enabled ? "停用" : "启用"}</button><button className="danger-link" onClick={removeItem}>删除</button></div></header><CommonFields item={selected} onChange={() => update(draft)} />{tab === "skills" && <SkillFields item={selected as PlayerSkill} onChange={() => update(draft)} />}{tab === "mechanics" && <MechanicFields item={selected as BossMechanic} onChange={() => update(draft)} />}{tab === "presets" && <PresetFields item={selected as TimelinePreset} mechanics={draft.bossMechanics} onChange={() => update(draft)} />}</>}</section>
    </div>
  </main>;
}

function CommonFields({ item, onChange }: { item: PlayerSkill | BossMechanic | TimelinePreset; onChange: () => void }) {
  return <div className="admin-form"><label>ID<input value={item.id} onChange={(event) => { item.id = event.target.value; onChange(); }} /></label><label>名称<input value={item.name} onChange={(event) => { item.name = event.target.value; onChange(); }} /></label><label className="wide">说明<textarea rows={3} value={item.description} onChange={(event) => { item.description = event.target.value; onChange(); }} /></label><label>游戏版本<input value={item.gameVersion} onChange={(event) => { item.gameVersion = event.target.value; onChange(); }} /></label></div>;
}

function SkillFields({ item, onChange }: { item: PlayerSkill; onChange: () => void }) {
  return <div className="admin-form"><label>职业<input value={item.classSlug} onChange={(event) => { item.classSlug = event.target.value; onChange(); }} /></label><label>类别<input value={item.category} onChange={(event) => { item.category = event.target.value as PlayerSkill["category"]; onChange(); }} /></label><label>冷却毫秒<input type="number" value={item.cooldownMs ?? ""} onChange={(event) => { item.cooldownMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><label>持续毫秒<input type="number" value={item.durationMs ?? ""} onChange={(event) => { item.durationMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><p className="wide field-note">未知数值保持为空；不要用 0 代替“未配置”。复杂效果可保留现有结构，第一版表单不强迫补齐易变数值。</p></div>;
}

function MechanicFields({ item, onChange }: { item: BossMechanic; onChange: () => void }) {
  return <div className="admin-form"><label>副本 ID<input value={item.raidId} onChange={(event) => { item.raidId = event.target.value; onChange(); }} /></label><label>Boss ID<input value={item.bossId} onChange={(event) => { item.bossId = event.target.value; onChange(); }} /></label><label>难度（逗号分隔）<input value={item.difficulties.join("、")} onChange={(event) => { item.difficulties = event.target.value.split(/[、,，]/).map((value) => value.trim()).filter(Boolean); onChange(); }} /></label><label>施法毫秒<input type="number" value={item.castTimeMs ?? ""} onChange={(event) => { item.castTimeMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><label>持续毫秒<input type="number" value={item.durationMs ?? ""} onChange={(event) => { item.durationMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><label>危险度<select value={item.severity} onChange={(event) => { item.severity = event.target.value as BossMechanic["severity"]; onChange(); }}><option value="info">提示</option><option value="warning">警告</option><option value="danger">危险</option></select></label></div>;
}

function PresetFields({ item, mechanics, onChange }: { item: TimelinePreset; mechanics: BossMechanic[]; onChange: () => void }) {
  return <><div className="admin-form"><label>副本 ID<input value={item.raidId} onChange={(event) => { item.raidId = event.target.value; onChange(); }} /></label><label>Boss ID<input value={item.bossId} onChange={(event) => { item.bossId = event.target.value; onChange(); }} /></label><label>战斗时长（毫秒）<input type="number" value={item.encounter.durationMs} onChange={(event) => { item.encounter.durationMs = Number(event.target.value); onChange(); }} /></label><label>难度（逗号分隔）<input value={item.difficulties.join("、")} onChange={(event) => { item.difficulties = event.target.value.split(/[、,，]/).map((value) => value.trim()).filter(Boolean); onChange(); }} /></label></div><section className="admin-timeline-preview"><header><b>时间轴预览</b><button onClick={() => { const mechanic = mechanics.find((entry) => entry.enabled) ?? mechanics[0]; if (mechanic) { item.mechanics.push({ mechanicId: mechanic.id, atMs: 30_000 }); onChange(); } }}>＋ 引用机制</button></header>{item.mechanics.slice().sort((a,b) => a.atMs-b.atMs).map((reference, index) => <div key={`${reference.mechanicId}-${index}`}><input value={formatTime(reference.atMs)} onChange={(event) => { const [minutes,seconds] = event.target.value.split(":").map(Number); if (Number.isFinite(minutes) && Number.isFinite(seconds)) reference.atMs = (minutes * 60 + seconds) * 1000; onChange(); }} /><select value={reference.mechanicId} onChange={(event) => { reference.mechanicId = event.target.value; onChange(); }}>{mechanics.map((mechanic) => <option value={mechanic.id} key={mechanic.id}>{mechanic.name}</option>)}</select><button onClick={() => { item.mechanics.splice(index, 1); onChange(); }}>×</button></div>)}</section></>;
}
