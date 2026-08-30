import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const productionServer = fileURLToPath(new URL("../scripts/vinext-start.mjs", import.meta.url));

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`production server exited early\n${logs.join("")}`);
    try { const response = await fetch(url); if (response.ok) return response; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`production server did not become ready\n${logs.join("")}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    timeout.unref();
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function plan(title = "集成测试排轴") {
  return {
    schemaVersion: 1,
    metadata: { title },
    encounter: { id: randomUUID(), name: "集成测试首领", gameVersion: "retail-12.1" },
    sources: [],
    definitions: { mechanics: [], skills: [] },
    roster: { groups: [], members: [], memberSkills: [] },
    timeline: { phases: [{ id: randomUUID(), name: "P1", ordinal: 1, estimatedStartMs: 0 }], mechanics: [], directives: [], skillAssignments: [] },
  };
}

async function json(response) { return { response, payload: await response.json() }; }

test("Raidline renders and exposes strict v1 publication/catalog APIs", async () => {
  const port = 31800 + Math.floor(Math.random() * 500);
  const logs = [];
  const dataDirectory = await mkdtemp(join(tmpdir(), "raidline-rendered-"));
  const childEnv = { ...process.env, PORT: String(port), RAIDLINE_DATA_DIR: dataDirectory };
  delete childEnv.HTTP_PROXY; delete childEnv.HTTPS_PROXY; delete childEnv.ALL_PROXY;
  const child = spawn(process.execPath, [productionServer, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString())); child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    const base = `http://localhost:${port}`;
    const response = await waitForServer(`${base}/`, child, logs);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    const assetPaths = [...new Set([...html.matchAll(/(?:href|src)="(\/assets\/[^"?#]+)[^\"]*"/g)].map((match) => match[1]))];
    assert.ok(assetPaths.some((path) => path.endsWith(".css")), "rendered HTML should reference a CSS asset");
    assert.ok(assetPaths.some((path) => path.endsWith(".js")), "rendered HTML should reference a JavaScript asset");
    for (const assetPath of assetPaths) {
      const asset = await fetch(`${base}${assetPath}`);
      assert.equal(asset.status, 200, `${assetPath} should be served by the production server`);
      if (assetPath.endsWith(".css")) assert.match(asset.headers.get("content-type") ?? "", /^text\/css\b/i);
      if (assetPath.endsWith(".js")) assert.match(asset.headers.get("content-type") ?? "", /^(?:application|text)\/javascript\b/i);
    }
    assert.match(html, /团轴/); assert.match(html, /空白计划/); assert.match(html, /我的轴/); assert.match(html, /目录预设/); assert.match(html, /从 WCL 导入/);
    assert.doesNotMatch(html, /团本排轴工作台|本地优先|目录管理|IndexedDB|本地版本|仅所有者可见|个人预设|导入 JSON|WCL_CLIENT_SECRET/);

    const invalidWcl = await json(await fetch(`${base}/api/wcl/reports/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/reports/LgdFn8NyAGRqWT3V" }),
    }));
    assert.equal(invalidWcl.response.status, 422); assert.equal(invalidWcl.payload.error.code, "INVALID_WCL_LINK");

    const invalidWclImport = await json(await fetch(`${base}/api/wcl/reports/import-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/reports/LgdFn8NyAGRqWT3V", fightId: 64 }),
    }));
    assert.equal(invalidWclImport.response.status, 422); assert.equal(invalidWclImport.payload.error.code, "INVALID_WCL_IMPORT");

    const shareId = randomBytes(8).toString("hex"); const editId = "A9z0"; const original = plan();
    const created = await json(await fetch(`${base}/api/publications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shareId, editId, document: original }) }));
    assert.equal(created.response.status, 201);
    assert.match(created.payload.data.shareId, /^[0-9A-Za-z]{16}$/); assert.match(created.payload.data.editId, /^[0-9A-Za-z]{4}$/);
    assert.equal(created.payload.data.document.schemaVersion, 1); assert.equal(created.payload.data.document.metadata.title, "集成测试排轴");
    assert.deepEqual(created.payload.data.document.timeline.directives, []); assert.deepEqual(created.payload.data.document.roster.memberSkills, []);
    assert.equal("difficulty" in created.payload.data.document.encounter, false); assert.equal("durationMs" in created.payload.data.document.encounter, false);

    const read = await json(await fetch(`${base}/api/publications/${shareId}`));
    assert.equal(read.response.status, 200); assert.equal(read.payload.data.document.encounter.name, "集成测试首领"); assert.equal(read.payload.data.editId, undefined); assert.doesNotMatch(JSON.stringify(read.payload), /A9z0/);
    assert.equal((await fetch(`${base}/api/publications/${shareId}/zzzz`)).status, 403);
    const editable = await json(await fetch(`${base}/api/publications/${shareId}/${editId}`));
    assert.equal(editable.response.status, 200); assert.equal(editable.payload.data.binding.editId, editId);

    const updatedDocument = structuredClone(read.payload.data.document); updatedDocument.metadata.title = "覆盖后的排轴";
    const updated = await json(await fetch(`${base}/api/publications/${shareId}/${editId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: updatedDocument }) }));
    assert.equal(updated.response.status, 200); assert.notEqual(updated.payload.data.revisionId, created.payload.data.revisionId);
    assert.equal((await json(await fetch(`${base}/api/publications/${shareId}`))).payload.data.document.metadata.title, "覆盖后的排轴");

    const secondShareId = randomBytes(8).toString("hex");
    const second = await json(await fetch(`${base}/api/publications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shareId: secondShareId, editId: "Qw2E", document: updatedDocument }) }));
    assert.equal(second.response.status, 201); assert.equal((await json(await fetch(`${base}/api/publications/${shareId}`))).payload.data.shareId, shareId);

    const legacy = { ...plan(), schemaVersion: 5 };
    assert.equal((await fetch(`${base}/api/publications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: legacy }) })).status, 422);
    const unknown = { ...plan(), settings: { snapMs: 1000 } };
    assert.equal((await fetch(`${base}/api/publications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: unknown }) })).status, 422);

    const catalog = await json(await fetch(`${base}/api/catalog/current`));
    assert.equal(catalog.response.status, 200); assert.equal(catalog.payload.data.manifest.version, "builtin-seed-v5"); assert.equal(catalog.payload.data.manifest.schemaVersion, 1);
    assert.equal(catalog.payload.data.playerSkills.length, 5); assert.equal(catalog.payload.data.bossMechanics.length, 13); assert.equal(catalog.payload.data.timelinePresets.length, 2);
    assert.equal(catalog.payload.data.timelinePresets[0].phases[0].ordinal, 1); assert.deepEqual(catalog.payload.data.timelinePresets[0].notes, []);
    const vashnikPreset = catalog.payload.data.timelinePresets.find((preset) => preset.encounter.externalIds?.wclEncounterId === 3455);
    assert.equal(vashnikPreset.enabled, true); assert.equal(vashnikPreset.mechanics.length, 76); assert.equal(vashnikPreset.notes.length, 1);

    assert.equal((await fetch(`${base}/api/plans`, { method: "POST" })).status, 404); assert.equal((await fetch(`${base}/api/shared/${secondShareId}`)).status, 404);
    assert.equal((await fetch(`${base}/api/publications/${shareId}/bad1`, { method: "DELETE" })).status, 403);
    assert.equal((await fetch(`${base}/api/publications/${shareId}/${editId}`, { method: "DELETE" })).status, 200); assert.equal((await fetch(`${base}/api/publications/${shareId}`)).status, 404);
    assert.equal((await fetch(`${base}/api/publications/${secondShareId}/Qw2E`, { method: "DELETE" })).status, 200);
  } finally {
    await stopChild(child);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
