"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's Next Link shim is not client-runtime compatible here. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ThemeControl } from "./ThemeControl";
import { listPersonalPresets } from "./preset-store";
import { applyBuiltInPreset, BUILT_IN_PRESETS, type RaidPlanPreset } from "@/lib/presets";
import { createBlankPlan } from "@/lib/core";

interface RecentPlan { id: string; title: string; updatedAt: number }
interface CreateResponse { data?: { id: string; editToken: string; version: number }; error?: { message: string } }
const RECENT_KEY = "raidline:recent";

export function HomeClient() {
  const router = useRouter();
  const [recent, setRecent] = useState<RecentPlan[]>([]);
  const [personalPresets, setPersonalPresets] = useState<RaidPlanPreset[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 8)); } catch { setRecent([]); }
      listPersonalPresets().then((items) => { if (!cancelled) setPersonalPresets(items); }).catch(() => { if (!cancelled) setPersonalPresets([]); });
    });
    return () => { cancelled = true; };
  }, []);

  async function createPlan(mode: "blank" | "wcl" | "preset", preset?: RaidPlanPreset) {
    if (mode === "wcl" && !source.trim()) { setError("先粘贴一条 WCL 战报链接或报告代码"); return; }
    setBusy(mode + (preset?.id ?? "")); setError("");
    try {
      const response = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: preset?.name ?? (mode === "wcl" ? "正在导入 WCL…" : "新建团本排轴") }) });
      const payload = await response.json() as CreateResponse;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "创建失败");
      if (preset) {
        const base = createBlankPlan();
        if (preset.kind === "built-in") base.roster.push({ id: "preset-sample-member", name: "示例成员", classSlug: "Priest", specSlug: "示例专精", role: "healer", color: "#e7e7e7" });
        const document = preset.kind === "built-in" ? applyBuiltInPreset(base, preset) : structuredClone(preset.document);
        const saved = await fetch(`/api/plans/${payload.data.id}`, { method: "PUT", headers: { authorization: `Bearer ${payload.data.editToken}`, "content-type": "application/json" }, body: JSON.stringify({ baseVersion: payload.data.version, document }) });
        if (!saved.ok) throw new Error("创建预设计划失败");
      }
      localStorage.setItem(`raidline:key:${payload.data.id}`, payload.data.editToken);
      const query = mode === "wcl" ? `?wcl=${encodeURIComponent(source.trim())}` : "";
      router.push(`/plans/${payload.data.id}${query}#key=${encodeURIComponent(payload.data.editToken)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败，请稍后再试"); setBusy("");
    }
  }

  return (
    <main className="utility-home">
      <header className="utility-header">
        <a className="utility-brand" href="/"><span>轴</span><strong>团轴 Raidline</strong></a>
        <div><span className="private-state">● 仅所有者可见</span><ThemeControl compact /></div>
      </header>
      <section className="home-intro">
        <div><h1>团本排轴工作台</h1><p>成员、机制、减伤和治疗需求放进同一张可计算的时间表。</p></div>
        <button className="primary-action" onClick={() => createPlan("blank")} disabled={Boolean(busy)}>＋ 创建空白计划</button>
      </section>
      <div className="home-workbench">
        <section className="work-table">
          <header><h2>从 WCL 导入</h2><span>公开战报</span></header>
          <form onSubmit={(event) => { event.preventDefault(); createPlan("wcl"); }}>
            <label htmlFor="wcl-source">战报链接或报告代码</label>
            <input id="wcl-source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="warcraftlogs.com/reports/…" />
            <button type="submit" disabled={Boolean(busy)}>{busy === "wcl" ? "正在读取…" : "创建并分析"}</button>
            <small>伤害与持续时间不会猜测，导入后由你补充。</small>
          </form>
        </section>
        <section className="work-table">
          <header><h2>从预设创建</h2><span>{BUILT_IN_PRESETS.length + personalPresets.length} 项</span></header>
          <div className="compact-list">
            {[...BUILT_IN_PRESETS, ...personalPresets].map((preset) => <button key={preset.id} onClick={() => createPlan("preset", preset)} disabled={Boolean(busy)}><span><strong>{preset.name}</strong><small>{preset.kind === "built-in" ? "内置示例" : "当前设备"} · {preset.description}</small></span><b>创建</b></button>)}
            {!personalPresets.length && <p className="table-empty">可在编辑器中把完整计划保存为个人预设。</p>}
          </div>
        </section>
        <section className="work-table">
          <header><h2>最近编辑</h2><span>当前设备</span></header>
          <div className="compact-list">
            {recent.map((plan) => <button key={plan.id} onClick={() => router.push(`/plans/${plan.id}`)}><span><strong>{plan.title}</strong><small>{new Date(plan.updatedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</small></span><b>打开</b></button>)}
            {!recent.length && <p className="table-empty">还没有最近计划。</p>}
          </div>
        </section>
      </div>
      <footer className="utility-footer"><span>团轴 Raidline</span><span>非暴雪或 Warcraft Logs 官方产品</span></footer>
      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}
