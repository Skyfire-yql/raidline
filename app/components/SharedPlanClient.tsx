"use client";

import { useEffect, useMemo, useState } from "react";
import { detectConflicts, exportMrtNote, formatTime } from "@/lib/core";
import type { ApiError, StoredPlan } from "@/lib/types";

export function SharedPlanClient({ shareSlug }: { shareSlug: string }) {
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch(`/api/shared/${shareSlug}`).then(async (response) => {
      const payload = (await response.json()) as { data?: StoredPlan; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "读取计划失败");
      setStored(payload.data);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "读取计划失败"));
  }, [shareSlug]);

  const plan = stored?.document ?? null;
  const warnings = useMemo(() => plan ? detectConflicts(plan) : [], [plan]);

  if (error) return <main className="state-page"><div className="state-card"><span className="brand-mark">轴</span><p className="eyebrow">READ-ONLY PLAN</p><h1>这条分享链接不可用</h1><p>{error}</p><a className="button button-gold" href="/">回到首页</a></div></main>;
  if (!plan || !stored) return <main className="state-page"><div className="loading-sigil"><span>轴</span><i /></div><p>正在读取只读排轴…</p></main>;

  const mechanics = [...plan.mechanics].sort((a, b) => a.atMs - b.atMs);
  return (
    <main className="shared-shell">
      <header className="shared-header">
        <a className="brand compact" href="/"><span className="brand-mark">轴</span><span><strong>团轴</strong><small>RAIDLINE</small></span></a>
        <span className="readonly-pill"><i />只读分享</span>
        <div><button onClick={async () => { await navigator.clipboard.writeText(exportMrtNote(plan)); setToast("MRT 文本已复制"); }}>复制 MRT 文本</button><a href="/">创建自己的排轴</a></div>
      </header>
      <section className="shared-hero">
        <div><p className="eyebrow">RAID PLAN / {plan.encounter.difficulty.toUpperCase()}</p><h1>{plan.encounter.name}</h1><p>更新于 {new Date(stored.updatedAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</p></div>
        <div className="shared-stats"><span><b>{formatTime(plan.encounter.durationMs)}</b><small>预计时长</small></span><span><b>{plan.roster.length}</b><small>团队成员</small></span><span><b>{plan.assignments.length}</b><small>技能分配</small></span><span className={warnings.length ? "warn" : "ok"}><b>{warnings.length}</b><small>冲突提醒</small></span></div>
      </section>
      <section className="shared-content">
        <aside className="shared-roster"><p className="eyebrow">ROSTER</p><h2>团队成员</h2>{plan.roster.map((member) => <div key={member.id}><i style={{ background: member.color }} /><span><strong>{member.name}</strong><small>{member.specSlug}</small></span><b>{member.role === "tank" ? "坦克" : member.role === "healer" ? "治疗" : "输出"}</b></div>)}</aside>
        <div className="shared-axis"><div className="shared-axis-head"><p className="eyebrow">TIMELINE</p><h2>战斗时间线</h2><span>{mechanics.length} 个机制</span></div>{mechanics.map((mechanic) => { const assignments = plan.assignments.filter((item) => item.mechanicId === mechanic.id || Math.abs(item.atMs - mechanic.atMs) < 1000); return <article className={`shared-event severity-${mechanic.severity}`} key={mechanic.id}><time>{formatTime(mechanic.atMs)}</time><i /><div><span><strong>{mechanic.name}</strong>{mechanic.note && <small>{mechanic.note}</small>}</span>{assignments.length ? <div className="shared-assignments">{assignments.map((assignment) => { const member = plan.roster.find((item) => item.id === assignment.memberId); const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId); return member && cooldown ? <span key={assignment.id} style={{ borderColor: cooldown.color }}><i style={{ background: member.color }} /><b>{member.name}</b> · {cooldown.name}</span> : null; })}</div> : <small className="unassigned">尚未安排团队技能</small>}</div></article>; })}{!mechanics.length && <div className="shared-empty">这份计划还没有 Boss 机制。</div>}<div className="free-assignments"><h3>自由时间点</h3>{plan.assignments.filter((item) => !item.mechanicId && !mechanics.some((mechanic) => Math.abs(item.atMs - mechanic.atMs) < 1000)).sort((a, b) => a.atMs - b.atMs).map((assignment) => { const member = plan.roster.find((item) => item.id === assignment.memberId); const cooldown = plan.cooldowns.find((item) => item.id === assignment.cooldownId); return member && cooldown ? <div key={assignment.id}><time>{formatTime(assignment.atMs)}</time><span><b>{member.name}</b> — {cooldown.name}</span></div> : null; })}</div></div>
      </section>
      <footer className="shared-footer"><span>团轴 RAIDLINE</span><p>只读计划 · 任何修改都不会在此页面发生</p></footer>
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast("")}>×</button></div>}
    </main>
  );
}
