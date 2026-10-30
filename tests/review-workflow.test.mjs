import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider, OpenAIProvider } from "../server/providers.mjs";
import { reviewSkill } from "../server/source-review.mjs";

const review = {
  understanding: "原文讲的是检索和回答之间的关系，检索不能保证答案正确。",
  suitability: "needs_adaptation",
  adaptedInstruction:
    "绘制检索流程示意图：提出问题 → 检索资料 → 结合资料回答；标注仍需核实答案。",
  changes: ["将抽象论述转成三个步骤", "保留仍需核实的限制"],
  uncertainties: [],
};
async function fixture(t) {
  const store = new Store(":memory:"),
    provider = new DemoProvider();
  const calls = { interpret: [], plan: [], generate: [] };
  provider.interpret = async (context) => {
    calls.interpret.push(context);
    return structuredClone(review);
  };
  const plan = provider.plan.bind(provider),
    generate = provider.generate.bind(provider);
  provider.plan = async (context) => {
    calls.plan.push(context);
    return plan(context);
  };
  provider.generate = async (context) => {
    calls.generate.push(context);
    return generate(context);
  };
  const app = createApp({ store, provider });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.drain();
    await new Promise((r) => app.server.close(r));
    store.close();
  });
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(root + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { store, app, calls, post };
}
test("selected prose requires durable review; only approved edits reach generation and duplicate approvals are idempotent", async (t) => {
  const { store, app, calls, post } = await fixture(t);
  const { data } = await post("/api/quick-generate", {
    requestId: "review-test-001",
    selectionText: "检索增强生成使用外部资料，但不保证答案一定正确。",
  });
  await app.drain();
  let job = store.job(data.job.id);
  assert.equal(job.status, "awaiting_review");
  assert.equal(calls.plan.length, 0);
  assert.equal(calls.generate.length, 0);
  assert.equal(
    store.assets(job.project_id).filter((a) => a.kind === "generated").length,
    0,
  );
  store.recoverJobs();
  job = store.job(job.id);
  assert.equal(job.status, "awaiting_review");
  const originalSettings = job.plan.snapshot.settings;
  const p = store.project(job.project_id);
  store.updateProject(p.id, p.name, { ...p.settings, style: "later" });
  assert.equal(
    (
      await post(`/api/jobs/${job.id}/approve`, {
        reviewRevision: "stale",
        instruction: "x",
      })
    ).status,
    409,
  );
  const body = {
    reviewRevision: job.plan.review.revision,
    instruction: "流程图：检索 → 核验 → 回答。明确标出人工核验步骤。",
  };
  const approvals = await Promise.all([
    post(`/api/jobs/${job.id}/approve`, body),
    post(`/api/jobs/${job.id}/approve`, body),
  ]);
  assert.ok(approvals.every((r) => [200, 202].includes(r.status)));
  await app.drain();
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.plan[0].request.instruction, body.instruction);
  assert.equal(calls.plan[0].request.selectionText, undefined);
  assert.deepEqual(calls.plan[0].snapshot.settings, originalSettings);
  job = store.job(job.id);
  assert.equal(job.status, "completed");
  assert.match(job.request.selectionText, /不保证/);
  assert.equal(job.plan.review.approvedInstruction, body.instruction);
  assert.equal(
    (
      await post(`/api/jobs/${job.id}/approve`, {
        ...body,
        instruction: "篡改已批准内容",
      })
    ).status,
    409,
  );
});
test("cancelling review cannot create an image or be approved later", async (t) => {
  const { store, app, calls, post } = await fixture(t);
  const p = store.createProject("cancel");
  const { data } = await post(`/api/projects/${p.id}/jobs`, {
    instruction: "复杂段落",
    mode: "new",
    assetIds: [],
    approvedAt: "forged",
  });
  await app.drain();
  const revision = store.job(data.id).plan.review.revision;
  assert.equal(
    (await post(`/api/jobs/${data.id}/cancel`, { reviewRevision: revision }))
      .status,
    200,
  );
  assert.equal(
    (
      await post(`/api/jobs/${data.id}/approve`, {
        reviewRevision: revision,
        instruction: "画图",
      })
    ).status,
    409,
  );
  assert.equal(calls.generate.length, 0);
});
test("screenshot understanding receives actual image bytes and structured explanation without calling an image endpoint", async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: "test",
    fetchFn: async (url, options) => {
      assert.ok(url.endsWith("/responses"));
      calls.push(JSON.parse(options.body));
      return Response.json({
        output: [
          { content: [{ type: "output_text", text: JSON.stringify(review) }] },
        ],
      });
    },
  });
  const result = await provider.interpret({
    request: { instruction: "解释这张截图并配图", mode: "new" },
    snapshot: { settings: {}, references: [] },
    references: [
      {
        asset: {
          id: "screenshot",
          title: "截图",
          mime: "image/png",
          data: Buffer.from("actual-test-image"),
        },
      },
    ],
  });
  assert.equal(result.understanding, review.understanding);
  assert.equal(calls[0].instructions, reviewSkill);
  assert.equal(
    calls[0].input[0].content.find((c) => c.type === "input_image").image_url,
    `data:image/png;base64,${Buffer.from("actual-test-image").toString("base64")}`,
  );
  assert.equal(calls.length, 1);
});
test("invalid understanding gets one repair and never silently uses the raw text", async () => {
  const provider = new OpenAIProvider({ apiKey: "test" });
  let count = 0;
  provider.complete = async () => {
    count++;
    return '{"understanding":"incomplete"}';
  };
  await assert.rejects(
    provider.interpret({
      request: { instruction: "原文" },
      snapshot: {},
      references: [],
    }),
    /缺少/,
  );
  assert.equal(count, 2);
});
