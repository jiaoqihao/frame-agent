import test from "node:test";
import assert from "node:assert/strict";
import { routeByRules, resolveRoute } from "../server/routing.mjs";
import { validateSvg, svgToPng, svgSkill } from "../server/svg.mjs";
import { OpenAIProvider, DemoProvider } from "../server/providers.mjs";
import { ImageAPI } from "../server/image-api.mjs";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><title>流程</title><rect x="40" y="40" width="400" height="100" fill="#254e3c"/><text x="60" y="100" font-size="28" fill="white">输入 → 分析 → 输出</text></svg>';
const request = {
  instruction: "绘制流程图：输入→分析→输出",
  mode: "new",
  assetIds: [],
};
const snapshot = {
  settings: { ratio: "3:2", style: "简洁", palette: "绿色" },
  references: [],
  recentTurns: [],
};
const plan = {
  title: "流程图",
  summary: "清晰表达步骤",
  prompt: "输入、分析、输出三个节点",
  preserved: [],
  changes: [],
  renderer: "svg",
  routeReason: "结构化流程",
};
const output = (text) =>
  Response.json({ output: [{ content: [{ type: "output_text", text }] }] });

test("routing distinguishes diagrams about people from portraits and landscapes", () => {
  const cases = [
    ["人物关系图", "svg"],
    ["机器人工作流程图", "svg"],
    ["季度销量柱状图", "svg"],
    ["绘制 SVG 图标", "svg"],
    ["一位老人的写实肖像", "image_api"],
    ["森林日落风景", "image_api"],
    ["photograph of a mountain", "image_api"],
  ];
  for (const [instruction, renderer] of cases)
    assert.equal(
      routeByRules({ request: { instruction } }).renderer,
      renderer,
      instruction,
    );
  assert.equal(routeByRules({ request: { instruction: "做一张图" } }), null);
  assert.equal(
    resolveRoute(
      { request: { instruction: "做一张图" } },
      { ...plan, renderer: "svg" },
    ).routeSource,
    "model",
  );
  assert.equal(
    resolveRoute({ request }, { ...plan, renderer: "image_api" }).renderer,
    "svg",
    "clear chart rules constrain model route",
  );
});
test("editing SVG keeps the original renderer and allows explicit scene conversion", () => {
  const refs = [
    { asset: { id: "base", mime: "image/svg+xml", data: Buffer.from(SVG) } },
  ];
  assert.equal(
    routeByRules({
      request: {
        mode: "edit",
        baseAssetId: "base",
        instruction: "把标题改为蓝色",
      },
      references: refs,
    }).renderer,
    "svg",
  );
  assert.equal(
    routeByRules({
      request: {
        mode: "edit",
        baseAssetId: "base",
        instruction: "改成写实森林照片",
      },
      references: refs,
    }).renderer,
    "image_api",
  );
});
test("valid SVG can render while active content, remote links, malformed XML and oversized canvases fail", () => {
  assert.match(validateSvg(SVG), /<title>流程/);
  assert.ok(svgToPng(SVG).length > 100);
  const invalid = [
    SVG.replace("</svg>", "<script>alert(1)</script></svg>"),
    SVG.replace("<rect", '<rect onclick="alert(1)"'),
    SVG.replace('fill="#254e3c"', 'fill="url(https://evil.example/x)"'),
    SVG.replace("<rect", '<image href="https://evil.example"'),
    SVG.replace('width="1200"', 'width="99999"'),
    SVG.replace("</text>", ""),
    `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${SVG}`,
  ];
  for (const value of invalid) assert.throws(() => validateSvg(value));
});
test("SVG generation actually loads the skill, repairs invalid output once and never calls image API", async () => {
  const calls = [];
  let imageCalls = 0;
  const provider = new OpenAIProvider({
    apiKey: "llm-secret",
    imageApi: {
      generate: async () => {
        imageCalls++;
      },
    },
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (body.text?.format)
        return output(
          JSON.stringify(
            body.text.format.schema?.properties?.passed
              ? { passed: true, issues: [] }
              : plan,
          ),
        );
      return output(
        calls.length === 2
          ? SVG.replace("</svg>", "<script>x</script></svg>")
          : SVG,
      );
    },
  });
  const context = { request, snapshot, references: [] };
  const chosen = await provider.plan(context);
  const image = await provider.generateFreeSvg({ ...context, plan: chosen });
  assert.equal(chosen.renderer, "svg");
  assert.equal(imageCalls, 0);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].body.instructions, svgSkill);
  assert.match(calls[2].body.input[0].content.at(-1).text, /修复/);
  assert.equal(image.mime, "image/svg+xml");
  assert.match(image.data.toString(), /输入 → 分析/);
});
test("SVG repair is bounded and fails without silently switching to a paid image model", async () => {
  let calls = 0;
  const p = new OpenAIProvider({
    apiKey: "x",
    fetchFn: async () => {
      calls++;
      return output("<script>bad</script>");
    },
  });
  await assert.rejects(
    () => p.generateFreeSvg({ request, plan, snapshot, references: [] }),
    /修复两次/,
  );
  assert.equal(calls, 3);
});
test("SVG edits include original source and project memory in the model input", async () => {
  let payload;
  const p = new OpenAIProvider({
    apiKey: "x",
    fetchFn: async (u, o) => {
      const body = JSON.parse(o.body);
      if (body.text?.format)
        return output(JSON.stringify({ passed: true, issues: [] }));
      payload = body;
      return output(SVG);
    },
  });
  await p.generateFreeSvg({
    request: { ...request, mode: "edit", baseAssetId: "a" },
    plan,
    snapshot,
    references: [
      { asset: { id: "a", mime: "image/svg+xml", data: Buffer.from(SVG) } },
    ],
  });
  const content = payload.input[0].content;
  assert.match(content[0].text, /简洁/);
  assert.match(content[1].text, /输入 → 分析 → 输出/);
});
test("third-party image service uses its own endpoint/key and receives rasterized SVG references", async () => {
  const calls = [],
    png = svgToPng(SVG);
  const imageApi = new ImageAPI({
    apiKey: "image-secret",
    baseUrl: "https://images.example/v1",
    model: "third-party-image",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  const p = new OpenAIProvider({ apiKey: "llm-secret", imageApi });
  const image = await p.generate({
    plan: { ...plan, renderer: "image_api" },
    snapshot,
    references: [
      { asset: { id: "svg", mime: "image/svg+xml", data: Buffer.from(SVG) } },
    ],
  });
  assert.equal(calls[0].url, "https://images.example/v1/images/edits");
  assert.equal(calls[0].options.headers.Authorization, "Bearer image-secret");
  assert.equal(calls[0].options.body.get("model"), "third-party-image");
  assert.equal(calls[0].options.body.get("image[]").type, "image/png");
  assert.equal(image.mime, "image/png");
});
test("image URL download requires an allowed HTTPS host and never forwards API authorization", async () => {
  const png = svgToPng(SVG);
  let downloads = 0;
  const provider = new ImageAPI({
    apiKey: "x",
    baseUrl: "https://images.example/v1",
    downloadHosts: ["cdn.example"],
    fetchFn: async (url, options) => {
      if (String(url).includes("cdn.example")) {
        downloads++;
        assert.equal(options.headers, undefined);
        return new Response(png);
      }
      return Response.json({
        data: [{ url: "https://cdn.example/result.png" }],
      });
    },
  });
  await provider.generate({ plan, snapshot, references: [] });
  assert.equal(downloads, 1);
  provider.downloadHosts = [];
  await assert.rejects(
    () => provider.generate({ plan, snapshot, references: [] }),
    /域名未允许/,
  );
});
test("a chat-compatible language model supports structured routing and raw SVG output", async () => {
  const calls = [];
  const p = new OpenAIProvider({
    apiKey: "x",
    llmApiStyle: "chat",
    fetchFn: async (url, o) => {
      calls.push({ url, body: JSON.parse(o.body) });
      return Response.json({
        choices: [
          {
            message: {
              content:
                calls.length === 1
                  ? JSON.stringify(plan)
                  : calls.length === 2
                    ? SVG
                    : JSON.stringify({ passed: true, issues: [] }),
            },
          },
        ],
      });
    },
  });
  const context = { request, snapshot, references: [] };
  const actual = await p.plan(context);
  await p.generateFreeSvg({ ...context, plan: actual });
  assert.ok(calls.every((c) => c.url.endsWith("/chat/completions")));
  assert.equal(calls[0].body.response_format.type, "json_schema");
  assert.equal(calls[1].body.messages[0].content, svgSkill);
});
test("right-click endpoint creates a project, routes charts to SVG, and makes retries idempotent", async (t) => {
  const store = new Store(":memory:"),
    app = createApp({ store, provider: new DemoProvider() });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.drain();
    await new Promise((r) => app.server.close(r));
    store.close();
  });
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const submit = async (body) => {
    const response = await fetch(root + "/api/quick-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const input = {
    requestId: "request-chart-001",
    selectionText: "季度销量柱状图：一月:20，二月:35，三月:50",
    source: "https://example.com/article",
  };
  const first = await submit(input);
  assert.equal(first.status, 202);
  await app.drain();
  const approve = async (id) => {
    const review = store.job(id).plan.review;
    const response = await fetch(`${root}/api/jobs/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewRevision: review.revision,
        instruction: review.adaptedInstruction,
      }),
    });
    assert.equal(response.status, 202);
    await app.drain();
  };
  await approve(first.data.job.id);
  const job = store.job(first.data.job.id);
  assert.equal(job.plan.renderer, "svg");
  assert.equal(job.plan.skill, "svg-drawing");
  assert.equal(store.projects().length, 1);
  assert.match(
    Buffer.from(store.asset(job.result_asset_id).data).toString(),
    />35<\/text>/,
  );
  const again = await submit(input);
  assert.equal(again.status, 200);
  assert.equal(again.data.job.id, job.id);
  assert.equal(store.jobs(job.project_id).length, 1);
  assert.equal(store.assets(job.project_id).length, 2);
  assert.equal(
    (await submit({ ...input, selectionText: "另一个任务" })).status,
    409,
  );
  const other = store.createProject("另一个项目");
  const next = await submit({
    ...input,
    requestId: "request-scenery-2",
    projectId: other.id,
    selectionText: "阳光下的人物肖像，背景是森林风景",
  });
  await app.drain();
  await approve(next.data.job.id);
  assert.equal(store.job(next.data.job.id).plan.renderer, "image_api");
  assert.equal(store.job(next.data.job.id).plan.snapshot.recentTurns.length, 0);
  const service = await (await fetch(root)).json();
  assert.equal(service.service, "Frame browser extension agent");
});

test("DeepSeek uses JSON mode for planning and raw SVG with project memory for drawing", async () => {
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    plannerModel: "deepseek-flash",
    llmApiStyle: "chat",
    imageApi: {
      generate() {
        throw new Error("Unexpected image API call");
      },
    },
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.redirect, "error");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: body.response_format
                ? JSON.stringify(
                    calls.length === 1 ? plan : { passed: true, issues: [] },
                  )
                : SVG,
            },
          },
        ],
      });
    },
  });
  const context = { request, snapshot, references: [] };
  const actual = await provider.plan(context);
  const image = await provider.generateFreeSvg({ ...context, plan: actual });
  assert.equal(provider.name, "deepseek");
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.match(calls[0].messages[0].content, /JSON Schema.*"required"/);
  assert.match(calls[0].messages[0].content, /格式示例/);
  assert.equal(calls[0].thinking.type, "disabled");
  assert.equal(calls[1].response_format, undefined);
  assert.equal(calls[1].messages[0].content, svgSkill);
  assert.match(calls[1].messages[1].content[0].text, /简洁/);
  assert.equal(image.mime, "image/svg+xml");
});

test("DeepSeek invalid plans and truncated output fail before generating an image", async () => {
  for (const [content, finishReason, error] of [
    ['{"title":"missing fields"}', "stop", /字段不完整/],
    ["{", "stop", /有效的绘图方案/],
    [JSON.stringify(plan), "length", /长度上限/],
  ]) {
    const provider = new OpenAIProvider({
      apiKey: "test-only",
      baseUrl: "https://api.deepseek.com/v1",
      llmApiStyle: "chat",
      fetchFn: async () =>
        Response.json({
          choices: [{ finish_reason: finishReason, message: { content } }],
        }),
    });
    await assert.rejects(
      () => provider.plan({ request, snapshot, references: [] }),
      error,
    );
  }
});
