import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { ModelSettings, environmentSettings } from "../server/settings.mjs";
import { createApp } from "../server/app.mjs";

const store = new Store(":memory:");
const calls = [];
const settings = new ModelSettings({
  store,
  defaults: environmentSettings({}),
  fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (options.headers.Authorization === "Bearer bad-key")
      return new Response("sensitive error", { status: 401 });
    return Response.json({
      data: (String(url).includes("language.example")
        ? ["custom-text-v2", "custom-text-v3"]
        : ["custom-image-v2"]
      ).map((id) => ({ id })),
    });
  },
});
const app = createApp({ store, settings });
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
    viewport: { width: 1200, height: 1000 },
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/index.html`);
  await panel.getByText("演示模式", { exact: true }).waitFor();
  const event = context.waitForEvent("page");
  await panel.getByTitle("模型设置", { exact: true }).click();
  let page = await event;
  await page.waitForURL("**/options.html");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "真实模型", exact: true }).click();
  await page
    .getByLabel("语言模型接口地址", { exact: true })
    .fill("https://language.example/v1");
  await page
    .getByLabel("语言模型 API 密钥", { exact: true })
    .fill("dummy-llm-key");
  await page.getByLabel("语言模型名称", { exact: true }).fill("custom-text-v2");
  await page.getByLabel("语言模型协议", { exact: true }).selectOption("chat");
  await page
    .getByLabel("图片模型接口地址", { exact: true })
    .fill("https://images.example/v1");
  await page
    .getByLabel("图片模型 API 密钥", { exact: true })
    .fill("dummy-image-key");
  await page.getByLabel("图片模型名称", { exact: true }).fill("not-listed");
  await page
    .getByLabel("服务支持参考图编辑（/images/edits）", { exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "检查语言模型连接", exact: true })
    .click();
  await page.getByText("连接检查通过", { exact: true }).waitFor();
  await page
    .getByLabel("选择已发现的语言模型", { exact: true })
    .selectOption("custom-text-v3");
  await page
    .getByRole("button", { name: "检查图片模型连接", exact: true })
    .click();
  await page.getByText("请核对模型名称", { exact: true }).waitFor();
  await page
    .getByLabel("选择已发现的图片模型", { exact: true })
    .selectOption("custom-image-v2");
  assert.equal(
    settings.public().revision,
    "environment",
    "checking draft must not save configuration",
  );
  assert.equal(calls[0].options.headers.Authorization, "Bearer dummy-llm-key");
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer dummy-image-key",
  );
  assert.ok(calls.every((c) => c.url.endsWith("/models")));
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByText("设置已保存，新任务立即生效。", { exact: true })
    .waitFor();
  assert.equal(settings.current().llm.model, "custom-text-v3");
  assert.equal(settings.current().llm.apiStyle, "chat");
  assert.equal(settings.current().image.model, "custom-image-v2");
  assert.equal(settings.current().image.supportsEdit, false);
  assert.equal(
    await page.getByLabel("语言模型 API 密钥", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("图片模型 API 密钥", { exact: true }).inputValue(),
    "",
  );
  await panel.getByText("模型已配置", { exact: true }).waitFor();
  const storage = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.ok(
    !JSON.stringify(storage).includes("dummy-"),
    "keys must not be stored in extension storage",
  );
  mkdirSync("test-results", { recursive: true });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/model-settings.png",
    fullPage: true,
  });
  await page.close();
  const again = context.waitForEvent("page");
  await panel.getByTitle("模型设置", { exact: true }).click();
  page = await again;
  await page.waitForURL("**/options.html");
  await page.getByLabel("语言模型名称", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("语言模型名称", { exact: true }).inputValue(),
    "custom-text-v3",
  );
  assert.equal(
    await page.getByLabel("语言模型 API 密钥", { exact: true }).inputValue(),
    "",
  );
  await page.getByLabel("语言模型 API 密钥", { exact: true }).fill("bad-key");
  await page
    .getByRole("button", { name: "检查语言模型连接", exact: true })
    .click();
  await page.getByText(/检查接口返回 401/).waitFor();
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  assert.equal(
    await page.getByLabel("语言模型 API 密钥", { exact: true }).inputValue(),
    "",
  );
  await page
    .getByRole("button", { name: "清除已存密钥", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page
    .getByText("设置已保存，新任务立即生效。", { exact: true })
    .waitFor();
  assert.equal(settings.public().image.hasKey, false);
  assert.equal(settings.current().llm.apiKey, "dummy-llm-key");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/model-settings-narrow.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "SETTINGS UI PASS: native options entry → separate models/keys → read-only connection check → model selection → save live update → reopen persistence → masked credentials → clear key → narrow layout. No real model service called.",
  );
} finally {
  await context?.close();
  await app.drain();
  await new Promise((r) => app.server.close(r));
  store.close();
}
