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

function exampleMechanic(id: string, name: string, description: string, atMs: number): RaidMechanic {
  return {
    id, name, description,
    atMs, castTimeMs: 0, durationMs: 0,
    damage: { school: "magic", directAmount: null, periodicAmount: null, periodicIntervalMs: null, tickOnStart: false },
    targets: structuredClone(ALL_TARGETS), severity: "warning", source: "preset", note: "",
  };
}

export function createBasicMechanicsPreset(): RaidPlanPreset {
  const document = createBlankPlan("基础机制示例", "preset-phase-p1");
  document.encounter = { name: "基础机制示例", difficulty: "练习", durationMs: 120_000 };
  document.phases = [{ id: "preset-phase-p1", name: "P1", atMs: 0 }, { id: "preset-phase-p2", name: "P2", atMs: 60_000 }];
  document.mechanics = [
    exampleMechanic("preset-mechanic-stack", "集合", "全团在标记位置集合。", 15_000),
    exampleMechanic("preset-mechanic-spread", "分散", "队员彼此拉开距离，避免范围重叠。", 35_000),
    exampleMechanic("preset-mechanic-transition", "转阶段", "停止输出并处理场地或转火目标。", 60_000),
    exampleMechanic("preset-mechanic-soak", "分组站位", "按预先安排的队伍进入各自区域。", 85_000),
  ];
  return { id: "builtin-basic-mechanics-v1", name: "基础机制示例", description: "集合、分散、转阶段与分组站位的简洁时间轴。", kind: "built-in", createdAt: 0, document };
}

export const BUILT_IN_PRESETS = [createBasicMechanicsPreset()];

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
