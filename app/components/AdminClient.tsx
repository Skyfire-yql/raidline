"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */
/* eslint-disable react-hooks/immutability -- Catalog entries are edited as a detached draft and cloned into state after each form event. */

import { useEffect, useMemo, useState } from "react";
import { validateCatalogRelease } from "@/lib/catalog";
import { specializationsForClass, WOW_CLASS_LABELS } from "@/lib/cooldowns";
import { formatTime, parseTime, snapTime } from "@/lib/core";
import { skillDataStatusLabel } from "@/lib/skills";
import type { ApiError, BossMechanic, CatalogRelease, CooldownEffect, PlayerSkill, SkillSource, SkillVariant, TimelinePreset } from "@/lib/types";
import { ThemeControl } from "./ThemeControl";

type Tab = "skills" | "mechanics" | "presets";

function copyId(id: string) { return `${id}-copy-${Date.now().toString(36)}`.slice(0, 80); }
function nextCatalogVersion(current: string) {
  return current.startsWith("builtin-seed-") ? "retail-12.1-priest-v1" : `${new Date().toISOString().slice(0, 10).replaceAll("-", ".")}-1`;
}

function AdminTimeField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(formatTime(value));
  useEffect(() => {
    const timer = setTimeout(() => setDraft(formatTime(value)), 0);
    return () => clearTimeout(timer);
  }, [value]);
  function commit() {
    const parsed = parseTime(draft);
    if (parsed == null) setDraft(formatTime(value));
    else onChange(snapTime(parsed));
  }
  return <input aria-label="时间" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

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
    next.manifest.version = nextCatalogVersion(next.manifest.version);
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
        next.manifest.version = nextCatalogVersion(next.manifest.version);
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
    if (tab === "skills") draft.playerSkills.push({ id, name: "新技能", description: "", classSlug: "Priest", specSlugs: [], scope: "team", cooldownMs: null, castType: "unknown", castTimeMs: null, durationMs: null, triggersGcd: null, maxCharges: 1, maxTargets: null, effects: [], variants: [], limitations: [], category: "自定义", color: "#e7e7e7", catalogVersion: draft.manifest.version, dataStatus: "unconfigured", enabled: false, gameVersion: draft.manifest.gameVersion });
    if (tab === "mechanics") draft.bossMechanics.push({ id, name: "新机制", description: "", gameVersion: draft.manifest.gameVersion, raidId: "", bossId: "", enabled: false, castTimeMs: 0, durationMs: 0, damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false }, targets: { mode: "all" }, severity: "warning", note: "" });
    if (tab === "presets") draft.timelinePresets.push({ id, name: "新预设", description: "", gameVersion: draft.manifest.gameVersion, raidId: "", bossId: "", enabled: false, encounter: { name: "新首领" }, phases: [{ id: "p1", name: "P1", atMs: 0 }], timelineNotes: [], mechanics: [] });
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
  const specs = specializationsForClass(item.classSlug);
  function toggleSpec(slug: string) {
    item.specSlugs = item.specSlugs.includes(slug) ? item.specSlugs.filter((value) => value !== slug) : [...item.specSlugs, slug];
    onChange();
  }
  return <div className="admin-form">
    <label>法术 ID<input type="number" value={item.spellId ?? ""} onChange={(event) => { if (event.target.value) item.spellId = Number(event.target.value); else delete item.spellId; onChange(); }} /></label>
    <label>职业<select value={item.classSlug} onChange={(event) => { item.classSlug = event.target.value; item.specSlugs = []; onChange(); }}>{Object.entries(WOW_CLASS_LABELS).map(([slug, label]) => <option value={slug} key={slug}>{label}</option>)}</select></label>
    <fieldset className="wide admin-fieldset"><legend>专精归属（不选表示职业通用）</legend><div className="check-grid">{specs.map((spec) => <label key={spec.slug}><input type="checkbox" checked={item.specSlugs.includes(spec.slug)} onChange={() => toggleSpec(spec.slug)} />{spec.label}</label>)}</div></fieldset>
    <label>作用范围<select value={item.scope} onChange={(event) => { item.scope = event.target.value as PlayerSkill["scope"]; if (item.scope === "personal") item.maxTargets = 1; onChange(); }}><option value="team">团队</option><option value="external">单体外部</option><option value="personal">个人</option></select></label>
    <label>类别<select value={item.category} onChange={(event) => { item.category = event.target.value as PlayerSkill["category"]; onChange(); }}>{["团队减伤", "外部减伤", "个人减伤", "治疗", "免疫", "位移", "自定义"].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
    <label>数据状态<select value={item.dataStatus} onChange={(event) => { item.dataStatus = event.target.value as PlayerSkill["dataStatus"]; onChange(); }}><option value="unconfigured">数值待补</option><option value="needs-live-check">待正式服复核</option><option value="verified">已核准</option><option value="legacy">旧数据</option><option value="custom">自定义</option></select></label>
    <label>施法类型<select value={item.castType} onChange={(event) => { item.castType = event.target.value as PlayerSkill["castType"]; if (item.castType === "instant") item.castTimeMs = 0; else if (item.castType === "unknown") item.castTimeMs = null; else if (item.castTimeMs == null || item.castTimeMs === 0) item.castTimeMs = 1000; onChange(); }}><option value="unknown">待补</option><option value="instant">瞬发</option><option value="cast">读条</option><option value="channel">引导</option></select></label>
    <NullableAdminNumber label="冷却毫秒" value={item.cooldownMs} onChange={(value) => { item.cooldownMs = value; onChange(); }} />
    <NullableAdminNumber label="施法 / 引导毫秒" value={item.castTimeMs} onChange={(value) => { item.castTimeMs = value; if (value === 0) item.castType = "instant"; else if (value == null) item.castType = "unknown"; onChange(); }} />
    <NullableAdminNumber label="持续毫秒" value={item.durationMs} onChange={(value) => { item.durationMs = value; onChange(); }} />
    <label>充能层数<input type="number" min={1} max={10} value={item.maxCharges} onChange={(event) => { item.maxCharges = Math.max(1, Math.round(Number(event.target.value) || 1)); onChange(); }} /></label>
    <label>GCD<select value={item.triggersGcd == null ? "unknown" : item.triggersGcd ? "yes" : "no"} onChange={(event) => { item.triggersGcd = event.target.value === "unknown" ? null : event.target.value === "yes"; onChange(); }}><option value="unknown">待补</option><option value="yes">占用</option><option value="no">不占用</option></select></label>
    <NullableAdminNumber label="目标上限" value={item.maxTargets} onChange={(value) => { item.maxTargets = value; onChange(); }} />
    <label>标识色<input type="color" value={item.color} onChange={(event) => { item.color = event.target.value; onChange(); }} /></label>
    <label className="wide">计算限制<textarea rows={3} placeholder="每行一项" value={item.limitations.join("\n")} onChange={(event) => { item.limitations = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); onChange(); }} /></label>
    <section className="wide admin-skill-section"><header><div><b>结构化效果</b><small>用于覆盖与目标检查</small></div><button onClick={() => { item.effects.push({ type: "damageReduction", percent: null, schools: ["physical", "magic"] }); onChange(); }}>＋ 效果</button></header><EffectsEditor effects={item.effects} onChange={onChange} /></section>
    <section className="wide admin-skill-section"><header><div><b>关键天赋变体</b><small>同一成员、同一技能只选择一个</small></div><button onClick={() => { item.variants.push({ id: `variant-${Date.now().toString(36)}`, name: "新变体", description: "", overrides: {}, limitations: [] }); onChange(); }}>＋ 变体</button></header>{item.variants.map((variant) => <VariantEditor key={variant.id} variant={variant} onRemove={() => { item.variants = item.variants.filter((entry) => entry !== variant); onChange(); }} onChange={onChange} />)}{!item.variants.length && <p className="table-empty">该技能没有关键变体。</p>}</section>
    <VerificationEditor item={item} onChange={onChange} />
  </div>;
}

function NullableAdminNumber({ label, value, onChange }: { label: string; value: number | null | undefined; onChange: (value: number | null) => void }) {
  return <label>{label}<input type="number" min={0} value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : Math.max(0, Number(event.target.value)))} /></label>;
}

function toggleEffectSchool(effect: Exclude<CooldownEffect, { type: "maxHealth" }>, school: "physical" | "magic") {
  effect.schools = effect.schools.includes(school) ? effect.schools.filter((value) => value !== school) : [...effect.schools, school];
}

function effectForType(type: CooldownEffect["type"]): CooldownEffect {
  if (type === "damageReduction") return { type, percent: null, schools: ["physical", "magic"] };
  if (type === "absorb") return { type, amount: null, allocation: "perTarget", schools: ["physical", "magic"] };
  if (type === "maxHealth") return { type, percent: null };
  return { type, schools: ["physical", "magic"] };
}

function EffectsEditor({ effects, onChange }: { effects: CooldownEffect[]; onChange: () => void }) {
  return <div className="admin-effect-list">{effects.map((effect, index) => <div key={`${effect.type}-${index}`}><select value={effect.type} onChange={(event) => { effects[index] = effectForType(event.target.value as CooldownEffect["type"]); onChange(); }}><option value="damageReduction">减伤</option><option value="absorb">吸收</option><option value="maxHealth">最大生命</option><option value="immunity">免疫</option></select>{effect.type === "damageReduction" && <input type="number" min={0} max={100} placeholder="百分比" value={effect.percent ?? ""} onChange={(event) => { effect.percent = event.target.value === "" ? null : Number(event.target.value); onChange(); }} />}{effect.type === "maxHealth" && <input type="number" min={0} placeholder="百分比" value={effect.percent ?? ""} onChange={(event) => { effect.percent = event.target.value === "" ? null : Number(event.target.value); onChange(); }} />}{effect.type === "absorb" && <><input type="number" min={0} placeholder="吸收量" value={effect.amount ?? ""} onChange={(event) => { effect.amount = event.target.value === "" ? null : Number(event.target.value); onChange(); }} /><select value={effect.allocation} onChange={(event) => { effect.allocation = event.target.value as "perTarget" | "shared"; onChange(); }}><option value="perTarget">每目标</option><option value="shared">共享</option></select></>}{effect.type !== "maxHealth" && <span className="effect-schools"><label><input type="checkbox" checked={effect.schools.includes("physical")} onChange={() => { toggleEffectSchool(effect, "physical"); onChange(); }} />物理</label><label><input type="checkbox" checked={effect.schools.includes("magic")} onChange={() => { toggleEffectSchool(effect, "magic"); onChange(); }} />魔法</label></span>}<button className="danger-link" onClick={() => { effects.splice(index, 1); onChange(); }}>删除</button></div>)}{!effects.length && <p className="table-empty">暂无结构化效果。</p>}</div>;
}

function setOptionalNumber(target: SkillVariant["overrides"], key: "cooldownMs" | "castTimeMs" | "durationMs" | "maxCharges" | "maxTargets", value: string) {
  if (value === "") delete target[key];
  else (target as Record<string, unknown>)[key] = Math.max(key === "maxCharges" ? 1 : 0, Number(value));
}

function VariantEditor({ variant, onRemove, onChange }: { variant: SkillVariant; onRemove: () => void; onChange: () => void }) {
  const overrides = variant.overrides;
  return <article className="admin-variant-card"><header><b>{variant.name}</b><button className="danger-link" onClick={onRemove}>删除</button></header><div className="admin-form"><label>稳定 ID<input value={variant.id} onChange={(event) => { variant.id = event.target.value; onChange(); }} /></label><label>名称<input value={variant.name} onChange={(event) => { variant.name = event.target.value; onChange(); }} /></label><label>天赋法术 ID<input type="number" value={variant.talentSpellId ?? ""} onChange={(event) => { if (event.target.value) variant.talentSpellId = Number(event.target.value); else delete variant.talentSpellId; onChange(); }} /></label><label className="wide">说明<textarea rows={2} value={variant.description} onChange={(event) => { variant.description = event.target.value; onChange(); }} /></label><label>冷却覆盖<input type="number" min={0} placeholder="继承基础值" value={overrides.cooldownMs ?? ""} onChange={(event) => { setOptionalNumber(overrides, "cooldownMs", event.target.value); onChange(); }} /></label><label>充能覆盖<input type="number" min={1} max={10} placeholder="继承基础值" value={overrides.maxCharges ?? ""} onChange={(event) => { setOptionalNumber(overrides, "maxCharges", event.target.value); onChange(); }} /></label><label>施法类型覆盖<select value={overrides.castType ?? "inherit"} onChange={(event) => { if (event.target.value === "inherit") delete overrides.castType; else overrides.castType = event.target.value as NonNullable<typeof overrides.castType>; if (overrides.castType === "instant") overrides.castTimeMs = 0; onChange(); }}><option value="inherit">继承</option><option value="unknown">待补</option><option value="instant">瞬发</option><option value="cast">读条</option><option value="channel">引导</option></select></label><label>施法时间覆盖<input type="number" min={0} placeholder="继承基础值" value={overrides.castTimeMs ?? ""} onChange={(event) => { setOptionalNumber(overrides, "castTimeMs", event.target.value); onChange(); }} /></label><label>持续覆盖<input type="number" min={0} placeholder="继承基础值" value={overrides.durationMs ?? ""} onChange={(event) => { setOptionalNumber(overrides, "durationMs", event.target.value); onChange(); }} /></label><label>GCD 覆盖<select value={overrides.triggersGcd == null ? "inherit" : overrides.triggersGcd ? "yes" : "no"} onChange={(event) => { if (event.target.value === "inherit") delete overrides.triggersGcd; else overrides.triggersGcd = event.target.value === "yes"; onChange(); }}><option value="inherit">继承</option><option value="yes">占用</option><option value="no">不占用</option></select></label><label>目标上限覆盖<input type="number" min={0} placeholder="继承基础值" value={overrides.maxTargets ?? ""} onChange={(event) => { setOptionalNumber(overrides, "maxTargets", event.target.value); onChange(); }} /></label><label className="wide">计算限制<textarea rows={2} value={variant.limitations.join("\n")} onChange={(event) => { variant.limitations = event.target.value.split("\n").map((value) => value.trim()).filter(Boolean); onChange(); }} /></label></div><label className="inline-check"><input type="checkbox" checked={overrides.effects != null} onChange={(event) => { if (event.target.checked) overrides.effects = []; else delete overrides.effects; onChange(); }} />覆盖基础效果</label>{overrides.effects && <EffectsEditor effects={overrides.effects} onChange={onChange} />}</article>;
}

function VerificationEditor({ item, onChange }: { item: PlayerSkill; onChange: () => void }) {
  const verification = item.verification;
  if (!verification) return <section className="wide admin-skill-section"><header><div><b>核准记录</b><small>{skillDataStatusLabel(item.dataStatus)}</small></div><button onClick={() => { item.verification = { gameVersion: item.gameVersion, checkedAt: null, sources: [] }; onChange(); }}>＋ 建立记录</button></header><p className="table-empty">正式服核准前可保持为空。</p></section>;
  function addSource() { item.verification?.sources.push({ kind: "community", label: "新来源" }); onChange(); }
  return <section className="wide admin-skill-section"><header><div><b>核准记录</b><small>“已核准”必须同时有正式服/Blizzard 主来源与社区复核</small></div><button onClick={addSource}>＋ 来源</button></header><div className="admin-form"><label>核准版本<input value={verification.gameVersion} onChange={(event) => { verification.gameVersion = event.target.value; onChange(); }} /></label><label>客户端构建<input value={verification.clientBuild ?? ""} placeholder="可选" onChange={(event) => { verification.clientBuild = event.target.value || undefined; onChange(); }} /></label><label>核准时间<input type="datetime-local" value={verification.checkedAt ? new Date(verification.checkedAt).toISOString().slice(0, 16) : ""} onChange={(event) => { verification.checkedAt = event.target.value ? new Date(event.target.value).getTime() : null; onChange(); }} /></label></div><div className="admin-source-list">{verification.sources.map((source, index) => <SourceEditor key={`${source.kind}-${index}`} source={source} onRemove={() => { verification.sources.splice(index, 1); onChange(); }} onChange={onChange} />)}{!verification.sources.length && <p className="table-empty">尚未添加数据来源。</p>}</div></section>;
}

function SourceEditor({ source, onRemove, onChange }: { source: SkillSource; onRemove: () => void; onChange: () => void }) {
  return <div><select value={source.kind} onChange={(event) => { source.kind = event.target.value as SkillSource["kind"]; onChange(); }}><option value="in-game">正式服客户端</option><option value="blizzard">Blizzard</option><option value="community">社区</option></select><input value={source.label} placeholder="来源名称" onChange={(event) => { source.label = event.target.value; onChange(); }} /><input value={source.url ?? ""} placeholder="https://（客户端来源可留空）" onChange={(event) => { source.url = event.target.value || undefined; onChange(); }} /><input value={source.note ?? ""} placeholder="备注" onChange={(event) => { source.note = event.target.value || undefined; onChange(); }} /><button className="danger-link" onClick={onRemove}>删除</button></div>;
}

function MechanicFields({ item, onChange }: { item: BossMechanic; onChange: () => void }) {
  return <div className="admin-form"><label>副本 ID<input value={item.raidId} onChange={(event) => { item.raidId = event.target.value; onChange(); }} /></label><label>Boss ID<input value={item.bossId} onChange={(event) => { item.bossId = event.target.value; onChange(); }} /></label><label>施法毫秒<input type="number" value={item.castTimeMs ?? ""} onChange={(event) => { item.castTimeMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><label>持续毫秒<input type="number" value={item.durationMs ?? ""} onChange={(event) => { item.durationMs = event.target.value ? Number(event.target.value) : null; onChange(); }} /></label><label>危险度<select value={item.severity} onChange={(event) => { item.severity = event.target.value as BossMechanic["severity"]; onChange(); }}><option value="info">提示</option><option value="warning">警告</option><option value="danger">危险</option></select></label></div>;
}

function PresetFields({ item, mechanics, onChange }: { item: TimelinePreset; mechanics: BossMechanic[]; onChange: () => void }) {
  const phaseOptions = item.phases.slice().sort((a, b) => a.atMs - b.atMs);
  return <><div className="admin-form"><label>副本 ID<input value={item.raidId} onChange={(event) => { item.raidId = event.target.value; onChange(); }} /></label><label>Boss ID<input value={item.bossId} onChange={(event) => { item.bossId = event.target.value; onChange(); }} /></label><label>计划名称<input value={item.encounter.name} onChange={(event) => { item.encounter.name = event.target.value; onChange(); }} /></label></div><section className="admin-timeline-preview"><header><b>时间轴预览</b><div><button onClick={() => { item.phases.push({ id: `phase-${Date.now().toString(36)}`, name: `P${item.phases.length + 1}`, atMs: 30_000 }); onChange(); }}>＋ 阶段</button><button onClick={() => { item.timelineNotes.push({ id: `note-${Date.now().toString(36)}`, text: "新注释", atMs: 30_000 }); onChange(); }}>＋ 注释</button><button onClick={() => { const mechanic = mechanics.find((entry) => entry.enabled) ?? mechanics[0]; if (mechanic) { item.mechanics.push({ mechanicId: mechanic.id, atMs: 30_000 }); onChange(); } }}>＋ 引用机制</button></div></header>
    {item.phases.slice().sort((a,b) => a.atMs-b.atMs).map((phase) => <div className="admin-timeline-row" key={phase.id}><span>阶段</span><AdminTimeField value={phase.atMs} onChange={(value) => { phase.atMs = value; onChange(); }} /><input value={phase.name} onChange={(event) => { phase.name = event.target.value; onChange(); }} /><code>{phase.id}</code><button onClick={() => { item.phases = item.phases.filter((entry) => entry.id !== phase.id); item.mechanics.forEach((reference) => { if (reference.phaseId === phase.id) reference.phaseId = undefined; }); onChange(); }}>×</button></div>)}
    {item.timelineNotes.slice().sort((a,b) => a.atMs-b.atMs).map((note) => <div className="admin-timeline-row" key={note.id}><span>注释</span><AdminTimeField value={note.atMs} onChange={(value) => { note.atMs = value; onChange(); }} /><input value={note.text} onChange={(event) => { note.text = event.target.value; onChange(); }} /><code>{note.id}</code><button onClick={() => { item.timelineNotes = item.timelineNotes.filter((entry) => entry.id !== note.id); onChange(); }}>×</button></div>)}
    {item.mechanics.slice().sort((a,b) => a.atMs-b.atMs).map((reference, index) => <div className="admin-timeline-row" key={`${reference.mechanicId}-${reference.atMs}-${index}`}><span>机制</span><AdminTimeField value={reference.atMs} onChange={(value) => { reference.atMs = value; onChange(); }} /><select value={reference.mechanicId} onChange={(event) => { reference.mechanicId = event.target.value; onChange(); }}>{mechanics.map((mechanic) => <option value={mechanic.id} key={mechanic.id}>{mechanic.name}</option>)}</select><select value={reference.phaseId ?? ""} onChange={(event) => { reference.phaseId = event.target.value || undefined; onChange(); }}><option value="">未指定阶段</option>{phaseOptions.map((phase) => <option value={phase.id} key={phase.id}>{phase.name}</option>)}</select><button onClick={() => { const sourceIndex = item.mechanics.indexOf(reference); if (sourceIndex >= 0) item.mechanics.splice(sourceIndex, 1); onChange(); }}>×</button></div>)}
  </section></>;
}
