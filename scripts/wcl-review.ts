/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  buildWclEventReviewCatalog,
  formatReviewTime,
  type WclCompatReport,
  type WclRawEvent,
  type WclReviewCatalog,
  type WclReviewCategory,
  type WclReviewFamily,
} from "../lib/wcl-event-review.ts";

const REPORT_CODE = /^[0-9A-Za-z]{16}$/;
const DEFAULT_INPUT_ROOT = "work/wcl";

type ReviewDecision = "ignore" | "mechanic" | "pending" | "phase-signal" | "player-skill" | "validation-only";

interface DecisionRecord {
  key: string;
  decision: ReviewDecision;
  displayName: string;
  selectedEventType: string;
  descriptionOverride: string;
  notes: string;
}

interface DecisionFile {
  schemaVersion: 1;
  reportCode: string;
  updatedAt: number;
  decisions: DecisionRecord[];
}

interface DownloadState {
  schemaVersion: 1;
  reportCode: string;
  fights: Array<{
    fightId: number;
    complete: boolean;
    eventCount: number;
    pages: Array<{ file: string; eventCount: number }>;
  }>;
}

interface Options {
  reportCode: string;
  fightIds: number[];
  inputRoot: string;
  outputDir: string;
}

const EVENT_TYPE_EXPLANATIONS: Record<string, string> = {
  absorbed: "一次伤害被护盾吸收；extraAbility 只保留为关系证据，不能统一假定为伤害来源。",
  applybuff: "增益光环首次生效。",
  applybuffstack: "增益光环层数增加。",
  applydebuff: "减益光环首次生效。",
  applydebuffstack: "减益光环层数增加。",
  aurabroken: "光环被另一技能打破；字段归属会随场景变化，只作为关系证据。",
  begincast: "开始读条，通常是固定时间轴机制最优先的候选锚点。",
  cast: "施法成功或日志记录的技能触发；不保证一定对应可见读条。",
  death: "单位死亡。",
  dispel: "驱散事件。",
  encounterend: "战斗结束。",
  encounterstart: "战斗开始。",
  empowerend: "蓄力施法完成。",
  empowerstart: "蓄力施法开始。",
  heal: "一次治疗或治疗跳数。",
  interrupt: "打断事件。",
  refreshbuff: "增益光环刷新。",
  refreshdebuff: "减益光环刷新。",
  removebuff: "增益光环移除。",
  removebuffstack: "增益光环层数减少。",
  removedebuff: "减益光环移除。",
  removedebuffstack: "减益光环层数减少。",
  resourcechange: "资源变化；Boss 能量机制可能只在这里出现。",
  summon: "召唤单位。",
  damage: "一次伤害或周期伤害跳数。",
};

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write([
    "用法：pnpm wcl:review -- --report <16 位报告 ID> --fights <fight ID[,fight ID...>]",
    "",
    "可选参数：",
    `  --input-root <目录>  下载缓存根目录（默认 ${DEFAULT_INPUT_ROOT}）`,
    "  --output <目录>      人工审查输出目录（默认 work/wcl/<报告ID>/review）",
  ].join("\n"));
  process.exit(1);
}

function parsePositiveInteger(value: string, label: string) {
  if (!/^\d+$/.test(value)) usage(`${label} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) usage(`${label} 超出范围`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) usage(`无法识别参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} 缺少值`);
    values.set(argument, value);
    index += 1;
  }
  const reportCode = values.get("--report") ?? "";
  if (!REPORT_CODE.test(reportCode)) usage("--report 必须是 16 位报告 ID");
  const fightIds = values.get("--fights")?.split(",").map((value) => parsePositiveInteger(value.trim(), "--fights"));
  if (!fightIds?.length) usage("缺少 --fights");
  const inputRoot = resolve(values.get("--input-root") ?? DEFAULT_INPUT_ROOT);
  return {
    reportCode,
    fightIds: [...new Set(fightIds)].sort((left, right) => left - right),
    inputRoot,
    outputDir: resolve(values.get("--output") ?? join(inputRoot, reportCode, "review")),
  };
}

async function atomicWrite(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function writeText(path: string, text: string) {
  await atomicWrite(path, Buffer.from(text));
}

async function readGzipJson<T>(path: string) {
  return JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as T;
}

function markdownText(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function categoryLabel(category: WclReviewCategory) {
  const labels: Record<WclReviewCategory, string> = {
    enemy: "敌方技能与机制候选",
    player: "玩家关键技能候选",
    system: "战斗与阶段系统事件",
    unknown: "来源不明但可能相关",
    excluded: "默认排除事件",
  };
  return labels[category];
}

function decisionLabel(value: ReviewDecision) {
  const labels: Record<ReviewDecision, string> = {
    ignore: "忽略",
    mechanic: "记录为机制",
    pending: "待确认",
    "phase-signal": "阶段信号",
    "player-skill": "记录为玩家技能",
    "validation-only": "仅验证",
  };
  return labels[value];
}

function observedTargetSummary(family: WclReviewFamily, maximumNamedTargets: number) {
  const namedTargets = [...new Set(
    family.observedTargets
      .filter((target) => !["friendly-player", "friendly-pet"].includes(target.affiliation))
      .map((target) => target.name),
  )];
  const friendlyPlayers = family.observedTargets.filter((target) => target.affiliation === "friendly-player").length;
  const friendlyPets = family.observedTargets.filter((target) => target.affiliation === "friendly-pet").length;
  const parts = namedTargets.slice(0, maximumNamedTargets);
  if (namedTargets.length > maximumNamedTargets) parts.push(`其他 ${namedTargets.length - maximumNamedTargets} 类`);
  if (friendlyPlayers > 0) parts.push(`玩家 ${friendlyPlayers} 人`);
  if (friendlyPets > 0) parts.push(`玩家宠物 ${friendlyPets} 个`);
  return parts.join("、");
}

function familyHeading(family: WclReviewFamily, index: number) {
  const ability = family.abilityId === null ? "无技能 ID" : `spell ${family.abilityId}`;
  return `## ${String(index + 1).padStart(4, "0")} · ${family.abilityName} · ${ability}`;
}

function compactWaveTimes(family: WclReviewFamily) {
  const lines: string[] = [];
  for (const eventType of family.eventTypes) {
    lines.push(`- \`${eventType.type}\`：原始 ${eventType.rawEventCount.toLocaleString()} 条。${EVENT_TYPE_EXPLANATIONS[eventType.type] ?? ""}`);
    for (const fight of eventType.fights) {
      const waveTimes = fight.waves.map((wave) => `${formatReviewTime(wave.atMs)}${wave.eventCount > 1 ? `×${wave.eventCount}` : ""}`);
      if (waveTimes.length <= 40) {
        lines.push(`  - fight ${fight.fightId}：${waveTimes.join("、") || "无"}`);
      } else {
        const episodeSummary = fight.episodes.map((episode) => {
          const range = episode.startMs === episode.endMs
            ? formatReviewTime(episode.startMs)
            : `${formatReviewTime(episode.startMs)}–${formatReviewTime(episode.endMs)}`;
          const interval = episode.medianIntervalMs === null ? "" : `，中位间隔 ${(episode.medianIntervalMs / 1_000).toFixed(3)}s`;
          return `${range}（${episode.waveCount} 波/${episode.eventCount} 条${interval}）`;
        });
        lines.push(`  - fight ${fight.fightId}：${episodeSummary.join("；")}`);
        lines.push("  - 完整逐波时间见 `event-catalog.json.gz`。 ");
      }
    }
  }
  return lines.join("\n");
}

function familySection(family: WclReviewFamily, index: number, decision: DecisionRecord) {
  const lookup = family.abilityId === null ? "" : `[Wowhead 正式服查询](https://www.wowhead.com/cn/spell=${family.abilityId})`;
  const targets = observedTargetSummary(family, 12);
  const timing = family.crossFightTiming.comparableFightCount < 2
    ? "样本不足"
    : `${family.crossFightTiming.comparableFightCount} 场可比较，公共序列 ${family.crossFightTiming.commonOccurrenceCount} 次，中位漂移 ${family.crossFightTiming.medianDriftMs ?? "—"}ms，最大漂移 ${family.crossFightTiming.maxDriftMs ?? "—"}ms${family.crossFightTiming.stableWithinThreeSeconds ? "；≤3 秒稳定" : ""}`;
  return [
    familyHeading(family, index),
    "",
    `- 稳定键：\`${family.key}\``,
    `- 来源：${family.source.name}（${family.sourceActorCount} 个来源 actor：${family.observedActorIds.join(", ") || "?"}；代表 game ID ${family.source.gameId ?? "?"}，${family.source.affiliation}）`,
    `- 观察目标：${targets}`,
    `- 分类：${categoryLabel(family.category)}；原始 ${family.rawEventCount.toLocaleString()} 条；出现于 fight ${family.fightsSeen.join(" / ")}`,
    `- 简要说明：${decision.descriptionOverride || family.description || ""}`,
    `- 资料入口：${lookup}`,
    `- 自动建议锚点：${family.suggestedAnchorEvent ?? "无"}（只供人工选择）`,
    `- 跨场时间：${timing}`,
    `- 关联技能 ID：${family.relatedAbilityIds.join(", ")}`,
    `- 当前决定：**${decisionLabel(decision.decision)}**；选定事件：${decision.selectedEventType || ""}`,
    `- 人工备注：${decision.notes}`,
    "",
    compactWaveTimes(family),
    "",
    "待确认：是否记录、语义名称、采用哪个事件、是施法开始/命中/光环、是否仅用于阶段或验证，以及如何去重。请在 `event-decisions.json` 中填写，或直接在对话中告诉我。",
    "",
  ].join("\n");
}

function overviewMarkdown(catalog: WclReviewCatalog) {
  return [
    "# Vashnik WCL 事件人工审查",
    "",
    `报告：\`${catalog.reportCode}\` · ${catalog.reportTitle}`,
    "",
    "> 这是本地开发材料，不应提交到公开仓库。原始分页、玩家姓名和逐波数据均留在被 Git 忽略的 `work/` 目录。",
    "",
    "## 审查口径",
    "",
    "- 每个稳定事件族只列一次；同技能的不同事件类型和所选战斗出现情况放在同一项下。",
    "- 对同一时刻作用于多名玩家的伤害/光环，合并成一波并保留原始条数与目标数。",
    "- 玩家对敌方的伤害、逐次治疗量、宠物噪声等不会进入机制候选，但仍完整列入排除索引。",
    "- 每个候选的完整逐波时间保存在 `event-catalog.json.gz`，完整原始事件仍在各分页中，可随时回查。",
    "- 自动锚点和稳定性只用于辅助审查，不会自动生成正式规则。",
    "- 简述优先来自 `docs/Vashink.md` 与正式服资料；没有可靠说明的项目保持空白。",
    "",
    "## 当前资料差异",
    "",
    "- 是否存在官方 `phaseTransitions` 必须按所选正式服 fight 元数据逐场确认；缺失时不猜测阶段。",
    "- 正式服名称已按 spell ID 区分：Living Venom 抵达中央后的 `Malignant Burst` 为“恶性爆发”，Malignant Tumor 的 `Malignance` 为“恶念”；两者是独立机制。",
    "- `absorbed` 与 `aurabroken` 的字段语义并不统一，只能作为关联证据，不能单独据此认定机制来源。",
    "",
    "## 数据量",
    "",
    `- 原始事件：${catalog.summary.rawEventCount.toLocaleString()} 条`,
    `- 稳定事件族：${catalog.summary.familyCount.toLocaleString()} 个`,
    `- 待审查候选：${catalog.summary.candidateFamilyCount.toLocaleString()} 个`,
    `- 默认排除：${catalog.summary.excludedFamilyCount.toLocaleString()} 个`,
    ...catalog.fights.map((fight) => `- fight ${fight.id}：${formatReviewTime(fight.durationMs)}，${fight.kill ? "击杀" : `未击杀（Boss ${fight.bossPercentage ?? "?"}%）`}，${fight.rawEventCount.toLocaleString()} 条`),
    "",
    "## 文件",
    "",
    "- `00-enemy-checklist.md`：一页式敌方、系统和来源不明事件确认清单。",
    "- `01-enemy-system.md`：敌方、系统和来源不明的机制候选。",
    "- `02-player.md`：玩家施法/光环候选，后续从中确认个人减伤和治疗大技能。",
    "- `03-excluded.md`：所有默认排除事件族及排除理由。",
    "- `event-decisions.json`：人工决定的唯一可编辑文件，重复生成时会保留已有填写。",
    "- `event-catalog.json.gz`：完整聚合数据与逐波时间。",
    "",
  ].join("\n");
}

function excludedMarkdown(catalog: WclReviewCatalog) {
  const families = catalog.families.filter((family) => family.category === "excluded");
  const lines = [
    "# 默认排除事件完整索引",
    "",
    "这些事件没有从原始缓存中删除，只是不进入第一轮机制候选。确认某项有用时，可以在决定文件中改为相应类别并重新分析。",
    "",
    "| # | 技能 | ID | 来源 | 事件类型 | 原始条数 | 排除理由 |",
    "| ---: | --- | ---: | --- | --- | ---: | --- |",
  ];
  families.forEach((family, index) => {
    lines.push(`| ${index + 1} | ${markdownText(family.abilityName)} | ${family.abilityId ?? ""} | ${markdownText(family.source.name)} | ${family.eventTypes.map((item) => item.type).join(", ")} | ${family.rawEventCount} | ${markdownText(family.excludedReason ?? "")} |`);
  });
  lines.push("");
  return lines.join("\n");
}

function enemyChecklistMarkdown(families: WclReviewFamily[], decisions: Map<string, DecisionRecord>) {
  const lines = [
    "# 敌方、系统与未知事件确认清单",
    "",
    "这是一页式确认入口；序号与 `01-enemy-system.md` 的详细条目一致。说明留空表示现有资料不足，不会自动补写推测。",
    "",
    "| # | 技能 / 事件 | ID | 来源 | 观察目标 | 类型（原始条数） | fight | 简要说明 | 当前决定 |",
    "| ---: | --- | ---: | --- | --- | --- | --- | --- | --- |",
  ];
  families.forEach((family, index) => {
    const decision = decisions.get(family.key);
    const eventTypes = family.eventTypes.map((item) => `${item.type} ${item.rawEventCount.toLocaleString()}`).join(", ");
    const targetSummary = observedTargetSummary(family, 4);
    lines.push([
      `| ${index + 1}`,
      markdownText(family.abilityName),
      family.abilityId ?? "",
      markdownText(family.source.name),
      markdownText(targetSummary),
      markdownText(eventTypes),
      family.fightsSeen.join(" / "),
      markdownText(decision?.descriptionOverride || family.description || ""),
      decisionLabel(decision?.decision ?? "pending"),
    ].join(" | ") + " |");
  });
  lines.push("");
  return lines.join("\n");
}

async function readDecisions(path: string, reportCode: string, families: WclReviewFamily[]): Promise<DecisionFile> {
  let previous: DecisionFile | null = null;
  if (existsSync(path)) {
    try {
      previous = JSON.parse(await readFile(path, "utf8")) as DecisionFile;
    } catch {
      throw new Error("event-decisions.json 无法解析；为避免覆盖人工决定，已停止生成");
    }
    if (previous.schemaVersion !== 1 || previous.reportCode !== reportCode || !Array.isArray(previous.decisions)) {
      throw new Error("event-decisions.json 结构或报告 ID 不匹配；为避免覆盖人工决定，已停止生成");
    }
  }
  const previousByKey = new Map(previous?.decisions.map((item) => [item.key, item]));
  return {
    schemaVersion: 1,
    reportCode,
    updatedAt: Date.now(),
    decisions: families.map((family) => previousByKey.get(family.key) ?? {
      key: family.key,
      decision: "pending",
      displayName: family.abilityName,
      selectedEventType: "",
      descriptionOverride: "",
      notes: "",
    }),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const reportDir = join(options.inputRoot, options.reportCode);
  const state = JSON.parse(await readFile(join(reportDir, "download-state.json"), "utf8")) as DownloadState;
  if (state.schemaVersion !== 1 || state.reportCode !== options.reportCode || !Array.isArray(state.fights)) {
    throw new Error("下载状态无效");
  }
  const selectedStates = options.fightIds.map((fightId) => {
    const fight = state.fights.find((candidate) => candidate.fightId === fightId);
    if (!fight) throw new Error(`下载状态中没有 fight ${fightId}`);
    if (!fight.complete) throw new Error(`fight ${fightId} 尚未完整下载`);
    return fight;
  });
  const report = await readGzipJson<WclCompatReport>(join(reportDir, "report.json.gz"));
  const expectedEventCount = selectedStates.reduce((sum, fight) => sum + fight.eventCount, 0);
  process.stdout.write(`逐页聚合 ${expectedEventCount.toLocaleString()} 条事件\n`);
  function* events(): Generator<WclRawEvent> {
    for (const fight of selectedStates) {
      process.stdout.write(`读取 fight ${fight.fightId}：${fight.pages.length} 页，${fight.eventCount.toLocaleString()} 条\n`);
      for (const page of fight.pages) {
        const payload = JSON.parse(gunzipSync(readFileSync(join(reportDir, page.file))).toString("utf8")) as { events?: WclRawEvent[] };
        if (!Array.isArray(payload.events)) throw new Error(`${page.file} 缺少 events`);
        yield* payload.events;
      }
    }
  }
  const catalog = buildWclEventReviewCatalog({
    reportCode: options.reportCode,
    report,
    fightIds: options.fightIds,
    events: events(),
  });
  await mkdir(options.outputDir, { recursive: true });
  const decisionsPath = join(options.outputDir, "event-decisions.json");
  const decisions = await readDecisions(decisionsPath, options.reportCode, catalog.families);
  const decisionByKey = new Map(decisions.decisions.map((item) => [item.key, item]));

  const enemySystem = catalog.families.filter((family) => ["enemy", "system", "unknown"].includes(family.category));
  const player = catalog.families.filter((family) => family.category === "player");
  const renderSections = (title: string, values: WclReviewFamily[]) => [
    `# ${title}`,
    "",
    `共 ${values.length} 个事件族。说明为空表示尚未从现有资料中可靠确认。`,
    "",
    ...values.map((family, index) => familySection(family, index, decisionByKey.get(family.key)!)),
  ].join("\n");

  await Promise.all([
    writeText(join(options.outputDir, "README.md"), `${overviewMarkdown(catalog)}\n`),
    writeText(join(options.outputDir, "00-enemy-checklist.md"), `${enemyChecklistMarkdown(enemySystem, decisionByKey)}\n`),
    writeText(join(options.outputDir, "01-enemy-system.md"), `${renderSections("敌方、系统与未知事件", enemySystem)}\n`),
    writeText(join(options.outputDir, "02-player.md"), `${renderSections("玩家关键技能候选", player)}\n`),
    writeText(join(options.outputDir, "03-excluded.md"), `${excludedMarkdown(catalog)}\n`),
    writeText(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`),
    atomicWrite(join(options.outputDir, "event-catalog.json.gz"), gzipSync(Buffer.from(JSON.stringify(catalog)), { level: 9 })),
  ]);
  process.stdout.write([
    `完成：${catalog.summary.familyCount.toLocaleString()} 个事件族`,
    `敌方/系统/未知：${enemySystem.length.toLocaleString()}`,
    `玩家候选：${player.length.toLocaleString()}`,
    `默认排除：${catalog.summary.excludedFamilyCount.toLocaleString()}`,
    `审查入口：${join(options.outputDir, "README.md")}`,
  ].join("\n") + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
