import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../server/providers.mjs";
import {
  compileImagePrompt,
  imageInputs,
  validateBrief,
} from "../server/image-prompt.mjs";
import { DEFAULT_SETTINGS } from "../server/store.mjs";

export const brief = {
  intent: "品牌海报",
  scene: "浅色背景",
  subject: "一只陶瓷杯",
  composition: "主体完整呈现，标题区留白",
  appearance: "自然产品摄影",
  lighting: "柔和侧光，陶瓷釉面有真实反射",
  text: [
    {
      text: "春日·2026 / Frame",
      placement: "上方留白",
      typography: "深色无衬线标题",
    },
  ],
  references: [],
  preserve: [],
  changes: [],
  constraints: ["不添加其他道具"],
};
const plan = {
  title: "海报",
  summary: "自然摄影",
  prompt: "粗略提示词",
  preserved: [],
  changes: [],
  renderer: "image_api",
  routeReason: "摄影",
};
const snapshot = {
  settings: {
    ...DEFAULT_SETTINGS,
    style: "摄影",
    subjectIdentity: "陶瓷杯",
    typography: "无衬线",
    avoid: "荧光色",
  },
  references: [],
  recentTurns: [],
};

test("image route uses skill and sends compiled prompt verbatim to the image adapter", async () => {
  const calls = [];
  let sent;
  const p = new OpenAIProvider({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    llmApiStyle: "chat",
    fetchFn: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(calls.length === 1 ? plan : brief),
            },
          },
        ],
      });
    },
    imageApi: {
      generate: async (context) => {
        sent = context.plan.prompt;
        return { mime: "image/png", data: Buffer.from("mock") };
      },
    },
  });
  const context = {
    request: { instruction: "摄影海报，标题“春日·2026 / Frame”", mode: "new" },
    snapshot,
    references: [],
  };
  const result = await p.plan(context);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /Frame Image Prompt Skill/);
  assert.match(calls[1].messages[1].content[0].text, /荧光色/);
  assert.equal(calls[1].response_format.type, "json_object");
  assert.match(result.prompt, /春日·2026 \/ Frame/);
  assert.match(result.prompt, /标题区留白/);
  assert.equal(result.promptQuality.repairs, 0);
  await p.generate({ ...context, plan: result });
  assert.equal(sent, result.prompt);
});

test("mixed text, SVG and bitmap references retain actual attachment numbering during edits", () => {
  const request = { mode: "edit", baseAssetId: "svg" };
  const inputs = imageInputs(
    [
      { asset: { id: "text", content: "说明" } },
      { asset: { id: "svg", data: Buffer.from("svg"), mime: "image/svg+xml" } },
      { asset: { id: "png", data: Buffer.from("png"), mime: "image/png" } },
    ],
    request,
  );
  const edited = {
    ...brief,
    text: [],
    references: [
      { imageIndex: 2, role: "风格", use: "只借用色彩" },
      { imageIndex: 1, role: "原图", use: "仅改杯子颜色" },
    ],
    preserve: ["杯子形状、背景和构图"],
    changes: ["杯子变蓝"],
  };
  validateBrief(edited, inputs, "edit");
  const prompt = compileImagePrompt(edited, inputs, request, "1:1");
  assert.ok(prompt.indexOf("图 1（本次修改的原图）") < prompt.indexOf("图 2"));
  assert.match(prompt, /杯子变蓝/);
  assert.match(prompt, /原有文字按/);
  assert.throws(
    () =>
      validateBrief(
        {
          ...edited,
          references: [
            { imageIndex: 1, role: "x", use: "x" },
            { imageIndex: 1, role: "x", use: "x" },
          ],
        },
        inputs,
        "edit",
      ),
    /编号/,
  );
  assert.throws(
    () => validateBrief({ ...edited, preserve: [] }, inputs, "edit"),
    /保留/,
  );
});

test("malformed brief is repaired once; repeated failure never reaches image generation", async () => {
  for (const repairWorks of [true, false]) {
    const p = new OpenAIProvider({ apiKey: "test" });
    let calls = 0;
    p.complete = async () => {
      calls++;
      return JSON.stringify(
        calls === 1
          ? plan
          : calls === 3 && repairWorks
            ? brief
            : {
                ...brief,
                references: [{ imageIndex: 99, role: "fake", use: "fake" }],
              },
      );
    };
    p.imageAPI.generate = () => assert.fail("must not generate while planning");
    const action = p.plan({
      request: { instruction: "陶瓷杯摄影", mode: "new" },
      snapshot,
      references: [],
    });
    if (repairWorks) assert.equal((await action).promptQuality.repairs, 1);
    else await assert.rejects(action, /图片提示词检查失败/);
    assert.equal(calls, 3);
  }
});

test("SVG planning does not incur an image prompt refinement call", async () => {
  const p = new OpenAIProvider({ apiKey: "test" });
  let calls = 0;
  p.complete = async () => {
    calls++;
    return JSON.stringify({ ...plan, renderer: "svg" });
  };
  const result = await p.plan({
    request: { instruction: "生成 SVG 流程图", mode: "new" },
    snapshot,
    references: [],
  });
  assert.equal(calls, 1);
  assert.equal(result.renderer, "svg");
  assert.equal(result.promptQuality, undefined);
});
