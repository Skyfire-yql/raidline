import assert from "node:assert/strict";
import test from "node:test";
import { createBlankPlan, detectConflicts, exportMrtNote, formatTime, parseTime } from "../lib/core.ts";
import { collectCastPages, groupCastEvents, parseWclSourceInput } from "../lib/wcl-core.ts";

test("parses WCL report URLs and fight ids", () => {
  assert.deepEqual(parseWclSourceInput("https://www.warcraftlogs.com/reports/AbC123xy#fight=17&type=damage-done"), { reportCode: "AbC123xy", fightId: 17 });
  assert.deepEqual(parseWclSourceInput("AbC123xy"), { reportCode: "AbC123xy", fightId: undefined });
  assert.throws(() => parseWclSourceInput("not a report"));
});

test("collects paginated casts and stops on the terminal page", async () => {
  const starts: Array<number | null> = [];
  const events = await collectCastPages(async (start) => {
    starts.push(start);
    return start == null
      ? { data: [{ timestamp: 10 }], nextPageTimestamp: 100 }
      : { data: [{ timestamp: 110 }], nextPageTimestamp: null };
  }, 10);
  assert.deepEqual(starts, [null, 100]);
  assert.equal(events.length, 2);
});

test("groups WCL casts into deterministic mechanic candidates", () => {
  const groups = groupCastEvents([
    { timestamp: 1200, abilityGameID: 44 },
    { timestamp: 1900, abilityGameID: 44 },
    { timestamp: 2500, abilityGameID: 55 },
  ], 1000, 10_000, new Map([[44, "虚空洪流"]]));
  assert.deepEqual(groups[0], { spellId: 44, name: "虚空洪流", count: 2, timestamps: [200, 900] });
  assert.equal(groups[1].name, "技能 55");
});

test("detects cooldown and overlap conflicts and exports MRT text", () => {
  const plan = createBlankPlan("测试首领");
  plan.roster.push({ id: "m1", name: "沐光", classSlug: "Priest", specSlug: "神圣", role: "healer", color: "#fff" });
  plan.assignments.push(
    { id: "a1", memberId: "m1", cooldownId: "spell-62618", atMs: 30_000, note: "", source: "manual" },
    { id: "a2", memberId: "m1", cooldownId: "spell-62618", atMs: 40_000, note: "", source: "manual" },
    { id: "a3", memberId: "m1", cooldownId: "spell-64843", atMs: 40_500, note: "", source: "manual" },
  );
  assert.ok(detectConflicts(plan).some((item) => item.type === "cooldown"));
  assert.ok(detectConflicts(plan).some((item) => item.type === "overlap"));
  assert.match(exportMrtNote(plan), /\{time:00:30\} 沐光 — 真言术：障/);
});

test("formats and parses timeline timestamps", () => {
  assert.equal(formatTime(83_000), "01:23");
  assert.equal(parseTime("01:23"), 83_000);
  assert.equal(parseTime("90"), 90_000);
  assert.equal(parseTime("bad"), null);
});
