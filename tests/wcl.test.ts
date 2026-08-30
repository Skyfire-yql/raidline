import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWclClient, WclClientError } from "../lib/wcl-client.ts";
import {
  InvalidWclReportUrlError,
  normalizeWclReportProbe,
  parseWclReportUrl,
} from "../lib/wcl-report.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wcl-report-phases-response.json", import.meta.url), "utf8"));

test("WCL report URLs accept official regional hosts and strict fight selectors", () => {
  assert.deepEqual(parseWclReportUrl("https://cn.warcraftlogs.com/reports/baxm3wf8MDvF6V7W"), {
    reportCode: "baxm3wf8MDvF6V7W",
    fight: null,
  });
  assert.deepEqual(parseWclReportUrl("https://www.warcraftlogs.com/reports/baxm3wf8MDvF6V7W?fight=32&type=damage-done"), {
    reportCode: "baxm3wf8MDvF6V7W",
    fight: 32,
  });
  assert.deepEqual(parseWclReportUrl("https://tw.warcraftlogs.com/reports/baxm3wf8MDvF6V7W?fight=last"), {
    reportCode: "baxm3wf8MDvF6V7W",
    fight: "last",
  });
  for (const value of [
    "https://example.com/reports/baxm3wf8MDvF6V7W",
    "https://evilwarcraftlogs.com/reports/baxm3wf8MDvF6V7W",
    "http://cn.warcraftlogs.com/reports/baxm3wf8MDvF6V7W",
    "https://cn.warcraftlogs.com/reports/short",
    "https://cn.warcraftlogs.com/reports/baxm3wf8MDvF6V7W?fight=0",
    "https://cn.warcraftlogs.com/reports/baxm3wf8MDvF6V7W?fight=1&fight=2",
  ]) assert.throws(() => parseWclReportUrl(value), InvalidWclReportUrlError);
});

test("WCL report probe keeps provider data transient and normalizes official phase transitions", () => {
  const report = fixture.data.reportData.report;
  const probe = normalizeWclReportProbe(report, { reportCode: report.code, fight: 32 });
  assert.equal(probe.report.title, "Raid Testing Mythic re-test boss 1,3,4,7");
  assert.equal(probe.selectedFightId, 32);
  assert.equal(probe.fights.length, 2, "trash fights are not import candidates");
  const kill = probe.fights[0];
  assert.equal(kill.difficulty, "mythic");
  assert.equal(kill.supported, true);
  assert.equal(kill.durationMs, 434_000);
  assert.equal(kill.bossPercentage, 0);
  assert.equal(kill.fightPercentage, 0);
  assert.equal(kill.hasOfficialPhases, true);
  assert.deepEqual(kill.phases, [
    { semanticPhaseId: 1, occurrenceIndex: 1, atMs: 0 },
    { semanticPhaseId: 2, occurrenceIndex: 1, atMs: 90_250 },
    { semanticPhaseId: 1, occurrenceIndex: 2, atMs: 151_750 },
  ]);
  assert.equal("events" in probe, false);
  assert.equal("actors" in probe, false);

  const heroic = probe.fights[1];
  assert.equal(heroic.supported, false);
  assert.equal(heroic.bossPercentage, 62.5);
  assert.equal(heroic.fightPercentage, 62.5);
  assert.deepEqual(heroic.phases, [
    { semanticPhaseId: 1, occurrenceIndex: 1, atMs: 0 },
    { semanticPhaseId: 2, occurrenceIndex: 1, atMs: 30_000 },
  ]);
  assert.throws(
    () => normalizeWclReportProbe(report, { reportCode: report.code, fight: 999 }),
    (error) => error instanceof WclClientError && error.code === "WCL_FIGHT_NOT_FOUND",
  );
});

test("WCL client uses server credentials, caches OAuth tokens and never returns GraphQL DTOs", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/oauth/token")) {
      return Response.json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(init?.headers instanceof Headers ? init.headers.get("authorization") : undefined, "Bearer fixture-access-token");
    return Response.json(fixture);
  };
  const client = createWclClient({
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    tokenUrl: "https://www.warcraftlogs.com/oauth/token",
    apiUrl: "https://www.warcraftlogs.com/api/v2/client",
    fetchImpl,
    sleep: async () => {},
  });
  const link = parseWclReportUrl("https://cn.warcraftlogs.com/reports/baxm3wf8MDvF6V7W?fight=32");
  const first = await client.probeReport(link);
  const second = await client.probeReport(link);
  assert.equal(first.selectedFightId, 32);
  assert.equal(second.fights[0].phases[1].atMs, 90_250);
  assert.equal(requests.filter((item) => item.url.endsWith("/oauth/token")).length, 1);
  assert.equal(requests.filter((item) => item.url.endsWith("/api/v2/client")).length, 2);
  const graphQlBody = JSON.parse(String(requests.find((item) => item.url.endsWith("/api/v2/client"))?.init?.body));
  assert.equal(graphQlBody.variables.code, "baxm3wf8MDvF6V7W");
  assert.match(graphQlBody.query, /phaseTransitions/);
  assert.doesNotMatch(JSON.stringify(first), /fixture-access-token|fixture-secret|reportData/);
});

test("WCL client reports authentication and GraphQL failures without leaking secrets", async () => {
  const authClient = createWclClient({
    clientId: "fixture-client",
    clientSecret: "do-not-leak",
    tokenUrl: "https://www.warcraftlogs.com/oauth/token",
    apiUrl: "https://www.warcraftlogs.com/api/v2/client",
    fetchImpl: async () => new Response("no", { status: 401 }),
    sleep: async () => {},
  });
  await assert.rejects(
    () => authClient.probeReport({ reportCode: "baxm3wf8MDvF6V7W", fight: null }),
    (error) => error instanceof WclClientError && error.code === "WCL_AUTH_FAILED" && !error.message.includes("do-not-leak"),
  );

  let call = 0;
  const graphQlClient = createWclClient({
    clientId: "fixture-client",
    clientSecret: "do-not-leak",
    tokenUrl: "https://www.warcraftlogs.com/oauth/token",
    apiUrl: "https://www.warcraftlogs.com/api/v2/client",
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : Response.json({ errors: [{ message: "report unavailable" }] });
    },
    sleep: async () => {},
  });
  await assert.rejects(
    () => graphQlClient.probeReport({ reportCode: "baxm3wf8MDvF6V7W", fight: null }),
    (error) => error instanceof WclClientError && error.code === "WCL_GRAPHQL_FAILED" && error.message === "WCL 无法按当前查询读取这份报告",
  );
});

test("WCL client reads anonymous fight metadata and follows event pagination", async () => {
  let apiCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/oauth/token")) return Response.json({ access_token: "event-token", expires_in: 3600 });
    apiCalls += 1;
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (body.query.includes("RaidlineFightMetadata")) {
      return Response.json({ data: { reportData: { report: {
        code: "baxm3wf8MDvF6V7W",
        visibility: "public",
        revision: 3,
        startTime: 1_800_000_000_000,
        zone: { id: 42 },
        masterData: {
          gameVersion: 1,
          logVersion: 17,
          lang: "en",
          actors: [
            { id: -1, gameID: 0, type: "NPC", subType: "Boss", petOwner: null },
            { id: 10, gameID: 259181, type: "NPC", subType: "Boss", petOwner: null },
          ],
        },
        fights: [{
          id: 32,
          encounterID: 3134,
          name: "Vashnik the Malignant",
          difficulty: 5,
          kill: true,
          startTime: 100_000,
          endTime: 534_000,
          phaseTransitions: null,
          friendlyPlayers: [1],
          enemyPlayers: [],
          friendlyNPCs: [],
          enemyNPCs: [{ id: 10, gameID: 259181, petOwner: null }],
          friendlyPets: [],
          enemyPets: [],
        }],
      } } } });
    }
    assert.match(body.query, /RaidlineFightEvents/);
    if (body.variables.startTime === 100_000) {
      return Response.json({ data: { reportData: { report: { events: {
        data: [{ timestamp: 110_000, type: "begincast", sourceID: 10, targetID: -1, abilityGameID: 1280935 }],
        nextPageTimestamp: 200_000,
      } } } } });
    }
    return Response.json({ data: { reportData: { report: { events: { data: [], nextPageTimestamp: null } } } } });
  };
  const client = createWclClient({
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    tokenUrl: "https://www.warcraftlogs.com/oauth/token",
    apiUrl: "https://www.warcraftlogs.com/api/v2/client",
    fetchImpl,
    sleep: async () => {},
  });
  const bundle = await client.readFightEvents("baxm3wf8MDvF6V7W", 32, [{ dataType: "Casts", hostilityType: "Enemies" }]);
  assert.equal(bundle.fight.encounterID, 3134);
  assert.equal(bundle.masterData.actors[0].id, -1, "provider sentinel actors remain transient metadata");
  assert.equal(bundle.fetchedEventCount, 1);
  assert.equal(bundle.pageCount, 2);
  assert.equal(bundle.series[0].events.length, 1);
  assert.equal(apiCalls, 3);
  assert.doesNotMatch(JSON.stringify(bundle), /event-token|fixture-secret|authorization/i);
});
