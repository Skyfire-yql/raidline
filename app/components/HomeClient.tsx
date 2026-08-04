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

  async function createPlan(mode: "blank" | "preset", preset?: RaidPlanPreset) {
    setBusy(mode + (preset?.id ?? "")); setError("");
    try {
      const response = await fetch("/api/plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: preset?.name ?? "新建团本排轴" }) });
      const payload = await response.json() as CreateResponse;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "创建失败");
      if (preset) {
        const base = createBlankPlan();
        const document = preset.kind === "built-in" ? applyBuiltInPreset(base, preset) : structuredClone(preset.document);
        const saved = await fetch(`/api/plans/${payload.data.id}`, { method: "PUT", headers: { authorization: `Bearer ${payload.data.editToken}`, "content-type": "application/json" }, body: JSON.stringify({ baseVersion: payload.data.version, document }) });
        if (!saved.ok) throw new Error("创建预设计划失败");
      }
      localStorage.setItem(`raidline:key:${payload.data.id}`, payload.data.editToken);
      router.push(`/plans/${payload.data.id}#key=${encodeURIComponent(payload.data.editToken)}`);
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
        <div><h1>团本排轴工作台</h1><p>用一张简洁时间轴安排机制与团队技能。</p></div>
        <button className="primary-action" onClick={() => createPlan("blank")} disabled={Boolean(busy)}>＋ 创建空白计划</button>
      </section>
      <div className="home-workbench">
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
      <footer className="utility-footer"><span>团轴 Raidline</span><span>个人团本排轴工具</span></footer>
      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}
