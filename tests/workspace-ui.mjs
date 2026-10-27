import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider } from "../server/providers.mjs";

const store = new Store(":memory:"),
  provider = new DemoProvider(),
  calls = [];
let failNext = false;
provider.explain = async (context) => {
  calls.push(context);
  if (failNext) {
    failNext = false;
    throw new Error("测试：模型暂时不可用");
  }
  return context.history.length
    ? `结合原文继续回答：${context.question}。此前有 ${context.history.length} 次回答。`
    : `核心意思：${context.selection}\n\n可以把它理解为先查资料，再组织回答。`;
};
const app = createApp({ store, provider });
await new Promise((r, j) => {
  app.server.once("error", j);
  app.server.listen(8787, "127.0.0.1", r);
});
let context;
try {
  const executablePath =
    process.env.EXTENSION_BROWSER_PATH ||
    (existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
      ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
      : undefined);
  const extension = resolve("dist");
  context = await chromium.launchPersistentContext("", {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    viewport: { width: 390, height: 844 },
  });
  const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker")),
    id = new URL(worker.url()).host;
  const panel = await context.newPage(),
    errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/index.html`);
  await panel.getByRole("heading", { name: "开始创作", exact: true }).waitFor();
  await worker.evaluate(() => {
    chrome.sidePanel.open = async () => {};
  });
  const menu = async (menuItemId, selectionText) =>
    worker.evaluate(
      async (args) => {
        await handleContextMenu(
          { ...args, pageUrl: "https://example.com" },
          { id: 1, url: "https://example.com" },
        );
      },
      { menuItemId, selectionText },
    );
  await menu("frame-text", "流程图：收集 → 分析 → 输出");
  const input = panel.getByRole("textbox", { name: "本次生成要求" });
  await expect(input).toHaveValue("流程图：收集 → 分析 → 输出");
  const projectId = store.projects()[0].id;
  assert.equal(store.assets(projectId).length, 0);
  assert.equal(await panel.locator(".inbox").count(), 0);
  await input.fill("流程图：读取 → 理解 → 绘图。使用蓝色。");
  await menu("frame-text", "增加标题：Agent 工作流程");
  await expect(input).toHaveValue(
    "流程图：读取 → 理解 → 绘图。使用蓝色。\n\n增加标题：Agent 工作流程",
  );
  await panel.reload();
  await expect(input).toHaveValue(
    "流程图：读取 → 理解 → 绘图。使用蓝色。\n\n增加标题：Agent 工作流程",
  );
  await panel.getByRole("button", { name: "生成", exact: true }).click();
  await panel.getByText("SVG 路由演示 · 非模型生成", { exact: true }).waitFor();
  assert.match(store.jobs(projectId)[0].request.instruction, /使用蓝色/);
  mkdirSync("test-results", { recursive: true });
  await panel.screenshot({
    path: "test-results/simple-workspace.png",
    fullPage: true,
  });
  await menu("frame-explain", "检索增强生成：先检索资料，再结合资料回答问题。");
  await expect(
    panel.getByRole("tab", { name: "AI 解释", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".chat-answer")).toContainText("核心意思");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].history.length, 0);
  await panel.getByRole("textbox", { name: "继续追问" }).fill("用图书馆举例");
  await panel.getByRole("button", { name: "发送追问" }).click();
  await expect(panel.locator(".chat-answer").last()).toContainText(
    "此前有 1 次回答",
  );
  assert.equal(calls[1].history[0].answer.includes("核心意思"), true);
  await panel.reload();
  await expect(panel.locator(".chat-answer")).toHaveCount(2);
  await expect(panel.locator(".chat-answer").last()).toContainText("图书馆");
  // Keep a failed reply visible and retry without losing the original conversation.
  failNext = true;
  await panel.getByRole("textbox", { name: "继续追问" }).fill("再简短一点");
  await panel.getByRole("button", { name: "发送追问" }).click();
  await panel.getByText("测试：模型暂时不可用", { exact: true }).waitFor();
  await panel
    .locator(".chat-answer")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(panel.locator(".chat-answer").last()).toContainText(
    "此前有 2 次回答",
  );
  await panel.screenshot({
    path: "test-results/explain-conversation.png",
    fullPage: true,
  });
  await panel.getByTitle("新建项目", { exact: true }).click();
  await panel.getByLabel("项目名称", { exact: true }).fill("另一项目");
  await panel.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(panel.locator(".chat-empty")).toBeVisible();
  assert.equal(await panel.locator(".chat-answer").count(), 0);
  await panel.getByRole("tab", { name: "生图", exact: true }).click();
  await expect(input).toHaveValue("");
  await panel
    .getByRole("combobox", { name: "切换项目" })
    .selectOption(projectId);
  await expect(input).toHaveValue(/使用蓝色/);
  assert.equal(
    await panel.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "WORKSPACE PASS: selection → editable persistent draft → append → generate; right-click explanation → follow-up → reload → failure/retry → project isolation; 390px layout.",
  );
} finally {
  await context?.close();
  await app.drain();
  await new Promise((r) => app.server.close(r));
  store.close();
}
