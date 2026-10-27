import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { withRenderPage, inspectSvg } from "../server/svg-browser.mjs";
const root = "http://127.0.0.1:8787";
async function api(path, body) {
  const r = await fetch(
    root + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function wait(job) {
  const until = Date.now() + 240000;
  while (Date.now() < until) {
    const j = await api("/api/jobs/" + job.id);
    if (j.status === "failed") throw new Error(j.error);
    if (j.status === "completed") return j;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("生成超时");
}
async function save(j, name) {
  const svg = await (
    await fetch(root + "/api/assets/" + j.result_asset_id + "/image")
  ).text();
  writeFileSync("test-results/live-" + name + ".svg", svg);
  const r = await withRenderPage(1200, 800, (page) =>
    inspectSvg(page, svg, 1200, 800),
  );
  writeFileSync("test-results/live-" + name + ".png", r.png);
  assert.deepEqual(r.issues, []);
  console.log(
    name,
    JSON.stringify({
      engine: j.plan.svgEngine,
      kind: j.plan.svgSpec?.kind,
      quality: j.plan.quality,
    }),
  );
}
const project = await api("/api/projects", { name: "SVG 0.5 改造验证" });
console.log("project", project.id);
const quick = await api("/api/quick-generate", {
  requestId: crypto.randomUUID(),
  projectId: project.id,
  selectionText:
    "绘制全国人口构成图。总人口140545万人，其中男性71722万人，占51.03%；女性68823万人，占48.97%。使用简洁的绿色和橙色，不要添加其他数据。",
});
const first = await wait(quick.job);
await save(first, "population");
assert.equal(first.plan.svgEngine, "echarts");
assert.equal(first.plan.svgSpec.total, 140545);
assert.deepEqual(
  first.plan.svgSpec.items.map((i) => i.value).sort((a, b) => a - b),
  [68823, 71722],
);
const edit = await wait(
  await api("/api/projects/" + project.id + "/jobs", {
    instruction: "只把配色改为蓝色，保留原来的数值、单位、图形种类和文字。",
    mode: "edit",
    baseAssetId: first.result_asset_id,
    assetIds: [],
    autoMemory: true,
  }),
);
await save(edit, "population-blue");
assert.equal(edit.plan.svgSpec.theme, "blue");
assert.deepEqual(
  edit.plan.svgSpec.items.map((i) => i.value),
  first.plan.svgSpec.items.map((i) => i.value),
);
assert.equal(edit.plan.svgSpec.total, 140545);
const flow = await wait(
  await api("/api/projects/" + project.id + "/jobs", {
    instruction:
      "画一张独立的流程图：选择网页文字 → 结合项目记忆 → 自动生成图片 → 检查排版。每个步骤用一句短说明解释，不要包含人口数据。",
    mode: "new",
    assetIds: [],
    autoMemory: true,
  }),
);
await save(flow, "flow");
assert.equal(flow.plan.svgEngine, "antv");
writeFileSync(
  "test-results/live-svg-report.json",
  JSON.stringify(
    {
      projectId: project.id,
      jobs: [first, edit, flow].map((j) => ({
        id: j.id,
        asset: j.result_asset_id,
        engine: j.plan.svgEngine,
        spec: j.plan.svgSpec,
        quality: j.plan.quality,
      })),
    },
    null,
    2,
  ),
);
console.log(
  "LIVE PASS: data, structured memory, color edit, flow, safe export",
);
