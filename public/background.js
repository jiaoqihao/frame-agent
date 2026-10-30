chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "frame-generate",
      title: "Frame · 理解并生图",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "frame-text",
      title: "将选中文字加入 Frame",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "frame-explain",
      title: "Frame · AI 解释",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "frame-capture",
      title: "框选截图加入 Frame",
      contexts: ["page", "image"],
    });
  });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});

async function queueCapture(capture) {
  const id = crypto.randomUUID();
  const { activeProjectId } = await chrome.storage.local.get("activeProjectId");
  await chrome.storage.local.set({
    [`capture:${id}`]: {
      ...capture,
      projectId: activeProjectId || null,
      id,
      createdAt: Date.now(),
    },
  });
}
async function beginCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || ""))
    throw new Error("请在普通网页中截图，浏览器设置页不支持框选。");
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["capture.js"],
  });
}
async function submitQuick(body) {
  await chrome.storage.local.set({ pendingQuick: body });
  let response;
  try {
    response = await fetch("http://127.0.0.1:8787/api/quick-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error(
      "无法连接 Frame 本地 Agent 服务，请启动服务后在侧边栏重试。",
    );
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "提交生成任务失败");
  await chrome.storage.local.set({
    activeProjectId: result.project.id,
    lastQuickJob: {
      projectId: result.project.id,
      jobId: result.job.id,
      createdAt: Date.now(),
    },
  });
  await chrome.storage.local.remove(["pendingQuick", "quickError"]);
  return result;
}
async function submitExplain(body) {
  await chrome.storage.local.set({ pendingExplain: body });
  let response;
  try {
    response = await fetch("http://127.0.0.1:8787/api/quick-explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("无法连接本地服务，请稍后重试。");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "解释提交失败");
  await chrome.storage.local.set({
    activeProjectId: result.project.id,
    lastExplain: {
      projectId: result.project.id,
      conversationId: result.conversation.id,
      createdAt: Date.now(),
    },
  });
  await chrome.storage.local.remove(["pendingExplain", "explainError"]);
  return result;
}
async function handleContextMenu(info, tab) {
  if (!tab?.id) return;
  // Open synchronously from the user gesture, before any awaited operation.
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
  if (info.menuItemId === "frame-explain") {
    try {
      const { activeProjectId } =
        await chrome.storage.local.get("activeProjectId");
      await submitExplain({
        requestId: crypto.randomUUID(),
        projectId: activeProjectId || null,
        selectionText: info.selectionText || "",
        source: info.pageUrl || tab.url || "",
      });
    } catch (e) {
      await chrome.storage.local.set({ explainError: e.message });
    }
    return;
  }
  if (info.menuItemId === "frame-generate") {
    try {
      const { activeProjectId } =
        await chrome.storage.local.get("activeProjectId");
      await submitQuick({
        requestId: crypto.randomUUID(),
        projectId: activeProjectId || null,
        selectionText: info.selectionText || "",
        source: info.pageUrl || tab.url || "",
      });
    } catch (e) {
      await chrome.storage.local.set({ quickError: e.message });
    }
    return;
  }
  if (info.menuItemId === "frame-text")
    await queueCapture({
      kind: "text",
      title: (info.selectionText || "").slice(0, 40),
      content: info.selectionText || "",
      source: info.pageUrl || "",
    }).catch(console.error);
  if (info.menuItemId === "frame-capture")
    beginCapture(tab.id).catch(async (e) =>
      chrome.storage.local.set({ captureError: e.message }),
    );
}
chrome.contextMenus.onClicked.addListener(handleContextMenu);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const run = async () => {
    if (message.type === "RETRY_EXPLAIN") {
      const { pendingExplain } =
        await chrome.storage.local.get("pendingExplain");
      if (!pendingExplain) throw new Error("没有待重试的解释");
      try {
        await submitExplain(pendingExplain);
        return { ok: true };
      } catch (e) {
        await chrome.storage.local.set({ explainError: e.message });
        throw e;
      }
    }
    if (message.type === "RETRY_QUICK") {
      const { pendingQuick } = await chrome.storage.local.get("pendingQuick");
      if (!pendingQuick) throw new Error("没有待重试的右键任务");
      try {
        await submitQuick(pendingQuick);
        return { ok: true };
      } catch (e) {
        await chrome.storage.local.set({ quickError: e.message });
        throw e;
      }
    }
    if (message.type === "START_CAPTURE") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (!tab?.id) throw new Error("未找到当前网页");
      await beginCapture(tab.id);
      return { ok: true };
    }
    if (message.type === "READ_SELECTION") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (!tab?.id || !/^https?:/.test(tab.url || ""))
        throw new Error("请先在普通网页选中文字");
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          text: window.getSelection()?.toString() || "",
          source: location.href,
        }),
      });
      if (!result.result?.text?.trim())
        throw new Error("没有选中文字。也可以在网页中选中后右键发送到 Frame。");
      await queueCapture({
        kind: "text",
        title: result.result.text.slice(0, 40),
        content: result.result.text,
        source: result.result.source,
      });
      return { ok: true };
    }
    if (message.type === "CAPTURE_REGION") {
      if (!sender.tab?.id) throw new Error("截图来源无效");
      const [active] = await chrome.tabs.query({
        active: true,
        windowId: sender.tab.windowId,
      });
      if (active?.id !== sender.tab.id)
        throw new Error("截图时切换了标签页，请重新框选。");
      const { x, y, width, height, viewportWidth, viewportHeight } =
        message.rect || {};
      if (
        ![x, y, width, height, viewportWidth, viewportHeight].every(
          Number.isFinite,
        ) ||
        width < 8 ||
        height < 8 ||
        viewportWidth <= 0 ||
        viewportHeight <= 0
      )
        throw new Error("选区无效，请重新截图");
      const url = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
        format: "png",
      });
      // Decode locally: fetching a data URL is blocked by our strict connect-src CSP.
      const raw = atob(url.slice(url.indexOf(",") + 1));
      const pixels = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([pixels], { type: "image/png" }),
      );
      const sx = bitmap.width / viewportWidth,
        sy = bitmap.height / viewportHeight;
      const left = Math.max(0, Math.round(x * sx)),
        top = Math.max(0, Math.round(y * sy));
      const w = Math.min(bitmap.width - left, Math.round(width * sx)),
        h = Math.min(bitmap.height - top, Math.round(height * sy));
      if (w <= 0 || h <= 0) {
        bitmap.close();
        throw new Error("选区超出页面范围");
      }
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, left, top, w, h, 0, 0, w, h);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: "image/png" });
      if (blob.size > 8 * 1024 * 1024)
        throw new Error("选区图片超过 8 MB，请缩小选区");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      await queueCapture({
        kind: "image",
        title: sender.tab.title?.slice(0, 80) || "网页截图",
        dataUrl: `data:image/png;base64,${btoa(binary)}`,
        source: sender.tab.url || "",
      });
      return { ok: true };
    }
    throw new Error("未知操作");
  };
  run()
    .then(respond)
    .catch((error) => respond({ error: error.message || "操作失败" }));
  return true;
});
