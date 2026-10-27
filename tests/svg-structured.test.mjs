import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "../server/svg-spec.mjs";
import { renderStructuredSvg } from "../server/svg-renderer.mjs";
import { withRenderPage, inspectSvg } from "../server/svg-browser.mjs";
import { OpenAIProvider } from "../server/providers.mjs";
import { Store } from "../server/store.mjs";
const request = {
  instruction: "总人口140545万人，男性71722万人，女性68823万人",
};
const context = {
  request,
  snapshot: { settings: { ratio: "3:2" }, references: [], recentTurns: [] },
  references: [],
};
const spec = {
  kind: "composition",
  title: "全国人口构成",
  subtitle: "",
  source: "",
  unit: "万人",
  totalLabel: "总人口",
  total: 140545,
  totalEvidence: "总人口140545万人",
  theme: "forest",
  items: [
    { label: "男性", description: "", value: 71722, evidence: "男性71722万人" },
    { label: "女性", description: "", value: 68823, evidence: "女性68823万人" },
  ],
};
const output = (text) =>
  Response.json({ output: [{ content: [{ type: "output_text", text }] }] });
test("quantitative specifications reject unsupported values, totals, percentages and duplicate labels", () => {
  assert.deepEqual(validateSpec(spec, context), spec);
  for (const edit of [
    (s) => (s.items[0].value = 5),
    (s) => (s.total = 71722),
    (s) => (s.items[1].label = "男性"),
    (s) => (s.unit = "%"),
  ]) {
    const s = structuredClone(spec);
    edit(s);
    assert.throws(() => validateSpec(s, context));
  }
  const negative = {
    ...spec,
    total: null,
    items: [
      { ...spec.items[0], value: -1, evidence: "男性-1" },
      { ...spec.items[1], value: 2, evidence: "女性2" },
    ],
  };
  assert.throws(
    () =>
      validateSpec(negative, {
        ...context,
        request: { instruction: "男性-1 女性2" },
      }),
    /负数/,
  );
});
test("SVG geometry cannot serve as data evidence; saved specifications can", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="71722"/><text>女性68823万人</text></svg>';
  const edit = {
    ...context,
    request: { instruction: "改成蓝色" },
    references: [{ asset: { mime: "image/svg+xml", data: Buffer.from(svg) } }],
  };
  assert.throws(() => validateSpec(spec, edit), /原文/);
  edit.references[0].asset.svgSpec = spec;
  assert.deepEqual(validateSpec(spec, edit), spec);
});
test("invalid structured data has two repairs and cannot escape through free SVG", async () => {
  let calls = 0;
  const p = new OpenAIProvider({
    apiKey: "test",
    fetchFn: async () => {
      calls++;
      return output(
        JSON.stringify(
          calls === 1
            ? { ...spec, total: 7 }
            : { ...spec, kind: "free", total: null, items: [] },
        ),
      );
    },
  });
  await assert.rejects(
    () => p.generateSvg({ ...context, plan: { renderer: "svg" } }),
    /两次.*不能切换/,
  );
  assert.equal(calls, 3);
});
test("all seven engines render portable Chinese SVG in landscape and portrait", async () => {
  for (const kind of [
    "composition",
    "donut",
    "bar",
    "line",
    "steps",
    "timeline",
    "list",
  ])
    for (const ratio of ["3:2", "2:3"]) {
      const s = structuredClone(spec);
      s.kind = kind;
      if (["steps", "timeline", "list"].includes(kind)) {
        s.total = null;
        s.items = ["选择内容", "理解要求", "生成图片", "检查结果"].map(
          (label) => ({
            label,
            description: "结合项目记忆生成清晰的图像",
            value: null,
            evidence: "",
          }),
        );
      }
      const r = await renderStructuredSvg(s, ratio);
      assert.equal(
        r.engine,
        ["steps", "timeline", "list"].includes(kind) ? "antv" : "echarts",
      );
      assert.doesNotMatch(
        r.svg,
        /<foreignObject|<script|<style|data:|https:\/\//,
      );
      assert.ok(r.png.length > 1000);
      if (kind === "composition") {
        assert.match(r.svg, /51.03%/);
        assert.match(r.svg, /48.97%/);
        assert.match(r.svg, /140,545/);
      }
    }
});
test("rendered text overlap and overflow are detected", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><text x="20" y="80" font-size="28">重叠文字</text><text x="20" y="80" font-size="28">重叠文字</text><text x="290" y="150" font-size="28">越界文字</text></svg>';
  const r = await withRenderPage(300, 200, (page) =>
    inspectSvg(page, svg, 300, 200),
  );
  assert.ok(r.issues.some((s) => s.includes("重叠")));
  assert.ok(r.issues.some((s) => s.includes("超出")));
});
test("structured specification persists with its generated asset for subsequent edits", () => {
  const store = new Store(":memory:");
  try {
    const p = store.createProject("记忆测试");
    const job = store.createJob(p.id, { instruction: "测试" });
    const asset = store.createAsset(p.id, {
      kind: "generated",
      title: "人口",
      mime: "image/svg+xml",
      data: Buffer.from("<svg/>"),
    });
    store.updateJob(job.id, {
      status: "completed",
      result_asset_id: asset.id,
      plan: { svgSpec: spec },
    });
    assert.deepEqual(store.svgSpec(asset.id), spec);
  } finally {
    store.close();
  }
});

test("free SVG visual review feeds concrete issues into a bounded repair", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><text x="50" y="80" font-size="28">结构示意</text></svg>';
  const calls = [];
  const provider = new OpenAIProvider({
    apiKey: "test",
    fetchFn: async (u, o) => {
      const body = JSON.parse(o.body);
      calls.push(body);
      return output(
        body.text?.format
          ? JSON.stringify(
              calls.length === 2
                ? { passed: false, issues: ["缺少指定连线"] }
                : { passed: true, issues: [] },
            )
          : svg,
      );
    },
  });
  const result = await provider.generateFreeSvg({
    ...context,
    plan: { renderer: "svg" },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.quality.repairs, 1);
  assert.match(calls[2].input[0].content.at(-1).text, /缺少指定连线/);
  assert.match(
    calls[1].input[0].content[1].image_url,
    /^data:image\/png;base64,/,
  );
});
