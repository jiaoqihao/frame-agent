import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { retrieveMemory, memorySnapshot } from "../server/memory.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider, OpenAIProvider } from "../server/providers.mjs";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const baseRequest = {
  mode: "new",
  instruction: "森林中的机器人",
  assetIds: [],
  autoMemory: true,
};
function setup(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}
async function serverFixture(t, provider = new DemoProvider()) {
  const store = new Store(":memory:");
  const app = createApp({ store, provider });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.drain();
    await new Promise((r) => app.server.close(r));
    store.close();
  });
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, method = "POST", headers = {}) => {
    const response = await fetch(root + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, app, root, request };
}

test("project memory never crosses project boundaries", (t) => {
  const s = setup(t),
    a = s.createProject("A"),
    b = s.createProject("B");
  const secret = s.createAsset(b.id, {
    kind: "text",
    title: "机器人",
    content: "森林机器人角色设定",
  });
  s.pinAsset(secret.id, true);
  assert.equal(retrieveMemory(s, a.id, baseRequest).length, 0);
  assert.throws(
    () => retrieveMemory(s, a.id, { ...baseRequest, assetIds: [secret.id] }),
    /不属于/,
  );
});
test("pinned memory persists with automatic retrieval off; unrelated items are excluded", (t) => {
  const s = setup(t),
    p = s.createProject("P");
  const pinned = s.createAsset(p.id, {
    kind: "text",
    title: "角色",
    content: "橙色围巾",
  });
  s.pinAsset(pinned.id, true);
  const relevant = s.createAsset(p.id, {
    kind: "text",
    title: "森林",
    content: "森林中的机器人",
  });
  s.createAsset(p.id, { kind: "text", title: "咖啡", content: "意式浓缩" });
  const auto = retrieveMemory(s, p.id, baseRequest);
  assert.equal(auto.length, 2);
  assert.equal(auto[0].asset.id, pinned.id);
  assert.equal(auto[1].asset.id, relevant.id);
  assert.deepEqual(
    retrieveMemory(s, p.id, { ...baseRequest, autoMemory: false }).map(
      (x) => x.asset.id,
    ),
    [pinned.id],
  );
});
test("edit preserves original as first image and prioritizes explicit selections", (t) => {
  const s = setup(t),
    p = s.createProject("P");
  const original = s.createAsset(p.id, {
    kind: "generated",
    title: "角色原图",
    mime: "image/png",
    data: Buffer.from(png, "base64"),
  });
  const selected = s.createAsset(p.id, {
    kind: "text",
    title: "新场景",
    content: "雪山",
  });
  for (let i = 0; i < 8; i++) {
    const a = s.createAsset(p.id, {
      kind: "text",
      title: `参考${i}`,
      content: "长期约束",
    });
    s.pinAsset(a.id, true);
  }
  const refs = retrieveMemory(s, p.id, {
    ...baseRequest,
    mode: "edit",
    baseAssetId: original.id,
    assetIds: [selected.id],
  });
  assert.equal(refs.length, 6);
  assert.equal(refs[0].asset.id, original.id);
  assert.equal(refs[1].asset.id, selected.id);
  assert.throws(
    () =>
      retrieveMemory(s, p.id, {
        ...baseRequest,
        mode: "edit",
        baseAssetId: selected.id,
      }),
    /历史图片/,
  );
});
test("fuse requires at least two usable references and rejects more than six explicit inputs", (t) => {
  const s = setup(t),
    p = s.createProject("P");
  assert.throws(
    () => retrieveMemory(s, p.id, { ...baseRequest, mode: "fuse" }),
    /至少/,
  );
  assert.throws(
    () =>
      retrieveMemory(s, p.id, {
        ...baseRequest,
        assetIds: ["1", "2", "3", "4", "5", "6", "7"],
      }),
    /最多/,
  );
});
test("continuation language retrieves the last image, while an unrelated new task does not", (t) => {
  const s = setup(t),
    p = s.createProject("P");
  const a = s.createAsset(p.id, {
    kind: "generated",
    title: "机器人",
    content: "白色机器人，橙色围巾",
    mime: "image/png",
    data: Buffer.from(png, "base64"),
  });
  const continued = retrieveMemory(s, p.id, {
    ...baseRequest,
    instruction: "沿用上次的角色，放进森林",
  });
  assert.equal(continued[0].asset.id, a.id);
  assert.equal(continued[0].reason, "延续最近一次创作");
  assert.equal(
    retrieveMemory(s, p.id, { ...baseRequest, instruction: "一杯咖啡" }).length,
    0,
  );
  assert.equal(
    retrieveMemory(s, p.id, {
      ...baseRequest,
      instruction: "沿用上次角色",
      autoMemory: false,
    }).length,
    0,
  );
});
test("stored project, assets and jobs survive database reopen; interrupted jobs recover", () => {
  const dir = mkdtempSync(join(tmpdir(), "frame-test-"));
  let s;
  try {
    const file = join(dir, "test.sqlite");
    s = new Store(file);
    const p = s.createProject("持久记忆");
    const a = s.createAsset(p.id, {
      kind: "text",
      title: "角色",
      content: "围巾",
    });
    s.pinAsset(a.id, true);
    const j = s.createJob(p.id, baseRequest);
    s.close();
    s = new Store(file);
    s.recoverJobs();
    assert.equal(s.project(p.id).name, "持久记忆");
    assert.equal(s.asset(a.id).pinned, 1);
    assert.equal(s.job(j.id).status, "failed");
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("full API workflow: create, capture, pin, generate, edit and inspect immutable snapshot", async (t) => {
  const { request, store, app, root } = await serverFixture(t);
  const p = (await request("/api/projects", { name: "森林机器人" })).body;
  const a = (
    await request(`/api/projects/${p.id}/assets`, {
      kind: "text",
      title: "角色设定",
      content: "机器人佩戴橙色围巾",
      source: "https://example.com/story",
    })
  ).body;
  assert.equal(
    (await request(`/api/assets/${a.id}`, { pinned: true }, "PATCH")).status,
    200,
  );
  const created = await request(`/api/projects/${p.id}/jobs`, baseRequest);
  assert.equal(created.status, 202);
  await app.drain();
  const job = (await request(`/api/jobs/${created.body.id}`)).body;
  assert.equal(job.status, "completed");
  assert.equal(job.plan.snapshot.references[0].id, a.id);
  assert.equal(job.plan.provider, "demo");
  const savedStyle = job.plan.snapshot.settings.style;
  await request(
    `/api/projects/${p.id}`,
    { name: p.name, settings: { ...p.settings, style: "水彩" } },
    "PATCH",
  );
  assert.equal(store.job(job.id).plan.snapshot.settings.style, savedStyle);
  assert.equal(store.project(p.id).settings.style, "水彩");
  const image = await fetch(
    `${root}/api/assets/${job.result_asset_id}/image?download=1`,
  );
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-disposition"), /attachment/);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(
    Buffer.from(await image.arrayBuffer())
      .subarray(0, 8)
      .toString("hex"),
    "89504e470d0a1a0a",
  );
  const next = (
    await request(`/api/projects/${p.id}/jobs`, {
      ...baseRequest,
      mode: "edit",
      baseAssetId: job.result_asset_id,
      instruction: "保持机器人，添加雪山",
    })
  ).body;
  await app.drain();
  const edited = store.job(next.id);
  assert.equal(edited.status, "completed");
  assert.equal(edited.plan.snapshot.references[0].id, job.result_asset_id);
  assert.equal(
    edited.plan.snapshot.recentTurns[0].instruction,
    baseRequest.instruction,
  );
  assert.equal(store.jobs(p.id).length, 2);
});
test("input validation rejects forged images, missing original, cross-project assets and hostile origins", async (t) => {
  const { request } = await serverFixture(t);
  const p = (await request("/api/projects", { name: "P" })).body;
  assert.equal((await request("/api/projects", { name: " " })).status, 400);
  assert.equal(
    (
      await request(`/api/projects/${p.id}/assets`, {
        kind: "image",
        title: "x",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/projects/${p.id}/jobs`, {
        ...baseRequest,
        mode: "edit",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/projects/${p.id}/jobs`, {
        ...baseRequest,
        assetIds: ["missing"],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/projects", undefined, "GET", {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/projects/${p.id}/assets`, {
        kind: "image",
        title: "valid png",
        dataUrl: `data:image/png;base64,${png}`,
      })
    ).status,
    201,
  );
});
test("a failed provider produces a recoverable failed job without fake generated assets", async (t) => {
  const provider = {
    name: "test",
    plan: async () => {
      throw new Error("测试网络错误");
    },
  };
  const { request, store, app } = await serverFixture(t, provider);
  const p = (await request("/api/projects", { name: "P" })).body;
  const j = (await request(`/api/projects/${p.id}/jobs`, baseRequest)).body;
  await app.drain();
  assert.equal(store.job(j.id).status, "failed");
  assert.match(store.job(j.id).error, /网络错误/);
  assert.equal(store.assets(p.id).length, 0);
});
test("OpenAI adapter sends actual images to understanding and multipart editing in original order", async (t) => {
  const s = setup(t),
    p = s.createProject("P");
  const a = s.createAsset(p.id, {
    kind: "image",
    title: "角色",
    mime: "image/png",
    data: Buffer.from(png, "base64"),
  });
  const b = s.createAsset(p.id, {
    kind: "image",
    title: "森林",
    mime: "image/png",
    data: Buffer.from(png, "base64"),
  });
  const refs = [
      { asset: a, reason: "原图" },
      { asset: b, reason: "场景" },
    ],
    snapshot = memorySnapshot(p, refs),
    calls = [];
  const expected = {
    title: "新图",
    summary: "保持角色",
    prompt: "机器人在森林",
    preserved: ["围巾"],
    changes: ["森林"],
  };
  const provider = new OpenAIProvider({
    apiKey: "test-only",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        url.endsWith("/responses")
          ? {
              output: [
                {
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(
                        calls.length === 1
                          ? expected
                          : {
                              intent: "角色配图",
                              scene: "森林",
                              subject: "机器人",
                              composition: "机器人位于前景",
                              appearance: "编辑插画",
                              lighting: "柔和日光",
                              text: [],
                              references: [
                                {
                                  imageIndex: 1,
                                  role: "原图",
                                  use: "保留机器人",
                                },
                                {
                                  imageIndex: 2,
                                  role: "场景",
                                  use: "参考森林",
                                },
                              ],
                              preserve: ["围巾"],
                              changes: ["森林"],
                              constraints: [],
                            },
                      ),
                    },
                  ],
                },
              ],
            }
          : { data: [{ b64_json: png }] },
      );
    },
  });
  const plan = await provider.plan({
    request: { ...baseRequest, mode: "edit" },
    snapshot,
    references: refs,
  });
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(
    payload.input[0].content.filter((x) => x.type === "input_image").length,
    2,
  );
  assert.equal(payload.text.format.strict, true);
  const image = await provider.generate({ plan, snapshot, references: refs });
  assert.ok(calls[2].url.endsWith("/images/edits"));
  assert.equal(calls[2].options.body.getAll("image[]").length, 2);
  assert.equal(calls[2].options.body.getAll("image[]")[0].name, `${a.id}.png`);
  assert.equal(calls[2].options.body.get("size"), "1536x1024");
  assert.equal(calls[2].options.body.get("prompt"), plan.prompt);
  assert.equal(image.mime, "image/png");
});
test("OpenAI adapter uses generation without references and surfaces actionable errors", async () => {
  let path = "";
  const p = new OpenAIProvider({
    apiKey: "test",
    fetchFn: async (url) => {
      path = url;
      return Response.json({ data: [{ b64_json: png }] });
    },
  });
  await p.generate({
    plan: { prompt: "forest" },
    snapshot: { settings: { ratio: "1:1" } },
    references: [],
  });
  assert.ok(path.endsWith("/images/generations"));
  const bad = new OpenAIProvider({
    apiKey: "secret-not-disclosed",
    fetchFn: async () =>
      new Response("sensitive upstream response", { status: 429 }),
  });
  await assert.rejects(
    () =>
      bad.generate({
        plan: { prompt: "x" },
        snapshot: { settings: {} },
        references: [],
      }),
    /429.*额度/,
  );
  await assert.rejects(
    () => new OpenAIProvider({}).call("/responses", {}),
    /OPENAI_API_KEY/,
  );
});
