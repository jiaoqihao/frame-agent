import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

test("extension context menu preserves selected text and source in a unique capture inbox entry", async () => {
  const code = await readFile(
    new URL("../public/background.js", import.meta.url),
    "utf8",
  );
  const writes = [];
  let contextListener,
    opened = false;
  const chrome = {
    runtime: {
      id: "test",
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
    },
    contextMenus: {
      onClicked: {
        addListener(fn) {
          contextListener = fn;
        },
      },
    },
    sidePanel: {
      open() {
        opened = true;
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set(value) {
          writes.push(value);
        },
      },
    },
  };
  vm.runInNewContext(code, { chrome, crypto, console });
  contextListener(
    {
      menuItemId: "frame-text",
      selectionText: "机器人的橙色围巾",
      pageUrl: "https://example.com",
    },
    { id: 12 },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(opened, true);
  assert.equal(writes.length, 1);
  const [key, value] = Object.entries(writes[0])[0];
  assert.match(key, /^capture:/);
  assert.equal(value.kind, "text");
  assert.equal(value.content, "机器人的橙色围巾");
  assert.equal(value.source, "https://example.com");
});
test("extension capture crops at actual screenshot scale and never queues the full viewport", async () => {
  const code = await readFile(
    new URL("../public/background.js", import.meta.url),
    "utf8",
  );
  let listener, crop, canvasSize;
  const writes = [];
  const chrome = {
    runtime: {
      id: "test",
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
    },
    contextMenus: { onClicked: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 3 }],
      captureVisibleTab: async () => "data:image/png;base64,full",
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set(v) {
          writes.push(v);
        },
      },
    },
  };
  class Canvas {
    constructor(w, h) {
      canvasSize = [w, h];
    }
    getContext() {
      return {
        drawImage(...args) {
          crop = args.slice(1);
        },
      };
    }
    async convertToBlob() {
      return new Blob(["cropped-image"]);
    }
  }
  vm.runInNewContext(code, {
    chrome,
    crypto,
    console,
    fetch: async () => ({ blob: async () => new Blob(["full-image"]) }),
    createImageBitmap: async () => ({ width: 2000, height: 1600, close() {} }),
    OffscreenCanvas: Canvas,
    Uint8Array,
    Blob,
    atob,
    btoa,
  });
  const result = await new Promise((resolve) =>
    listener(
      {
        type: "CAPTURE_REGION",
        rect: {
          x: 10,
          y: 20,
          width: 100,
          height: 80,
          viewportWidth: 1000,
          viewportHeight: 800,
        },
      },
      {
        id: "test",
        tab: { id: 3, windowId: 1, title: "Web", url: "https://example.com" },
      },
      resolve,
    ),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(canvasSize, [200, 160]);
  assert.deepEqual(crop, [20, 40, 200, 160, 0, 0, 200, 160]);
  const capture = Object.values(writes[0])[0];
  assert.equal(
    capture.dataUrl,
    "data:image/png;base64," + btoa("cropped-image"),
  );
});
