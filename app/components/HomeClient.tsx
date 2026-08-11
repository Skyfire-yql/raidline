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

  return (
    <main className="utility-home">
      <header className="utility-header">
        <a className="utility-brand" href="/"><span>轴</span><strong>团轴 Raidline</strong></a>
        <div><ThemeControl compact /></div>
      </header>
      <div className="home-workbench">
        <section className="work-table">
          <header><h2>我的轴</h2><button className="primary-action" onClick={createBlank} disabled={Boolean(busy)}>＋ 空白计划</button></header>
          <div className="compact-list local-plan-list">
            {plans.map((plan) => <div className="compact-plan-row" key={plan.id}>
              <button onClick={() => router.push(`/plans/${plan.id}`)}><span><strong>{plan.document.metadata.title}</strong><small>{new Date(plan.updatedAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</small></span><b>打开</b></button>
              <button className="danger-link" aria-label={`删除 ${plan.document.metadata.title}`} onClick={async () => { if (!confirm(`删除本地计划“${plan.document.metadata.title}”？此操作不会删除它已发布的链接。`)) return; await deleteLocalPlan(plan.id); await refreshPlans(); }}>删除</button>
            </div>)}
            {!plans.length && <p className="table-empty">还没有本地计划。</p>}
          </div>
        </section>
        <section className="work-table">
          <header><h2>目录预设</h2></header>
          <div className="compact-list">
            {catalog.timelinePresets.filter((item) => item.enabled).map((preset) => <button key={preset.id} onClick={() => createFromPreset(preset.id)} disabled={Boolean(busy)}><span><strong>{preset.name}</strong></span><b>创建</b></button>)}
            {!catalog.timelinePresets.some((item) => item.enabled) && <p className="table-empty">当前目录没有启用的预设。</p>}
          </div>
        </section>
      </div>
      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}
