import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`production server exited early\n${logs.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`production server did not become ready\n${logs.join("")}`);
}

test("server-renders the Raidline product entry", async () => {
  const port = 31873;
  const logs = [];
  const childEnv = { ...process.env, PORT: String(port) };
  const child = spawn(process.execPath, [cli, "dev", "--port", String(port)], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    const response = await waitForServer(`http://localhost:${port}/`, child, logs);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    assert.match(html, /团轴/);
    assert.match(html, /创建空白计划/);
    assert.match(html, /团本排轴工作台/);
    assert.match(html, /仅所有者可见/);
    assert.doesNotMatch(html, /WCL|战报|治疗缺口|治疗需求|机制压力/);
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);

    const base = `http://localhost:${port}`;
    const createdResponse = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "集成测试首领" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const authorization = { authorization: `Bearer ${created.data.editToken}` };

    assert.equal((await fetch(`${base}/api/plans/${created.data.id}`)).status, 401);
    const readResponse = await fetch(`${base}/api/plans/${created.data.id}`, { headers: authorization });
    assert.equal(readResponse.status, 200);
    const read = await readResponse.json();
    assert.equal(read.data.document.schemaVersion, 2);
    assert.equal(read.data.document.roster.length, 20);
    assert.equal(read.data.document.roster[0].classSlug, "");
    assert.equal(read.data.document.settings.referenceMaxHealth, null);
    read.data.document.encounter.name = "更新后的首领";
    read.data.document.settings.referenceMaxHealth = 1_000_000;
    const saveBody = JSON.stringify({ baseVersion: read.data.version, document: read.data.document });
    const savedResponse = await fetch(`${base}/api/plans/${created.data.id}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: saveBody,
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.data.version, 2);
    assert.equal(saved.data.document.schemaVersion, 2);
    assert.equal(saved.data.document.settings.referenceMaxHealth, 1_000_000);

    const conflictResponse = await fetch(`${base}/api/plans/${created.data.id}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: saveBody,
    });
    assert.equal(conflictResponse.status, 409);

    const sharedResponse = await fetch(`${base}/api/shared/${saved.data.shareSlug}`);
    assert.equal(sharedResponse.status, 200);
    const sharedText = await sharedResponse.text();
    assert.doesNotMatch(sharedText, /editToken|edit_key_hash/i);
    assert.match(sharedText, /"schemaVersion":2/);

    const invalidKeyResponse = await fetch(`${base}/api/plans/${created.data.id}`, { headers: { authorization: "Bearer invalid-key" } });
    assert.equal(invalidKeyResponse.status, 401);

    const legacy = {
      schemaVersion: 1,
      encounter: { name: "旧版兼容计划", difficulty: "英雄", durationMs: 120000 },
      roster: [], phases: [{ id: "p1", name: "P1", atMs: 0 }], mechanics: [], cooldowns: [], assignments: [],
      settings: { snapMs: 1000, zoom: 1, showMinorMechanics: true },
    };
    const legacyResponse = await fetch(`${base}/api/plans/${created.data.id}`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: saved.data.version, document: legacy }),
    });
    assert.equal(legacyResponse.status, 200);
    const migrated = await legacyResponse.json();
    assert.equal(migrated.data.document.schemaVersion, 2);
    assert.equal(migrated.data.document.encounter.name, "旧版兼容计划");
    assert.equal(migrated.data.document.settings.pressureResetMs, 10000);

    const removedImportResponse = await fetch(`${base}/api/plans/${created.data.id}/wcl/preview`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ source: "removed" }),
    });
    assert.equal(removedImportResponse.status, 404);
  } finally {
    child.kill();
  }
});
