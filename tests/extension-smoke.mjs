import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { DemoProvider } from "../server/providers.mjs";

// Browser extension integration: uses only an isolated test profile and an in-memory server.
// In headless mode we replace captureVisibleTab with a real browser screenshot because
// toolbar activation / activeTab grants require a real user gesture in browser chrome.
const store = new Store(":memory:");
const project = store.createProject("扩展集成测试");
const app = createApp({ store, provider: new DemoProvider() });
await new Promise((r, j) => {
  app.server.once("error", j);
  app.server.listen(8787, "127.0.0.1", r);
});
let context;
try {
  const extensionPath = resolve("dist");
  const executablePath =
    process.env.EXTENSION_BROWSER_PATH ||
    (existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
      ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
      : undefined);
  context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: executablePath ? undefined : "chromium",
    ...(executablePath ? { executablePath } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: { width: 1100, height: 800 },
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/index.html`);
  await panel.getByRole("button", { name: "框选网页", exact: false }).waitFor();
  const target = await context.newPage();
  await target.goto("http://127.0.0.1:8787");
  // A deterministic page makes the screenshot dimensions and selected text verifiable.
  await target.evaluate(() => {
    document.body.innerHTML =
      '<main style="margin:0;padding:40px"><h1 id="source">机器人戴着橙色围巾，在森林里观察植物。</h1><div style="width:500px;height:300px;background:#eb9c63;border-radius:20px"></div></main>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("source"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const active = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab.id;
  });
  const selected = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "READ_SELECTION" }),
  );
  assert.equal(selected.ok, true, JSON.stringify(selected));
  await panel.waitForFunction(() =>
    document.querySelector(".prompt-input")?.value.includes("橙色围巾"),
  );
  assert.equal(
    await panel.locator(".prompt-input").inputValue(),
    "机器人戴着橙色围巾，在森林里观察植物。",
  );
  assert.equal(
    store.assets(project.id).length,
    0,
    "text remains editable until submitted",
  );
  await target.bringToFront();
  const screenshot =
    "data:image/png;base64," + (await target.screenshot()).toString("base64");
  await worker.evaluate((url) => {
    chrome.tabs.captureVisibleTab = async () => url;
  }, screenshot);
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["capture.js"],
      }),
    active,
  );
  await target.locator("#__frame_capture__").waitFor();
  await target.mouse.move(60, 140);
  await target.mouse.down();
  await target.mouse.move(340, 340, { steps: 8 });
  await target.mouse.up();
  await panel
    .getByRole("button", { name: "加入项目", exact: true })
    .waitFor({ timeout: 12000 })
    .catch(async (error) => {
      console.log(
        "Capture diagnostic:",
        await panel.locator("main").innerText(),
      );
      throw error;
    });
  const dimensions = await panel
    .locator(".capture-item img")
    .evaluate(async (image) => {
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
  assert.deepEqual(dimensions, [280, 200]);
  await panel.getByRole("button", { name: "加入项目", exact: true }).click();
  await panel.locator(".memory-drawer > summary").click();
  await panel.waitForFunction(
    () => document.querySelectorAll(".asset-card").length === 1,
  );
  assert.equal(
    store.assets(project.id).filter((a) => a.kind === "image").length,
    1,
  );
  await target.bringToFront();
  await worker.evaluate(
    async (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["capture.js"],
      }),
    active,
  );
  await target.locator("#__frame_capture__").waitFor();
  await target.keyboard.press("Escape");
  assert.equal(await target.locator("#__frame_capture__").count(), 0);
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.evaluate(() => scrollTo(0, 0));
  mkdirSync("test-results", { recursive: true });
  await panel.screenshot({
    path: "test-results/extension-sidepanel.png",
    fullPage: true,
  });
  console.log(
    "EXTENSION PASS: MV3 load → service worker → read selection → editable draft → drag crop 280×200 → import → Esc cancel. captureVisibleTab used a browser-screenshot fixture; toolbar permission grant remains a manual check.",
  );
} finally {
  await context?.close();
  await app.drain();
  await new Promise((r) => app.server.close(r));
  store.close();
}
