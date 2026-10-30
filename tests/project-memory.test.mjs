import test from "node:test";
import assert from "node:assert/strict";
import { Store, DEFAULT_SETTINGS } from "../server/store.mjs";
import { memorySnapshot } from "../server/memory.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider } from "../server/providers.mjs";
import { request as httpRequest } from "node:http";

test("legacy projects gain empty optional memories; saves and undo never rewrite existing snapshots", () => {
  const s = new Store(":memory:");
  try {
    const a = s.createProject("A"),
      b = s.createProject("B");
    const legacy = {
      purpose: "书籍",
      style: "水彩",
      palette: "蓝色",
      constraints: "",
      ratio: "1:1",
    };
    s.db
      .prepare("UPDATE projects SET settings=? WHERE id=?")
      .run(JSON.stringify(legacy), a.id);
    const old = s.project(a.id);
    assert.equal(old.settings.subjectIdentity, "");
    const frozen = memorySnapshot(old, []);
    const changed = s.updateProject(a.id, "A", {
      ...old.settings,
      subjectIdentity: "橙围巾机器人",
      avoid: "文字",
    });
    assert.equal(changed.canUndoMemory, true);
    assert.notEqual(changed.memoryRevision, old.memoryRevision);
    assert.equal(frozen.settings.subjectIdentity, "");
    assert.equal(s.project(b.id).canUndoMemory, false);
    // Identical saves must not create another undo step, even with reordered keys.
    s.updateProject(
      a.id,
      "renamed",
      Object.fromEntries(Object.entries(changed.settings).reverse()),
    );
    const restored = s.undoMemory(a.id);
    assert.deepEqual(restored.settings, old.settings);
    assert.equal(restored.name, "renamed");
    assert.equal(restored.canUndoMemory, false);
    assert.deepEqual(s.project(b.id).settings, DEFAULT_SETTINGS);
  } finally {
    s.close();
  }
});

test("memory API rejects stale saves, validates optional fields and isolates undo by project", async (t) => {
  const store = new Store(":memory:"),
    app = createApp({ store, provider: new DemoProvider() });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.drain();
    await new Promise((r) => app.server.close(r));
    store.close();
  });
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const a = store.createProject("A"),
    b = store.createProject("B");
  const send = (path, body, method = "PATCH") =>
    fetch(root + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const path = `/api/projects/${a.id}`;
  const response = await send(path, {
    name: "A",
    settings: { ...a.settings, typography: "无衬线" },
    memoryRevision: a.memoryRevision,
  });
  assert.equal(response.status, 200);
  const current = await response.json();
  assert.equal(current.settings.typography, "无衬线");
  assert.equal(
    (
      await send(path, {
        name: "A",
        settings: a.settings,
        memoryRevision: a.memoryRevision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await send(path, { name: "A", settings: { avoid: 1 } })).status,
    400,
  );
  assert.equal((await send(path, { name: "A", settings: null })).status, 400);
  assert.equal(
    (
      await send(
        `${path}/memory/undo`,
        { memoryRevision: a.memoryRevision },
        "POST",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        `/api/projects/${b.id}/memory/undo`,
        { memoryRevision: b.memoryRevision },
        "POST",
      )
    ).status,
    200,
  );
  assert.equal(store.project(a.id).settings.typography, "无衬线");
  const restored = await send(
    `${path}/memory/undo`,
    { memoryRevision: current.memoryRevision },
    "POST",
  );
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).settings.typography, "");
  // The other window saves while a slow request is still uploading its body.
  const before = store.project(a.id);
  let arrived;
  const received = new Promise((r) => {
    arrived = r;
  });
  app.server.once("request", arrived);
  let slow;
  const slowResult = new Promise((done, reject) => {
    slow = httpRequest(
      root + path,
      { method: "PATCH", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => done(res.statusCode));
      },
    );
    slow.on("error", reject);
    slow.write("{");
  });
  await received;
  assert.equal(
    (
      await send(path, {
        name: "A",
        settings: { ...before.settings, style: "newer" },
        memoryRevision: before.memoryRevision,
      })
    ).status,
    200,
  );
  slow.end(
    JSON.stringify({
      name: "A",
      settings: { ...before.settings, style: "stale" },
      memoryRevision: before.memoryRevision,
    }).slice(1),
  );
  assert.equal(await slowResult, 409);
  assert.equal(store.project(a.id).settings.style, "newer");
});
