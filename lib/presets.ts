import { ALL_TARGETS, createBlankPlan, makeId, normalizePlanDocument } from "./core.ts";
import type { RaidMechanic, RaidPlanDocument } from "./types.ts";

export interface RaidPlanPreset {
  id: string;
  name: string;
  description: string;
  kind: "built-in" | "personal";
  createdAt: number;
  document: RaidPlanDocument;
}

function exampleMechanic(name: string, atMs: number, directAmount: number): RaidMechanic {
  return {
    id: makeId("preset-mechanic"), name, description: "用于验证相邻机制压力的示例数据。",
    atMs, castTimeMs: 0, durationMs: 0,
    damage: { school: "magic", directAmount, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false },
    targets: structuredClone(ALL_TARGETS), severity: "danger", source: "preset", note: "",
  };
}

export function createPressureExamplePreset(): RaidPlanPreset {
  const document = createBlankPlan("连续 AoE 压力示例");
  document.encounter = { name: "连续 AoE 压力示例", difficulty: "练习", durationMs: 90_000 };
  document.phases = [{ id: "preset-phase-p1", name: "P1", atMs: 0 }];
  document.mechanics = [
    exampleMechanic("AoE 1 · 50万", 10_000, 500_000),
    exampleMechanic("AoE 2 · 60万", 18_000, 600_000),
    exampleMechanic("AoE 3 · 80万", 26_000, 800_000),
    exampleMechanic("AoE 4 · 30万", 34_000, 300_000),
    {
      ...exampleMechanic("持续灼烧", 55_000, 100_000),
      durationMs: 6000,
      damage: { school: "magic", directAmount: 100_000, periodicAmount: 100_000, periodicIntervalMs: 2000, tickOnStart: false },
      description: "直接伤害后每 2 秒跳伤，演示持续总量和平均 DPS。",
    },
  ];
  return { id: "builtin-pressure-example-v1", name: "连续 AoE 压力示例", description: "50/60/80/30 万相邻压力与持续跳伤示例，不代表任何真实 Boss。", kind: "built-in", createdAt: 0, document };
}

export const BUILT_IN_PRESETS = [createPressureExamplePreset()];

export function applyBuiltInPreset(current: RaidPlanDocument, preset: RaidPlanPreset) {
  const source = normalizePlanDocument(preset.document);
  return normalizePlanDocument({
    ...current,
    encounter: structuredClone(source.encounter),
    phases: structuredClone(source.phases),
    mechanics: structuredClone(source.mechanics),
    assignments: [],
  });
}

export function createPersonalPreset(name: string, document: RaidPlanDocument): RaidPlanPreset {
  return { id: makeId("personal-preset"), name: name.trim().slice(0, 80) || "未命名预设", description: "当前设备保存的完整计划", kind: "personal", createdAt: Date.now(), document: normalizePlanDocument(document) };
}

export function parsePresetJson(value: string) {
  const parsed = JSON.parse(value) as Partial<RaidPlanPreset>;
  if (!parsed || typeof parsed !== "object" || !parsed.document) throw new Error("预设 JSON 缺少计划内容");
  return {
    id: typeof parsed.id === "string" ? parsed.id : makeId("personal-preset"),
    name: typeof parsed.name === "string" ? parsed.name.slice(0, 80) : "导入的预设",
    description: typeof parsed.description === "string" ? parsed.description : "从 JSON 导入",
    kind: "personal" as const,
    createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : Date.now(),
    document: normalizePlanDocument(parsed.document),
  };
}

export function stringifyPreset(preset: RaidPlanPreset) {
  return JSON.stringify({ ...preset, kind: "personal", document: normalizePlanDocument(preset.document) }, null, 2);
}
