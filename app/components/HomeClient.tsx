"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's client runtime does not use the Next Link shim. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { applyCatalogPreset, SEED_CATALOG } from "@/lib/catalog";
import { createBlankPlan } from "@/lib/core";
import type { ApiError, CatalogRelease, LocalPlanRecord } from "@/lib/types";
import type { WclFightSummary, WclReportProbeResult } from "@/lib/wcl-report";
import {
  cacheCatalog,
  createLocalPlan,
  deleteLocalPlan,
  getCachedCatalog,
  listLocalPlans,
  requestPersistentStorage,
} from "./local-store";
import { ThemeControl } from "./ThemeControl";

function durationLabel(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function difficultyLabel(fight: WclFightSummary) {
  if (fight.difficulty === "mythic") return "史诗";
  if (fight.difficulty === "heroic") return "英雄";
  if (fight.difficulty === "normal") return "普通";
  if (fight.difficulty === "raid-finder") return "随机";
  return "未知难度";
}

export function HomeClient() {
  const router = useRouter();
  const [plans, setPlans] = useState<LocalPlanRecord[]>([]);
  const [catalog, setCatalog] = useState<CatalogRelease>(SEED_CATALOG);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [wclUrl, setWclUrl] = useState("");
  const [wclBusy, setWclBusy] = useState(false);
  const [wclError, setWclError] = useState("");
  const [wclProbe, setWclProbe] = useState<WclReportProbeResult | null>(null);
  const [selectedFightId, setSelectedFightId] = useState<number | null>(null);

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

  async function probeWclReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWclBusy(true); setWclError(""); setWclProbe(null); setSelectedFightId(null);
    try {
      const response = await fetch("/api/wcl/reports/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: wclUrl }),
      });
      const payload = await response.json() as { data?: WclReportProbeResult; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "无法读取 WCL 报告");
      const data = payload.data;
      const initialFightId = data.selectedFightId
        ?? data.fights.filter((fight) => fight.supported && fight.kill).at(-1)?.id
        ?? data.fights.find((fight) => fight.supported)?.id
        ?? data.fights[0]?.id
        ?? null;
      setWclProbe(data);
      setSelectedFightId(initialFightId);
    } catch (caught) {
      setWclError(caught instanceof Error ? caught.message : "无法读取 WCL 报告");
    } finally {
      setWclBusy(false);
    }
  }

  const selectedFight = wclProbe?.fights.find((fight) => fight.id === selectedFightId) ?? null;
  const encounterGroups = wclProbe ? Array.from(new Map(wclProbe.fights.map((fight) => [fight.encounterId, fight.encounterName])).entries()) : [];

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
        <section className="work-table wcl-probe-panel">
          <header><h2>WCL 实战参考</h2><span>公开报告 · 只读阶段探针</span></header>
          <form className="wcl-probe-form" onSubmit={probeWclReport}>
            <label>
              <span className="sr-only">Warcraft Logs 报告链接</span>
              <input
                type="url"
                value={wclUrl}
                onChange={(event) => setWclUrl(event.target.value)}
                placeholder="粘贴 cn.warcraftlogs.com/reports/..."
                required
              />
            </label>
            <button className="primary-action" type="submit" disabled={wclBusy}>{wclBusy ? "读取中…" : "读取报告"}</button>
          </form>
          {wclError && <p className="wcl-inline-error" role="alert">{wclError}</p>}
          {!wclProbe && !wclError && <p className="wcl-probe-hint">读取报告、Boss 战斗和 WCL 官方阶段划分；不会改动或创建本地轴。</p>}
          {wclProbe && <div className="wcl-probe-result">
            <div className="wcl-report-summary">
              <span><strong>{wclProbe.report.title}</strong><small>{wclProbe.report.zone?.name ?? "未知区域"} · revision {wclProbe.report.revision}</small></span>
              <label>选择战斗
                <select value={selectedFightId ?? ""} onChange={(event) => setSelectedFightId(Number(event.target.value))}>
                  {encounterGroups.map(([encounterId, encounterName]) => <optgroup key={encounterId} label={encounterName}>
                    {wclProbe.fights.filter((fight) => fight.encounterId === encounterId).map((fight) => <option key={fight.id} value={fight.id}>
                      #{fight.id} · {fight.kill ? "击杀" : "未击杀"} · {durationLabel(fight.durationMs)} · {difficultyLabel(fight)}
                    </option>)}
                  </optgroup>)}
                </select>
              </label>
            </div>
            {selectedFight && <div className="wcl-fight-preview">
              <div className="wcl-fight-heading">
                <span><strong>{selectedFight.encounterName}</strong><small>fight #{selectedFight.id} · {selectedFight.kill ? "击杀" : "未击杀"} · {durationLabel(selectedFight.durationMs)}</small></span>
                <i className={selectedFight.supported ? "supported" : "unsupported"}>{selectedFight.supported ? "可作为史诗样本" : "当前不支持转换"}</i>
              </div>
              <div className="wcl-phase-strip" aria-label="WCL 阶段时间">
                {selectedFight.phases.map((phase) => <span key={`${phase.semanticPhaseId}-${phase.occurrenceIndex}-${phase.atMs}`}>
                  <strong>P{phase.semanticPhaseId}{phase.occurrenceIndex > 1 ? ` · ${phase.occurrenceIndex}` : ""}</strong>
                  <small>{durationLabel(phase.atMs)}</small>
                </span>)}
              </div>
              <p>阶段已读取；本轮尚未采集 Boss 技能或玩家技能，也不会生成计划。</p>
            </div>}
          </div>}
        </section>
      </div>
      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}
