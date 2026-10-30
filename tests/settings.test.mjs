import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { ModelSettings, environmentSettings } from "../server/settings.mjs";
import { createApp } from "../server/app.mjs";

function fixture(t, options = {}) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return {
    store,
    settings: new ModelSettings({
      store,
      defaults: environmentSettings({}),
      ...options,
    }),
  };
}
function draft(settings) {
  const input = settings.public();
  return {
    ...input,
    llm: { ...input.llm, apiKey: "" },
    image: { ...input.image, apiKey: "" },
  };
}

test("settings persist across restart and public reads never expose keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-settings-")),
    file = join(dir, "settings.sqlite");
  let store;
  try {
    store = new Store(file);
    let settings = new ModelSettings({
      store,
      defaults: environmentSettings({}),
    });
    const input = draft(settings);
    input.mode = "live";
    input.llm.apiKey = "private-llm-key";
    input.image.apiKey = "private-image-key";
    input.llm.model = "custom-llm";
    input.image.model = "custom-image";
    const result = settings.save(input);
    assert.equal(result.llm.hasKey, true);
    assert.equal(result.image.hasKey, true);
    assert.ok(!JSON.stringify(result).includes("private-"));
    store.close();
    store = new Store(file);
    settings = new ModelSettings({
      store,
      defaults: environmentSettings({ PROVIDER: "demo" }),
    });
    assert.equal(settings.current().mode, "live");
    assert.equal(settings.current().llm.apiKey, "private-llm-key");
    assert.equal(settings.public().image.model, "custom-image");
    assert.equal(settings.public().source, "saved");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("blank keys preserve saved credentials, explicit clear removes them, and new origins do not inherit keys", (t) => {
  const { settings } = fixture(t, {
    defaults: environmentSettings({
      LLM_API_KEY: "old-secret",
      IMAGE_API_KEY: "image-secret",
    }),
  });
  let input = draft(settings);
  input.llm.model = "new-model";
  settings.save(input);
  assert.equal(settings.current().llm.apiKey, "old-secret");
  input = draft(settings);
  input.llm.baseUrl = "https://another-provider.example/v1";
  settings.save(input);
  assert.equal(settings.current().llm.apiKey, "");
  assert.equal(settings.current().image.apiKey, "image-secret");
  input = draft(settings);
  input.llm.apiKey = "replacement";
  input.image.clearKey = true;
  settings.save(input);
  assert.equal(settings.current().llm.apiKey, "replacement");
  assert.equal(settings.public().image.hasKey, false);
});
test("invalid URLs, unsupported protocol, malformed keys and stale revisions are rejected before saving", (t) => {
  const { settings } = fixture(t);
  let input = draft(settings);
  input.llm.baseUrl = "https://user:secret@example.com/v1";
  assert.throws(() => settings.save(input), /用户名/);
  input = draft(settings);
  input.llm.baseUrl = "http://remote.example/v1";
  assert.throws(() => settings.save(input), /HTTPS/);
  input = draft(settings);
  input.llm.apiStyle = "unsupported";
  assert.throws(() => settings.save(input), /协议/);
  input = draft(settings);
  input.image.apiKey = "key\nheader";
  assert.throws(() => settings.save(input), /换行/);
  input = draft(settings);
  const stale = structuredClone(input);
  settings.save(input);
  assert.throws(() => settings.save(stale), /其他窗口/);
});
test("connection checks use unsaved draft and only selected provider, never persist it", async (t) => {
  const calls = [];
  const { settings } = fixture(t, {
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        data: [{ id: "available-model" }, { id: "another" }],
      });
    },
  });
  const input = draft(settings);
  input.llm.baseUrl = "https://llm.example/v1";
  input.llm.model = "available-model";
  input.llm.apiKey = "llm-key";
  input.image.baseUrl = "https://images.example/v1";
  input.image.apiKey = "image-key";
  input.image.model = "missing-model";
  let result = await settings.test(input, "llm");
  assert.equal(result.modelFound, true);
  assert.equal(calls[0].url, "https://llm.example/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer llm-key");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.redirect, "error");
  result = await settings.test(input, "image");
  assert.equal(result.connected, true);
  assert.equal(result.modelFound, false);
  assert.equal(calls[1].options.headers.Authorization, "Bearer image-key");
  assert.equal(settings.public().revision, "environment");
  assert.equal(settings.public().llm.hasKey, false);
});
test("connection errors do not echo secret-bearing upstream response bodies", async (t) => {
  const { settings } = fixture(t, {
    fetchFn: async () =>
      new Response("private upstream secret-key", { status: 401 }),
  });
  const input = draft(settings);
  input.llm.apiKey = "secret-key";
  await assert.rejects(
    () => settings.test(input, "llm"),
    (error) =>
      error.message.includes("401") && !error.message.includes("secret-key"),
  );
  settings.fetch = async () => new Response("not json");
  await assert.rejects(() => settings.test(input, "llm"), /JSON/);
  settings.fetch = async () => new Response("", { status: 404 });
  await assert.rejects(() => settings.test(input, "llm"), /未提供/);
});
test("hot config updates affect new jobs, while running and queued jobs retain their submitted provider", async (t) => {
  const store = new Store(":memory:");
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const calls = [];
  const settings = new ModelSettings({
    store,
    defaults: environmentSettings({ LLM_MODEL: "old-model" }),
    providerFactory: (config) => ({
      name: config.mode === "demo" ? "demo" : "openai",
      apiKey: config.llm.apiKey,
      async interpret() {
        return {
          understanding: "test",
          suitability: "ready",
          adaptedInstruction: "画一张图",
          changes: [],
          uncertainties: [],
        };
      },
      async plan() {
        calls.push(`plan:${config.llm.model}`);
        await gate;
        return {
          title: "test",
          summary: "test",
          prompt: "test",
          renderer: "svg",
        };
      },
      async generate() {
        calls.push(`generate:${config.llm.model}`);
        return { mime: "image/svg+xml", data: Buffer.from("<svg/>") };
      },
    }),
  });
  const app = createApp({ store, settings });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    release();
    await app.drain();
    await new Promise((r) => app.server.close(r));
    store.close();
  });
  const root = `http://127.0.0.1:${app.server.address().port}`,
    project = store.createProject("P");
  const submit = async () => {
    const r = await fetch(root + `/api/projects/${project.id}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "画一张图",
        mode: "new",
        assetIds: [],
      }),
    });
    return r.json();
  };
  const old = [];
  for (let i = 0; i < 3; i++) old.push(await submit());
  await app.drain();
  const approve = async (id) => {
    const review = store.job(id).plan.review;
    const res = await fetch(`${root}/api/jobs/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewRevision: review.revision,
        instruction: review.adaptedInstruction,
      }),
    });
    assert.equal(res.status, 202);
  };
  for (const job of old) await approve(job.id);
  const input = draft(settings);
  input.mode = "live";
  input.llm.model = "new-model";
  input.llm.apiKey = "runtime-key";
  const response = await fetch(root + "/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes("runtime-key"));
  const health = await (await fetch(root + "/api/health")).json();
  assert.equal(health.provider, "openai");
  assert.equal(health.ready, true);
  const fresh = await submit();
  release();
  await app.drain();
  await approve(fresh.id);
  await app.drain();
  assert.equal(calls.filter((v) => v === "generate:old-model").length, 3);
  assert.equal(calls.filter((v) => v === "generate:new-model").length, 1);
  assert.ok(
    old.every((j) => store.job(j.id).plan.configRevision === "environment"),
  );
  assert.notEqual(store.job(fresh.id).plan.configRevision, "environment");
});
