import { chromium } from "@playwright/test";
import { mkdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider } from "../server/providers.mjs";

// Run with the ordinary app server stopped: this test owns port 8787 and an in-memory DB.
const store = new Store(":memory:");
const app = createApp({
  store,
  provider: new DemoProvider(),
  servePreview: true,
});
await new Promise((resolve, reject) => {
  app.server.once("error", reject);
  app.server.listen(8787, "127.0.0.1", resolve);
});
let browser;
try {
  const executablePath =
    process.env.BROWSER_PATH ||
    [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:8787");
  await page.getByRole("button", { name: "创建第一个项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("森林里的机器人");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.locator(".prompt-input").waitFor();
  await page.locator(".memory-drawer > summary").click();
  await page.getByRole("button", { name: "添加文字素材", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("角色设定 · 小林");
  await page
    .getByLabel("素材内容", { exact: true })
    .fill("一个戴橙色围巾的白色小机器人，圆形眼睛，喜欢在森林里观察植物。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".asset-card").getByTitle("设为长期参考").click();
  await page.getByRole("button", { name: "添加文字素材", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("场景 · 清晨森林");
  await page
    .getByLabel("素材内容", { exact: true })
    .fill("清晨的森林有薄雾，阳光穿过树叶，苔藓上有露水。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".generation-options > summary").click();
  await page.getByRole("tab", { name: "融合素材" }).click();
  await page
    .getByRole("textbox", { name: "本次生成要求" })
    .fill("让小林走进清晨的森林，保留橙色围巾，用作科普故事的开篇插画。");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await page.getByText("演示占位图 · 非 AI 生成", { exact: true }).waitFor();
  await page.getByRole("button", { name: /查看创作依据/ }).click();
  assert.match(
    await page.locator(".plan-details").innerText(),
    /角色设定 · 小林/,
  );
  assert.match(
    await page.locator(".plan-details").innerText(),
    /场景 · 清晨森林/,
  );
  await page.getByRole("button", { name: /查看创作依据/ }).click();
  mkdirSync("test-results", { recursive: true });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/studio-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "以此继续", exact: true }).click();
  assert.ok(await page.locator("#base-image").inputValue());
  await page
    .getByRole("textbox", { name: "本次生成要求" })
    .fill("保留机器人和围巾，把天气改为雨天。");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".history-item").length === 2,
  );
  assert.equal(
    store.jobs(store.projects()[0].id).filter((j) => j.status === "completed")
      .length,
    2,
  );
  const jobs = store.jobs(store.projects()[0].id);
  assert.equal(jobs[0].plan.snapshot.references[0].id, jobs[1].result_asset_id);
  await page.getByRole("button", { name: "编辑项目设定" }).click();
  await page.getByLabel("视觉风格", { exact: true }).fill("柔和水彩，纸张纹理");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.notEqual(
    store.jobs(store.projects()[0].id)[0].plan.snapshot.settings.style,
    "柔和水彩，纸张纹理",
  );
  await page.reload();
  await page.locator(".memory-drawer > summary").click();
  await page.locator(".asset-card").first().waitFor();
  assert.equal(await page.locator(".history-item").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/studio-sidepanel.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => ({
        class: el.className,
        right: el.getBoundingClientRect().right,
      }))
      .slice(0, 12),
  }));
  assert.equal(
    overflow.scroll <= overflow.width,
    true,
    "side panel must not overflow horizontally: " + JSON.stringify(overflow),
  );
  await page.locator(".mobile-projects").getByTitle("新建项目").click();
  await page.getByLabel("项目名称", { exact: true }).fill("独立的第二项目");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.locator(".memory-drawer > summary").click();
  await page.getByText("从一个片段开始", { exact: true }).waitFor();
  assert.equal(await page.locator(".asset-card").count(), 0);
  assert.equal(await page.locator(".history-item").count(), 0);
  assert.deepEqual(errors, [], "browser must not emit uncaught errors");
  console.log(
    "UI PASS: create project → add/pin references → fuse → inspect → edit → update memory → reload → narrow layout → project isolation",
  );
} finally {
  await browser?.close();
  await app.drain();
  await new Promise((r) => app.server.close(r));
  store.close();
}
