import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";

export const svgSkill = readFileSync(
  new URL("../agent-skills/svg-drawing/SKILL.md", import.meta.url),
  "utf8",
);
const NS = "http://www.w3.org/2000/svg";
export const elements = new Set(
  "svg g defs rect circle ellipse line polyline polygon path text tspan title desc linearGradient radialGradient stop clipPath marker".split(
    " ",
  ),
);
export const attributes = new Set(
  "xmlns id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset paint-order opacity transform font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline dx dy letter-spacing textLength lengthAdjust preserveAspectRatio gradientUnits gradientTransform offset stop-color stop-opacity clip-path clipPathUnits marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits".split(
    " ",
  ),
);
export function dimensions(ratio) {
  return ratio === "1:1"
    ? [1000, 1000]
    : ratio === "2:3"
      ? [800, 1200]
      : [1200, 800];
}

export function validateSvg(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 400000)
    throw new Error("SVG 为空或超过 400 KB");
  const source = input
    .trim()
    .replace(/^```(?:svg|xml)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(source))
    throw new Error("SVG 不能包含 XML 声明、DOCTYPE 或实体声明");
  let invalid = false;
  const document = new DOMParser({
    onError: () => {
      invalid = true;
    },
  }).parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (invalid || !root || root.tagName !== "svg" || root.namespaceURI !== NS)
    throw new Error("SVG XML 或根命名空间无效");
  const size = [
    Number(root.getAttribute("width")),
    Number(root.getAttribute("height")),
  ];
  if (size.some((v) => !Number.isFinite(v) || v < 64 || v > 4096))
    throw new Error("SVG 画布尺寸必须为 64 到 4096 之间的数字");
  const box = (root.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    box.length !== 4 ||
    box[0] !== 0 ||
    box[1] !== 0 ||
    box[2] !== size[0] ||
    box[3] !== size[1]
  )
    throw new Error("viewBox 必须与画布尺寸一致");
  let count = 0;
  const visit = (node) => {
    if (++count > 10000) throw new Error("SVG 元素过多");
    if (node.nodeType === 1) {
      if (!elements.has(node.tagName) || node.namespaceURI !== NS)
        throw new Error(`不支持的 SVG 元素：${node.tagName}`);
      for (let i = 0; i < node.attributes.length; i++) {
        const a = node.attributes.item(i);
        if (!attributes.has(a.name))
          throw new Error(`不支持的 SVG 属性：${a.name}`);
        if (a.name === "xmlns" && a.value !== NS)
          throw new Error("SVG 命名空间无效");
        if (
          /javascript:|https?:|data:|file:|\\|@import/i.test(a.value) &&
          a.name !== "xmlns"
        )
          throw new Error("SVG 不能引用外部资源");
        if (
          /url\s*\(/i.test(a.value) &&
          !/^url\(#[a-zA-Z_][\w.-]*\)$/.test(a.value)
        )
          throw new Error("SVG 仅允许本地 ID 引用");
      }
    } else if (![3, 4, 8, 9].includes(node.nodeType))
      throw new Error("SVG 包含不支持的节点");
    for (const child of [
      ...Array.from({ length: node.childNodes?.length || 0 }, (_, i) =>
        node.childNodes.item(i),
      ),
    ])
      visit(child);
  };
  visit(document);
  return new XMLSerializer().serializeToString(root);
}

export function svgToPng(source) {
  const safe = validateSvg(source);
  return new Resvg(safe, {
    fitTo: { mode: "width", value: 1536 },
    font: { loadSystemFonts: true, defaultFontFamily: "Microsoft YaHei" },
  })
    .render()
    .asPng();
}

export const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function demoSvg(request, snapshot) {
  const [w, h] = dimensions(snapshot.settings.ratio);
  const input = request.selectionText || request.instruction;
  const values = [
    ...input.matchAll(/([\p{L}\p{N}]{1,10})\s*[：:]\s*(\d+(?:\.\d+)?)/gu),
  ].slice(0, 6);
  let body = "";
  if (values.length >= 2) {
    const max = Math.max(...values.map((v) => Number(v[2])), 1),
      span = (w - 160) / values.length;
    body = values
      .map((v, i) => {
        const height = ((h - 300) * Number(v[2])) / max,
          x = 80 + i * span;
        return `<rect x="${x}" y="${h - 140 - height}" width="${span * 0.6}" height="${height}" rx="6" fill="#52775e"/><text x="${x}" y="${h - 100}" font-size="24" fill="#254e3c">${xml(v[1])}</text><text x="${x}" y="${h - 155 - height}" font-size="24" fill="#254e3c">${xml(v[2])}</text>`;
      })
      .join("");
  } else {
    const chunks = input
      .split(/[→，,；;。\n]/)
      .filter((v) => v.trim())
      .slice(0, 4);
    if (!chunks.length) chunks.push("等待内容");
    body = chunks
      .map((v, i) => {
        const y = 140 + i * Math.min(135, (h - 230) / chunks.length);
        return `<rect x="60" y="${y}" width="${w - 120}" height="85" rx="14" fill="#e5ecde"/><text x="85" y="${y + 51}" font-size="26" fill="#254e3c">${i + 1}. ${xml(v.trim().slice(0, Math.floor((w - 190) / 26)))}</text>`;
      })
      .join("");
  }
  return validateSvg(
    `<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>SVG 路由演示</title><desc>规则生成的演示图，不是语言模型生成</desc><rect width="${w}" height="${h}" fill="#f8faf5"/><text x="60" y="70" font-family="sans-serif" font-size="28" fill="#254e3c">SVG 路由演示 · 非模型生成</text>${body}<text x="60" y="${h - 35}" font-size="18" fill="#77866f">${snapshot.references.length} 份项目参考 · 接入语言模型后使用 SVG skill 绘制</text></svg>`,
  );
}
