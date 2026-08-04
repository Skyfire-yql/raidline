"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface RecentPlan {
  id: string;
  title: string;
  updatedAt: number;
}

interface CreateResponse {
  data?: { id: string; editToken: string };
  error?: { message: string };
}

const RECENT_KEY = "raidline:recent";

export function HomeClient() {
  const router = useRouter();
  const [recent, setRecent] = useState<RecentPlan[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"blank" | "wcl" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 6));
    } catch {
      setRecent([]);
    }
  }, []);

  async function createPlan(mode: "blank" | "wcl") {
    if (mode === "wcl" && !source.trim()) {
      setError("先粘贴一条 WCL 战报链接或报告代码");
      return;
    }
    setBusy(mode);
    setError("");
    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: mode === "wcl" ? "正在导入 WCL…" : "新建团本排轴" }),
      });
      const payload = (await response.json()) as CreateResponse;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "创建失败");
      const query = mode === "wcl" ? `?wcl=${encodeURIComponent(source.trim())}` : "";
      router.push(`/plans/${payload.data.id}${query}#key=${encodeURIComponent(payload.data.editToken)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败，请稍后再试");
      setBusy(null);
    }
  }

  return (
    <main className="home-shell">
      <nav className="home-nav" aria-label="主导航">
        <a className="brand" href="/" aria-label="团轴 Raidline 首页">
          <span className="brand-mark">轴</span>
          <span><strong>团轴</strong><small>RAIDLINE</small></span>
        </a>
        <span className="privacy-pill"><i /> 私有工作台</span>
      </nav>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow"><span>PERSONAL RAID PLANNER</span><b>个人团本排轴</b></p>
          <h1>把每一次减伤，<br /><em>放在正确的秒数。</em></h1>
          <p className="hero-lead">Boss 机制、团队成员和关键技能放进同一条时间线。少一点口头确认，多一点稳定过本。</p>
          <div className="hero-actions">
            <button className="button button-gold" onClick={() => createPlan("blank")} disabled={busy !== null}>
              <span>＋</span>{busy === "blank" ? "正在创建…" : "创建空白排轴"}
            </button>
            <a className="text-link" href="#wcl-import">从 WCL 开始 <span>↓</span></a>
          </div>
          <div className="trust-row">
            <span><b>1s</b> 精准吸附</span>
            <span><b>50</b> 步撤销</span>
            <span><b>MRT</b> 一键导出</span>
          </div>
        </div>

        <div className="hero-preview" aria-label="排轴界面预览">
          <div className="preview-topbar">
            <span className="preview-boss"><i /> 虚空编织者 · 史诗</span>
            <span className="preview-status">已保存</span>
          </div>
          <div className="preview-ruler"><span>00:00</span><span>00:30</span><span>01:00</span><span>01:30</span><span>02:00</span></div>
          <div className="preview-mechanics">
            <span style={{ left: "18%" }}><i />暗影坍缩</span>
            <span style={{ left: "48%" }}><i />虚空洪流</span>
            <span style={{ left: "78%" }}><i />寂灭脉冲</span>
          </div>
          {[
            ["沐光", "牧师", "真言术：障", "17%", "#f1f1f1"],
            ["山岚", "萨满", "灵魂链接", "47%", "#2787ff"],
            ["烬歌", "战士", "集结呐喊", "76%", "#c69b6d"],
          ].map(([name, role, spell, left, color]) => (
            <div className="preview-row" key={name}>
              <div><i style={{ background: color }} /><strong>{name}</strong><small>{role}</small></div>
              <div className="preview-track"><span style={{ left, borderColor: color }}>{spell}</span></div>
            </div>
          ))}
          <div className="preview-footer"><span>冲突 0</span><b>这条轴，可以直接开打。</b></div>
        </div>
      </section>

      <section className="home-lower" id="wcl-import">
        <div className="import-card">
          <div className="section-number">01</div>
          <div className="import-copy">
            <p className="eyebrow">WCL IMPORT</p>
            <h2>从真实战斗里，<br />找到你的下一条轴。</h2>
            <p>粘贴公开 WCL 战报。我们会列出场次、Boss 施法和已使用的团队技能，再由你决定哪些进入时间线。</p>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); createPlan("wcl"); }} className="import-form">
            <label htmlFor="wcl-source">公开战报链接 / 报告代码</label>
            <div>
              <input id="wcl-source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="warcraftlogs.com/reports/…" autoComplete="off" />
              <button className="button button-gold" type="submit" disabled={busy !== null}>{busy === "wcl" ? "读取中…" : "分析战报"}</button>
            </div>
            <small>只读取公开战报 · 凭据不会发送到浏览器</small>
          </form>
        </div>

        <aside className="recent-card">
          <div className="section-number">02</div>
          <p className="eyebrow">RECENT PLANS</p>
          <h2>继续上次排轴</h2>
          {recent.length ? (
            <div className="recent-list">
              {recent.map((plan) => (
                <button key={plan.id} onClick={() => router.push(`/plans/${plan.id}`)}>
                  <span><strong>{plan.title}</strong><small>{new Date(plan.updatedAt).toLocaleDateString("zh-CN")}</small></span>
                  <b>→</b>
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-empty"><span>⌁</span><p>还没有最近计划<br /><small>创建后会只在这台设备留下入口</small></p></div>
          )}
        </aside>
      </section>

      {error && <div className="toast toast-error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭">×</button></div>}
      <footer className="home-footer"><span>团轴 RAIDLINE</span><p>为认真开荒的团队而做。</p><small>非暴雪官方产品</small></footer>
    </main>
  );
}
