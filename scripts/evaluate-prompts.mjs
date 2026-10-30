// Opt-in evaluation of the configured language model. Never calls an image endpoint.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIProvider } from "../server/providers.mjs";
import { DEFAULT_SETTINGS } from "../server/store.mjs";

if (!process.argv.includes("--live")) {
  console.log(
    "仅评估语言模型提示词，不生成图片。使用 node scripts/evaluate-prompts.mjs --live 运行（产生语言模型费用）。",
  );
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, process.env.DATA_DIR || ".data");
const db = new DatabaseSync(resolve(dataDir, "frame.sqlite"), {
  readOnly: true,
});
let config;
try {
  config = JSON.parse(
    db.prepare("SELECT config FROM model_settings WHERE id=1").get()?.config ||
      "null",
  );
} finally {
  db.close();
}
if (!config?.llm?.apiKey) throw new Error("请先在插件保存语言模型配置。");
const allowedOrigin = new URL(config.llm.baseUrl).origin;
const provider = new OpenAIProvider({
  ...config.llm,
  plannerModel: config.llm.model,
  llmApiStyle: config.llm.apiStyle,
  imageApi: {
    generate() {
      throw new Error("评估禁止生成图片");
    },
  },
  fetchFn: (url, options) => {
    const parsed = new URL(url);
    if (
      parsed.origin !== allowedOrigin ||
      !/\/(chat\/completions|responses)$/.test(parsed.pathname)
    )
      throw new Error("评估仅允许语言模型请求");
    return fetch(url, options);
  },
});
const cases = [
  {
    id: "portrait",
    instruction:
      "生成一张自然人像摄影：一位短发女性，灰色背景，半身，窗边柔光，保留自然皮肤纹理。不要首饰、道具和文字。",
    settings: { style: "自然摄影", palette: "" },
    expected: [],
  },
  {
    id: "poster-text",
    instruction:
      "生成一张陶瓷杯产品摄影海报。本次使用蓝白配色；画面只写标题“春日上新”和价格“¥39.90”，不要其他文案和道具。",
    expected: ["春日上新", "¥39.90"],
  },
  {
    id: "series-memory",
    instruction:
      "生成插画：项目里的机器人坐在湖边，保持角色外观。这次画面采用暖黄色调，不要文字。",
    settings: {
      subjectIdentity: "圆形白色机器人，橙色围巾，两个圆形黑色眼睛",
      avoid: "荧光色",
    },
    expected: [],
  },
];
const results = [];
for (const item of cases) {
  console.log(`正在评估 ${item.id}…`);
  const started = Date.now();
  try {
    const plan = await provider.plan({
      request: { mode: "new", instruction: item.instruction },
      snapshot: {
        settings: { ...DEFAULT_SETTINGS, ...item.settings },
        recentTurns: [],
        references: [],
      },
      references: [],
    });
    const texts = plan.imageBrief?.text.map((t) => t.text) || [];
    results.push({
      id: item.id,
      instruction: item.instruction,
      milliseconds: Date.now() - started,
      exactTextPass:
        JSON.stringify(texts.slice().sort()) ===
        JSON.stringify(item.expected.slice().sort()),
      plan,
    });
    console.log(
      `${item.id}: ${plan.renderer}, ${plan.prompt.length} 字符, 画面文字${results.at(-1).exactTextPass ? "通过" : "待检查"}`,
    );
  } catch (error) {
    results.push({ id: item.id, error: error.message });
    console.log(`${item.id}: 失败，${error.message}`);
  }
}
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/prompt-evaluation.json"),
  JSON.stringify(
    {
      model: config.llm.model,
      evaluatedAt: new Date().toISOString(),
      imageCalls: 0,
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => r.error || !r.exactTextPass)) process.exitCode = 1;
