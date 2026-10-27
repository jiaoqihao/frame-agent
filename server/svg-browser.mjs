import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { elements, attributes, validateSvg } from "./svg.mjs";
const require = createRequire(import.meta.url);
const antvBundle = resolve(
  dirname(require.resolve("@antv/infographic")),
  "../dist/infographic.min.js",
);
export const FONT = "Microsoft YaHei, Noto Sans CJK SC, sans-serif";

export async function withRenderPage(width, height, fn) {
  const executablePath =
    process.env.FRAME_BROWSER_PATH ||
    [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ].find(existsSync);
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(15000);
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      '<html><body style="margin:0"><div id="canvas"></div></body></html>',
    );
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function antvSvg(page, options) {
  await page.addScriptTag({ path: antvBundle });
  return page.evaluate(async (options) => {
    const instance = new window.AntVInfographic.Infographic({
      container: "#canvas",
      editable: false,
      ...options,
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("信息图渲染超时")),
          12000,
        );
        instance.on("loaded", () => {
          clearTimeout(timer);
          resolve();
        });
        instance.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(String(e?.message || "信息图渲染失败")));
        });
        instance.render();
      });
      await document.fonts.ready;
      const svg = document.querySelector("#canvas svg");
      if (!svg) throw new Error("信息图未输出 SVG");
      // AntV wraps text with foreignObject. Convert actual measured lines to SVG text,
      // so saved assets remain portable and never need HTML in the public SVG policy.
      const ns = "http://www.w3.org/2000/svg";
      const inverse = svg.getScreenCTM().inverse();
      for (const foreign of [...svg.querySelectorAll("foreignObject")]) {
        const walker = document.createTreeWalker(foreign, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.textContent.trim()) continue;
          const style = getComputedStyle(node.parentElement);
          const size = parseFloat(style.fontSize),
            screenScale = Math.hypot(
              foreign.getScreenCTM().a,
              foreign.getScreenCTM().b,
            );
          let line = null;
          for (let i = 0; i < node.textContent.length; i++) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            if (!line || Math.abs(line.top - rect.top) > 2) {
              const start = new DOMPoint(
                rect.left,
                rect.bottom - size * screenScale * 0.2,
              ).matrixTransform(inverse);
              const text = document.createElementNS(ns, "text");
              text.setAttribute("x", String(start.x));
              text.setAttribute("y", String(start.y));
              text.setAttribute(
                "font-size",
                String(size * screenScale * inverse.a),
              );
              text.setAttribute("font-family", style.fontFamily);
              text.setAttribute("font-weight", style.fontWeight);
              text.setAttribute("fill", style.color);
              svg.appendChild(text);
              line = { top: rect.top, node: text };
            }
            line.node.textContent += node.textContent[i];
          }
        }
        foreign.remove();
      }
      return (
        await window.AntVInfographic.exportToSVG(svg, {
          embedResources: false,
          removeIds: false,
        })
      ).outerHTML;
    } finally {
      instance.destroy();
    }
  }, options);
}

// Only used on trusted engine output. Model-written SVG must pass validateSvg unchanged.
export async function normalizeEngineSvg(page, source, width, height) {
  return page.evaluate(
    ({ source, width, height, allowedElements, allowedAttributes }) => {
      const documentSvg = new DOMParser().parseFromString(
        source,
        "image/svg+xml",
      );
      const root = documentSvg.documentElement;
      const allowed = new Set(allowedAttributes);
      const tags = new Set(allowedElements);
      const box = (root.getAttribute("viewBox") || `0 0 ${width} ${height}`)
        .split(/[ ,]+/)
        .map(Number);
      if (
        box.length !== 4 ||
        box.some((v) => !Number.isFinite(v)) ||
        box[2] <= 0 ||
        box[3] <= 0
      )
        throw new Error("引擎画布无效");
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (el.tagName === "style") {
          el.remove();
          continue;
        }
        if (!tags.has(el.tagName))
          throw new Error(`引擎输出了不支持的元素：${el.tagName}`);
        if (el.hasAttribute("style")) {
          for (const name of el.style)
            if (allowed.has(name) && name !== "transform")
              el.setAttribute(name, el.style.getPropertyValue(name));
        }
        for (const attr of [...el.attributes])
          if (!allowed.has(attr.name)) el.removeAttribute(attr.name);
        if (el.hasAttribute("font-family"))
          el.setAttribute(
            "font-family",
            "Microsoft YaHei, Noto Sans CJK SC, sans-serif",
          );
      }
      return { svg: root.outerHTML, box };
    },
    {
      source,
      width,
      height,
      allowedElements: [...elements],
      allowedAttributes: [...attributes],
    },
  );
}

export async function inspectSvg(page, source, width, height) {
  const safe = validateSvg(source);
  await page.evaluate((svg) => {
    document.getElementById("canvas").innerHTML = svg;
  }, safe);
  await page.evaluate(() => document.fonts.ready);
  const issues = await page.evaluate(
    ({ width, height }) => {
      const issues = [],
        root = document.querySelector("#canvas svg");
      const outer = root.getBoundingClientRect();
      const texts = [...root.querySelectorAll("text")].filter(
        (el) => !el.closest("defs"),
      );
      const boxes = texts
        .map((el) => ({
          el,
          text: el.textContent,
          rect: el.getBoundingClientRect(),
        }))
        .filter((v) => v.text.trim());
      for (const { el, text, rect } of boxes) {
        if (
          rect.left < outer.left - 2 ||
          rect.right > outer.right + 2 ||
          rect.top < outer.top - 2 ||
          rect.bottom > outer.bottom + 2
        )
          issues.push(`文字超出画布：${text.slice(0, 30)}`);
        const matrix = el.getScreenCTM();
        if (
          rect.height > 0 &&
          parseFloat(getComputedStyle(el).fontSize) *
            Math.hypot(matrix.a, matrix.b) <
            16
        )
          issues.push(`文字过小：${text.slice(0, 30)}`);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].rect,
            b = boxes[j].rect;
          const overlap =
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (overlap > Math.min(a.width * a.height, b.width * b.height) * 0.08)
            issues.push(
              `文字重叠：${boxes[i].text.slice(0, 20)} / ${boxes[j].text.slice(0, 20)}`,
            );
        }
      return [...new Set(issues)].slice(0, 15);
    },
    { width, height },
  );
  const png = await page
    .locator("#canvas > svg")
    .screenshot({ type: "png", timeout: 15000 });
  return { issues, png };
}
