import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider } from "../server/providers.mjs";

const store = new Store(":memory:");
const app = createApp({ store, provider: new DemoProvider() });
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
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host,
    panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${id}/index.html`);
  await panel.getByRole("heading", { name: "开始创作" }).waitFor();
  // Execute the actual registered context-menu handler. Headless cannot click browser chrome.
  await worker.evaluate(() => {
    chrome.sidePanel.open = async () => {};
  });
  const direct = async (text) =>
    worker.evaluate(async (selectionText) => {
      await handleContextMenu(
        {
          menuItemId: "frame-generate",
          selectionText,
          pageUrl: "https://example.com/article",
        },
        { id: 1, url: "https://example.com/article" },
      );
      return chrome.storage.local.get([
        "lastQuickJob",
        "quickError",
        "activeProjectId",
      ]);
    }, text);
  const first = await direct("季度销量柱状图：一月:20，二月:35，三月:50");
  await panel.getByRole("button", { name: "确认并生成", exact: true }).click();
  assert.equal(first.quickError, undefined);
  await panel.getByText("SVG 路由演示 · 非模型生成", { exact: true }).waitFor();
  assert.equal(
    store.projects().length,
    1,
    "first right click automatically creates a project",
  );
  assert.equal(store.job(first.lastQuickJob.jobId).plan.renderer, "svg");
  assert.equal(
    await panel.locator(".inbox").count(),
    0,
    "direct generation does not require a capture confirmation",
  );
  await panel.locator(".result-image").evaluate(async (img) => {
    await img.decode();
  });
  assert.equal(
    await panel.locator(".result-image").evaluate((img) => img.naturalWidth),
    1200,
  );
  mkdirSync("test-results", { recursive: true });
  await panel.screenshot({
    path: "test-results/plugin-svg-result.png",
    fullPage: true,
  });
  const pngDownload = panel.waitForEvent("download");
  await panel.getByRole("button", { name: "导出 PNG", exact: true }).click();
  const download = await pngDownload;
  const path = await download.path();
  assert.equal(
    readFileSync(path).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  await panel.getByRole("button", { name: "以此继续", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "本次生成要求" })
    .fill("保留图表数据，把标题改为蓝色");
  await panel.getByRole("button", { name: "整理内容", exact: true }).click();
  await panel.getByRole("button", { name: "确认并生成", exact: true }).click();
  await panel.waitForFunction(
    () => document.querySelectorAll(".history-item").length === 2,
  );
  assert.equal(store.jobs(first.activeProjectId)[0].plan.renderer, "svg");
  const second = await direct("日落海滩上的人物肖像，写实摄影风格");
  await panel.getByRole("button", { name: "确认并生成", exact: true }).click();
  await panel.getByText("演示占位图 · 非 AI 生成", { exact: true }).waitFor();
  assert.equal(store.job(second.lastQuickJob.jobId).plan.renderer, "image_api");
  assert.equal(
    store.job(second.lastQuickJob.jobId).plan.snapshot.recentTurns.length,
    2,
  );
  await panel.locator(".mobile-projects").getByTitle("新建项目").click();
  await panel.getByLabel("项目名称", { exact: true }).fill("独立项目");
  await panel.getByRole("button", { name: "创建项目", exact: true }).click();
  await panel.locator(".prompt-input").waitFor();
  const other = await direct("制作时间线：2024启动，2025发布，2026扩展");
  await panel.getByRole("button", { name: "确认并生成", exact: true }).click();
  await panel.getByText("SVG 路由演示 · 非模型生成", { exact: true }).waitFor();
  assert.notEqual(other.activeProjectId, first.activeProjectId);
  assert.equal(
    store.job(other.lastQuickJob.jobId).plan.snapshot.recentTurns.length,
    0,
  );
  await panel.reload();
  await panel.getByText("SVG 路由演示 · 非模型生成", { exact: true }).waitFor();
  assert.equal(
    await panel.getByRole("combobox", { name: "切换项目" }).inputValue(),
    other.activeProjectId,
  );
  assert.equal(
    await panel.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "QUICK MENU PASS: context-menu handler → default project → SVG → PNG export → SVG edit → image API route → project memory → project switch → reload. All generation requires review approval. Native menu click and panel-open gestures remain manual.",
  );
} finally {
  await context?.close();
  await app.drain();
  await new Promise((r) => app.server.close(r));
  store.close();
}
