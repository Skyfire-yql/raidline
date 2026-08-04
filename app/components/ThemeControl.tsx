"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
const THEME_KEY = "raidline:theme";

function applyTheme(mode: ThemeMode) {
  const dark = mode === "dark" || mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<ThemeMode>("system");
  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY);
    const initial: ThemeMode = stored === "light" || stored === "dark" ? stored : "system";
    applyTheme(initial);
    queueMicrotask(() => setMode(initial));
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => { if ((localStorage.getItem(THEME_KEY) ?? "system") === "system") applyTheme("system"); };
    media.addEventListener("change", onSystemChange);
    return () => media.removeEventListener("change", onSystemChange);
  }, []);

  function change(next: ThemeMode) {
    setMode(next);
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  return (
    <label className={`theme-control ${compact ? "compact" : ""}`}>
      {!compact && <span>主题</span>}
      <select aria-label="界面主题" value={mode} onChange={(event) => change(event.target.value as ThemeMode)}>
        <option value="system">跟随系统</option>
        <option value="light">亮色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
