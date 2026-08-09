"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { applyCatalogPreset, SEED_CATALOG } from "@/lib/catalog";
import { createBlankPlan } from "@/lib/core";
import type { CatalogRelease, LocalPlanRecord } from "@/lib/types";
import {
  cacheCatalog,
  createLocalPlan,
  deleteLocalPlan,
  duplicateLocalPlan,
  getCachedCatalog,
  listLocalPlans,
  requestPersistentStorage,
} from "./local-store";
import { ThemeControl } from "./ThemeControl";

export function HomeClient() {
  const router = useRouter();
  const [plans, setPlans] = useState<LocalPlanRecord[]>([]);
  const [catalog, setCatalog] = useState<CatalogRelease>(SEED_CATALOG);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function refreshPlans() {
    setPlans(await listLocalPlans());
  }

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(async () => {
      try {
        await requestPersistentStorage();
        const [localPlans, cached] = await Promise.all([listLocalPlans(), getCachedCatalog()]);
        if (!cancelled) {
          setPlans(localPlans);
          if (cached) setCatalog(cached);
        }
        const response = await fetch("/api/catalog/current");
        const payload = await response.json() as { data?: CatalogRelease };
        if (response.ok && payload.data) {
          await cacheCatalog(payload.data);
          if (!cancelled) setCatalog(payload.data);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "无法读取本地计划");
      }
    });
    return () => { cancelled = true; };
  }, []);

  async function createBlank() {
    setBusy("blank"); setError("");
    try {
      const record = await createLocalPlan(createBlankPlan());
      router.push(`/plans/${record.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败"); setBusy("");
    }
  }

  async function createFromPreset(presetId: string) {
    setBusy(presetId); setError("");
    try {
      const preset = catalog.timelinePresets.find((item) => item.id === presetId);
      if (!preset) throw new Error("预设不存在");
      const record = await createLocalPlan(applyCatalogPreset(createBlankPlan(), catalog, preset));
      router.push(`/plans/${record.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败"); setBusy("");
    }
  }

  async function copyPlan(plan: LocalPlanRecord) {
    setBusy(`copy-${plan.id}`); setError("");
    try {
      const copy = await duplicateLocalPlan(plan);
      router.push(`/plans/${copy.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复制失败"); setBusy("");
    }
  }

  return (
    <main className="utility-home">
      <header className="utility-header">
        <a className="utility-brand" href="/"><span>轴</span><strong>团轴 Raidline</strong></a>
        <div><a className="header-link" href="/admin">目录管理</a><span className="private-state">● 本地优先</span><ThemeControl compact /></div>
      </header>
      <section className="home-intro">
        <div><h1>团本排轴工作台</h1><p>编辑内容先保存在当前浏览器，只有主动发布才会写入服务器。</p></div>
        <button className="primary-action" onClick={createBlank} disabled={Boolean(busy)}>＋ 创建空白计划</button>
      </section>
      <div className="home-workbench">
        <section className="work-table">
          <header><h2>我的本地轴</h2><span>{plans.length} 项 · IndexedDB</span></header>
          <div className="compact-list local-plan-list">
            {plans.map((plan) => <div className="compact-plan-row" key={plan.id}>
              <button onClick={() => router.push(`/plans/${plan.id}`)}><span><strong>{plan.title}</strong><small>{new Date(plan.updatedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })} · 本地版本 {plan.localRevision}{plan.activePublication ? ` · 已发布 ${plan.activePublication.shareId}` : ""}</small></span><b>打开</b></button>
              <button aria-label={`复制 ${plan.title}`} onClick={() => copyPlan(plan)} disabled={Boolean(busy)}>复制</button>
              <button className="danger-link" aria-label={`删除 ${plan.title}`} onClick={async () => { if (!confirm(`删除本地计划“${plan.title}”？此操作不会删除它已发布的链接。`)) return; await deleteLocalPlan(plan.id); await refreshPlans(); }}>删除</button>
            </div>)}
            {!plans.length && <p className="table-empty">还没有本地计划。创建后会自动快照保存。</p>}
          </div>
        </section>
        <section className="work-table">
          <header><h2>目录预设</h2><span>{catalog.manifest.version} · {catalog.timelinePresets.filter((item) => item.enabled).length} 项</span></header>
          <div className="compact-list">
            {catalog.timelinePresets.filter((item) => item.enabled).map((preset) => <button key={preset.id} onClick={() => createFromPreset(preset.id)} disabled={Boolean(busy)}><span><strong>{preset.name}</strong><small>{preset.gameVersion} / {preset.raidId} / {preset.bossId} · {preset.description}</small></span><b>创建</b></button>)}
            {!catalog.timelinePresets.some((item) => item.enabled) && <p className="table-empty">当前目录没有启用的预设。</p>}
          </div>
        </section>
      </div>
      <footer className="utility-footer"><span>团轴 Raidline</span><span>本地工作副本 · 主动发布快照</span></footer>
      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}
