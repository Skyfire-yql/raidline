/// <reference types="node" />

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { WclCompatFight, WclCompatReport, WclRawEvent } from "../lib/wcl-event-review.ts";

const REPORT_CODE = /^[0-9A-Za-z]{16}$/;
const DEFAULT_BASE_URL = "https://wowanalyzer.com/i/v1/report";
const DEFAULT_OUTPUT_ROOT = "work/wcl";
const DEFAULT_DELAY_MS = 1_500;
const DEFAULT_RETRIES = 7;

class NonRetryableHttpError extends Error {}

interface Options {
  reportCode: string;
  fightIds: number[];
  outputRoot: string;
  baseUrl: string;
  delayMs: number;
  retries: number;
  refreshReport: boolean;
}

interface EventPage {
  events: WclRawEvent[];
  nextPageTimestamp?: number | null;
  count?: number;
}

interface StoredPage {
  index: number;
  file: string;
  requestStart: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  nextPageTimestamp: number | null;
  eventCount: number;
  compressedBytes: number;
  sha256: string;
}

interface FightState {
  fightId: number;
  fightName: string;
  startReportMs: number;
  endReportMs: number;
  complete: boolean;
  eventCount: number;
  pages: StoredPage[];
}

interface DownloadState {
  schemaVersion: 1;
  source: "wowanalyzer-compat";
  reportCode: string;
  baseUrl: string;
  updatedAt: number;
  fights: FightState[];
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write([
    "用法：pnpm wcl:download -- --report <WCL链接或16位报告ID> --fights 26,28,29,31,32",
    "",
    "可选参数：",
    `  --output-root <目录>   原始缓存目录（默认 ${DEFAULT_OUTPUT_ROOT}）`,
    `  --delay-ms <毫秒>      成功分页之间的等待（默认 ${DEFAULT_DELAY_MS}）`,
    `  --retries <次数>       429/5xx 最大重试（默认 ${DEFAULT_RETRIES}）`,
    "  --refresh-report       重新读取报告元数据；不会删除已下载事件页",
    "  --base-url <HTTPS地址> 仅用于替换兼容测试源",
  ].join("\n"));
  process.exit(1);
}

function readInteger(value: string | undefined, label: string, minimum = 0) {
  if (!value || !/^\d+$/.test(value)) usage(`${label} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) usage(`${label} 超出范围`);
  return parsed;
}

function reportCodeFrom(value: string | undefined) {
  if (!value) usage("缺少 --report");
  if (REPORT_CODE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    usage("--report 不是有效的 WCL 链接或报告 ID");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const code = segments[0] === "reports" ? segments[1] : "";
  if (url.protocol !== "https:" || !/(^|\.)warcraftlogs\.com$/i.test(url.hostname) || !REPORT_CODE.test(code)) {
    usage("--report 不是有效的 WCL 报告链接");
  }
  return code;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--refresh-report") {
      flags.add(argument);
      continue;
    }
    if (!argument.startsWith("--")) usage(`无法识别参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} 缺少值`);
    values.set(argument, value);
    index += 1;
  }
  const fights = values.get("--fights")?.split(",").map((value) => readInteger(value.trim(), "--fights", 1));
  if (!fights?.length) usage("缺少 --fights");
  const baseUrl = values.get("--base-url") ?? DEFAULT_BASE_URL;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    usage("--base-url 无效");
  }
  const isLocalHttp = parsedBaseUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsedBaseUrl.hostname);
  if (parsedBaseUrl.protocol !== "https:" && !isLocalHttp) {
    usage("--base-url 必须使用 HTTPS；只有 localhost 可以使用 HTTP");
  }
  return {
    reportCode: reportCodeFrom(values.get("--report")),
    fightIds: [...new Set(fights)].sort((left, right) => left - right),
    outputRoot: resolve(values.get("--output-root") ?? DEFAULT_OUTPUT_ROOT),
    baseUrl: baseUrl.replace(/\/$/, ""),
    delayMs: readInteger(values.get("--delay-ms") ?? String(DEFAULT_DELAY_MS), "--delay-ms"),
    retries: readInteger(values.get("--retries") ?? String(DEFAULT_RETRIES), "--retries", 1),
    refreshReport: flags.has("--refresh-report"),
  };
}

function sleep(durationMs: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

function retryAfterMs(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(120_000, retryAfter * 1_000);
  return Math.min(60_000, 2_000 * 2 ** attempt);
}

async function requestText(url: string, retries: number) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Raidline-local-WCL-research/1" },
        signal: controller.signal,
      });
      if (response.ok) return await response.text();
      if (response.status !== 429 && response.status < 500) {
        throw new NonRetryableHttpError(`请求失败：HTTP ${response.status}`);
      }
      const delay = retryAfterMs(response, attempt);
      process.stdout.write(`  来源暂时不可用（HTTP ${response.status}），${Math.ceil(delay / 1_000)} 秒后重试\n`);
      await sleep(delay);
    } catch (error) {
      if (error instanceof NonRetryableHttpError) throw error;
      if (attempt === retries - 1) throw error;
      const delay = Math.min(60_000, 2_000 * 2 ** attempt);
      process.stdout.write(`  网络请求中断，${Math.ceil(delay / 1_000)} 秒后重试\n`);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("超过最大重试次数");
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function validateReport(value: unknown): asserts value is WclCompatReport {
  if (!value || typeof value !== "object" || !Array.isArray((value as WclCompatReport).fights)) {
    throw new Error("报告元数据缺少 fights");
  }
}

function validatePage(value: unknown, fight: WclCompatFight): asserts value is EventPage {
  const page = value as EventPage;
  if (!page || typeof page !== "object" || !Array.isArray(page.events)) throw new Error("事件分页结构无效");
  for (const event of page.events) {
    if (!event || typeof event !== "object" || !Number.isFinite(event.timestamp) || typeof event.type !== "string") {
      throw new Error("事件分页包含无效事件");
    }
    if (event.timestamp < fight.start_time || event.timestamp > fight.end_time + 1_000) {
      throw new Error(`事件时间 ${event.timestamp} 超出 fight ${fight.id} 范围`);
    }
  }
  if (page.nextPageTimestamp != null && (!Number.isFinite(page.nextPageTimestamp) || page.nextPageTimestamp <= fight.start_time)) {
    throw new Error("nextPageTimestamp 无效");
  }
}

async function atomicWrite(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function writeGzipJson(path: string, text: string) {
  const compressed = gzipSync(Buffer.from(text), { level: 9 });
  await atomicWrite(path, compressed);
  return compressed;
}

async function readGzipJson<T>(path: string, label: string) {
  return parseJson<T>(gunzipSync(await readFile(path)).toString("utf8"), label);
}

async function writeState(path: string, state: DownloadState) {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
}

function relativePagePath(fightId: number, pageIndex: number) {
  return `fights/${fightId}/pages/${String(pageIndex).padStart(6, "0")}.json.gz`;
}

async function loadExistingFightState(reportDir: string, fight: WclCompatFight): Promise<FightState> {
  const state: FightState = {
    fightId: fight.id,
    fightName: fight.name,
    startReportMs: fight.start_time,
    endReportMs: fight.end_time,
    complete: false,
    eventCount: 0,
    pages: [],
  };
  let requestStart = fight.start_time;
  for (let pageIndex = 1; ; pageIndex += 1) {
    const relativePath = relativePagePath(fight.id, pageIndex);
    const fullPath = join(reportDir, relativePath);
    if (!existsSync(fullPath)) break;
    const page = await readGzipJson<EventPage>(fullPath, basename(fullPath));
    validatePage(page, fight);
    const firstTimestamp = page.events.length ? Math.min(...page.events.map((event) => event.timestamp)) : null;
    const lastTimestamp = page.events.length ? Math.max(...page.events.map((event) => event.timestamp)) : null;
    const bytes = await readFile(fullPath);
    state.pages.push({
      index: pageIndex,
      file: relativePath.replaceAll("\\", "/"),
      requestStart,
      firstTimestamp,
      lastTimestamp,
      nextPageTimestamp: page.nextPageTimestamp ?? null,
      eventCount: page.events.length,
      compressedBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    state.eventCount += page.events.length;
    if (!page.nextPageTimestamp || page.nextPageTimestamp > fight.end_time) {
      state.complete = true;
      break;
    }
    if (page.nextPageTimestamp <= requestStart) throw new Error(`fight ${fight.id} 的缓存分页没有向前推进`);
    requestStart = page.nextPageTimestamp;
  }
  return state;
}

async function downloadFight(options: Options, reportDir: string, fight: WclCompatFight, state: FightState, onUpdate: () => Promise<void>) {
  if (state.complete) {
    process.stdout.write(`fight ${fight.id} 已完整缓存：${state.eventCount.toLocaleString()} 条事件\n`);
    return;
  }
  let requestStart = state.pages.at(-1)?.nextPageTimestamp ?? fight.start_time;
  let pageIndex = state.pages.length + 1;
  process.stdout.write(`fight ${fight.id} ${fight.name}：从 ${requestStart - fight.start_time}ms 继续\n`);
  while (requestStart <= fight.end_time) {
    const url = new URL(`${options.baseUrl}/events/${options.reportCode}`);
    url.searchParams.set("start", String(requestStart));
    url.searchParams.set("end", String(fight.end_time));
    url.searchParams.set("translate", "true");
    const text = await requestText(url.toString(), options.retries);
    const page = parseJson<EventPage>(text, `fight ${fight.id} page ${pageIndex}`);
    validatePage(page, fight);
    const relativePath = relativePagePath(fight.id, pageIndex);
    const compressed = await writeGzipJson(join(reportDir, relativePath), text);
    const firstTimestamp = page.events.length ? Math.min(...page.events.map((event) => event.timestamp)) : null;
    const lastTimestamp = page.events.length ? Math.max(...page.events.map((event) => event.timestamp)) : null;
    state.pages.push({
      index: pageIndex,
      file: relativePath,
      requestStart,
      firstTimestamp,
      lastTimestamp,
      nextPageTimestamp: page.nextPageTimestamp ?? null,
      eventCount: page.events.length,
      compressedBytes: compressed.byteLength,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    });
    state.eventCount += page.events.length;
    process.stdout.write(`  第 ${pageIndex} 页：${page.events.length.toLocaleString()} 条，累计 ${state.eventCount.toLocaleString()} 条\n`);
    if (!page.nextPageTimestamp || page.nextPageTimestamp > fight.end_time) {
      state.complete = true;
      await onUpdate();
      break;
    }
    if (page.nextPageTimestamp <= requestStart) throw new Error(`fight ${fight.id} 的分页没有向前推进`);
    requestStart = page.nextPageTimestamp;
    pageIndex += 1;
    await onUpdate();
    if (options.delayMs > 0) await sleep(options.delayMs);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const reportDir = join(options.outputRoot, options.reportCode);
  const reportPath = join(reportDir, "report.json.gz");
  const statePath = join(reportDir, "download-state.json");
  await mkdir(reportDir, { recursive: true });

  let report: WclCompatReport;
  if (!options.refreshReport && existsSync(reportPath)) {
    report = await readGzipJson<WclCompatReport>(reportPath, "report.json.gz");
    validateReport(report);
    process.stdout.write("使用已缓存的报告元数据\n");
  } else {
    process.stdout.write("读取报告、角色和战斗元数据\n");
    const url = `${options.baseUrl}/fights/${options.reportCode}?translate=true`;
    const text = await requestText(url, options.retries);
    report = parseJson<WclCompatReport>(text, "报告元数据");
    validateReport(report);
    await writeGzipJson(reportPath, text);
  }

  const selectedFights = options.fightIds.map((fightId) => {
    const fight = report.fights.find((candidate) => candidate.id === fightId);
    if (!fight) throw new Error(`报告中不存在 fight ${fightId}`);
    if (fight.difficulty !== 5) throw new Error(`fight ${fightId} 不是史诗难度`);
    return fight;
  });
  const fightStates = await Promise.all(selectedFights.map((fight) => loadExistingFightState(reportDir, fight)));
  let retainedFightStates: FightState[] = [];
  if (existsSync(statePath)) {
    const previous = JSON.parse(await readFile(statePath, "utf8")) as Partial<DownloadState>;
    if (previous.schemaVersion === 1 && previous.reportCode === options.reportCode && Array.isArray(previous.fights)) {
      retainedFightStates = previous.fights.filter((fight) => !options.fightIds.includes(fight.fightId));
    }
  }
  const state: DownloadState = {
    schemaVersion: 1,
    source: "wowanalyzer-compat",
    reportCode: options.reportCode,
    baseUrl: options.baseUrl,
    updatedAt: Date.now(),
    fights: [...retainedFightStates, ...fightStates].sort((left, right) => left.fightId - right.fightId),
  };
  const persist = async () => {
    state.updatedAt = Date.now();
    await writeState(statePath, state);
  };
  await persist();
  for (let index = 0; index < selectedFights.length; index += 1) {
    await downloadFight(options, reportDir, selectedFights[index], fightStates[index], persist);
  }
  await persist();
  const total = fightStates.reduce((sum, fight) => sum + fight.eventCount, 0);
  process.stdout.write(`完成：${fightStates.length} 场，${total.toLocaleString()} 条原始事件\n缓存：${reportDir}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
