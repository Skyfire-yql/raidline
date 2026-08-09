import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`production server exited early\n${logs.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* The server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`production server did not become ready\n${logs.join("")}`);
}

function plan(name = "集成测试首领") {
  return {
    schemaVersion: 2,
    encounter: { name, difficulty: "史诗", durationMs: 600_000 },
    groups: [], roster: [], phases: [{ id: "p1", name: "P1", atMs: 0 }], mechanics: [], cooldowns: [], assignments: [],
    settings: { snapMs: 1000, showMinorMechanics: true, referenceMaxHealth: null, pressureResetMs: 10_000, defensiveLeadMs: 3000 },
  };
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

test("server-renders Raidline and implements explicit R2 publication semantics", async () => {
  const port = 31873;
  const logs = [];
  const childEnv = { ...process.env, PORT: String(port) };
  delete childEnv.HTTP_PROXY;
  delete childEnv.HTTPS_PROXY;
  delete childEnv.ALL_PROXY;
  const child = spawn(process.execPath, [cli, "dev", "--port", String(port)], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    const base = `http://localhost:${port}`;
    const response = await waitForServer(`${base}/`, child, logs);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    assert.match(html, /团轴/);
    assert.match(html, /创建空白计划/);
    assert.match(html, /团本排轴工作台/);
    assert.match(html, /本地优先/);
    assert.doesNotMatch(html, /仅所有者可见|WCL|战报|个人预设|导入 JSON/);

    const shareId = "0aZ9bY8cX7dW6eV5";
    const editId = "A9z0";
    const created = await json(await fetch(`${base}/api/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareId, editId, document: plan() }),
    }));
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.data.shareId, shareId);
    assert.equal(created.payload.data.editId, editId);
    assert.match(created.payload.data.shareId, /^[0-9A-Za-z]{16}$/);
    assert.match(created.payload.data.editId, /^[0-9A-Za-z]{4}$/);
    assert.equal(created.payload.data.document.schemaVersion, 3);

    const read = await json(await fetch(`${base}/api/publications/${shareId}`));
    assert.equal(read.response.status, 200);
    assert.equal(read.payload.data.document.encounter.name, "集成测试首领");
    assert.equal(read.payload.data.editId, undefined);
    assert.doesNotMatch(JSON.stringify(read.payload), /A9z0/);

    assert.equal((await fetch(`${base}/api/publications/${shareId}/zzzz`)).status, 403);
    const editable = await json(await fetch(`${base}/api/publications/${shareId}/${editId}`));
    assert.equal(editable.response.status, 200);
    assert.equal(editable.payload.data.binding.editId, editId);

    const updatedDocument = structuredClone(read.payload.data.document);
    updatedDocument.encounter.name = "覆盖后的首领";
    const updated = await json(await fetch(`${base}/api/publications/${shareId}/${editId}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: updatedDocument }),
    }));
    assert.equal(updated.response.status, 200);
    assert.notEqual(updated.payload.data.revisionId, created.payload.data.revisionId);
    assert.equal((await json(await fetch(`${base}/api/publications/${shareId}`))).payload.data.document.encounter.name, "覆盖后的首领");

    const secondShareId = "1234567890AbCdEf";
    const second = await json(await fetch(`${base}/api/publications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shareId: secondShareId, editId: "Qw2E", document: updatedDocument }),
    }));
    assert.equal(second.response.status, 201);
    assert.equal((await json(await fetch(`${base}/api/publications/${shareId}`))).payload.data.shareId, shareId);

    assert.equal((await fetch(`${base}/api/publications/${shareId}/bad1`, { method: "DELETE" })).status, 403);
    assert.equal((await fetch(`${base}/api/publications/${shareId}/${editId}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/api/publications/${shareId}`)).status, 404);

    const catalog = await json(await fetch(`${base}/api/catalog/current`));
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.payload.data.manifest.version, "builtin-seed-v1");
    assert.ok(catalog.payload.data.playerSkills.length > 20);
    assert.equal((await fetch(`${base}/api/plans`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/api/shared/${secondShareId}`)).status, 404);
  } finally {
    child.kill();
  }
});
