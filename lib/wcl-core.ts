import type { WclAbilityGroup } from "./types.ts";

export class WclInputError extends Error {}

export function parseWclSourceInput(input: string) {
  const value = input.trim();
  const reportMatch = value.match(/warcraftlogs\.com\/reports\/([A-Za-z0-9]+)/i);
  const rawMatch = value.match(/^([A-Za-z0-9]{8,64})$/);
  const code = reportMatch?.[1] ?? rawMatch?.[1];
  if (!code) throw new WclInputError("请输入有效的 WCL 战报链接或报告代码");
  const fightMatch = value.match(/(?:[?#&]fight=)(\d+)/i);
  return { reportCode: code, fightId: fightMatch ? Number(fightMatch[1]) : undefined };
}

export function groupCastEvents(
  events: Array<Record<string, unknown>>,
  fightStart: number,
  fightDuration: number,
  abilityNames: Map<number, string>,
): WclAbilityGroup[] {
  const grouped = new Map<number, number[]>();
  for (const event of events) {
    const spellId = Number(event.abilityGameID ?? (event.ability as Record<string, unknown> | undefined)?.gameID ?? 0);
    const timestamp = Number(event.timestamp ?? 0) - fightStart;
    if (!spellId || timestamp < 0 || timestamp > fightDuration + 5000) continue;
    grouped.set(spellId, [...(grouped.get(spellId) ?? []), Math.round(timestamp)]);
  }
  return Array.from(grouped, ([spellId, timestamps]) => ({
    spellId,
    name: abilityNames.get(spellId) ?? `技能 ${spellId}`,
    count: timestamps.length,
    timestamps: timestamps.sort((a, b) => a - b),
  })).sort((a, b) => a.timestamps[0] - b.timestamps[0]);
}

export async function collectCastPages(
  loader: (start: number | null) => Promise<{ data: unknown; nextPageTimestamp?: number | null }>,
  limit = 50_000,
) {
  const events: Array<Record<string, unknown>> = [];
  let start: number | null = null;
  for (;;) {
    const page = await loader(start);
    if (Array.isArray(page.data)) events.push(...(page.data as Array<Record<string, unknown>>));
    if (events.length > limit) throw new Error(`事件超过 ${limit.toLocaleString("en-US")} 条限制`);
    if (!page.nextPageTimestamp || page.nextPageTimestamp === start) break;
    start = Number(page.nextPageTimestamp);
  }
  return events;
}
