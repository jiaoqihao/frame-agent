(() => {
  if (document.getElementById("__frame_capture__")) return;
  const host = document.createElement("div");
  host.id = "__frame_capture__";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>:host{all:initial}.overlay{position:fixed;inset:0;cursor:crosshair;touch-action:none;background:rgba(18,42,30,.12)}.tip{position:absolute;top:24px;left:50%;transform:translateX(-50%);padding:12px 20px;border-radius:100px;background:#183e30;color:white;font:14px system-ui;pointer-events:none;white-space:nowrap}.box{position:absolute;border:2px solid #e9a56c;background:transparent;box-shadow:0 0 0 100vmax rgba(15,30,22,.28);display:none;pointer-events:none;box-sizing:border-box}</style><div class="overlay"><div class="tip">拖动框选要加入项目的内容 · Esc 取消</div><div class="box"></div></div>`;
  document.documentElement.appendChild(host);
  const overlay = shadow.querySelector(".overlay"),
    box = shadow.querySelector(".box");
  let start = null;
  const cleanup = () => {
    host.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    }
  };
  document.addEventListener("keydown", onKey, true);
  const point = (e) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  const rect = (e) => {
    const p = point(e);
    return {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  };
  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = point(e);
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!start) return;
    const r = rect(e);
    Object.assign(box.style, {
      display: "block",
      left: r.x + "px",
      top: r.y + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
  });
  overlay.addEventListener("pointercancel", cleanup);
  overlay.addEventListener("pointerup", async (e) => {
    if (!start) return;
    const selected = rect(e);
    cleanup();
    if (selected.width < 8 || selected.height < 8) return;
    // Allow the overlay removal to be painted before capturing the visible tab.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    try {
      const result = await chrome.runtime.sendMessage({
        type: "CAPTURE_REGION",
        rect: selected,
      });
      if (result?.error)
        await chrome.storage.local.set({ captureError: result.error });
    } catch {
      await chrome.storage.local.set({
        captureError: "截图失败，请刷新网页后再试。",
      });
    }
  });
})();
