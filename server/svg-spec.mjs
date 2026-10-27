import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";

export const specSkill = readFileSync(
  new URL("../agent-skills/svg-drawing/structured.md", import.meta.url),
  "utf8",
);
const text = { type: "string" };
export const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: [
        "bar",
        "line",
        "donut",
        "composition",
        "steps",
        "timeline",
        "list",
        "free",
      ],
    },
    title: text,
    subtitle: text,
    source: text,
    unit: text,
    totalLabel: text,
    total: { type: ["number", "null"] },
    totalEvidence: text,
    theme: { type: "string", enum: ["forest", "blue", "violet", "mono"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: text,
          description: text,
          value: { type: ["number", "null"] },
          evidence: text,
        },
        required: ["label", "description", "value", "evidence"],
      },
    },
  },
  required: [
    "kind",
    "title",
    "subtitle",
    "source",
    "unit",
    "totalLabel",
    "total",
    "totalEvidence",
    "theme",
    "items",
  ],
};
export const quantitative = new Set(["bar", "line", "donut", "composition"]);
const normalize = (s) => String(s).replace(/[,，\s]/g, "");
function hasValue(text, value) {
  return (normalize(text).match(/-?\d+(?:\.\d+)?/g) || []).some(
    (n) => Number(n) === value,
  );
}
export function sourceContext({ request, snapshot, references }) {
  return [
    request.instruction,
    request.selectionText,
    ...(snapshot.references || []).map((r) => r.content),
    ...references.map(({ asset }) => {
      if (asset.mime !== "image/svg+xml") return asset.content;
      const doc = new DOMParser().parseFromString(
        Buffer.from(asset.data || "").toString("utf8"),
        "image/svg+xml",
      );
      const labels = [...Array.from(doc.getElementsByTagName("text"))]
        .map((el) => el.textContent)
        .join("\n");
      return [labels, asset.svgSpec ? JSON.stringify(asset.svgSpec) : ""].join(
        "\n",
      );
    }),
    ...(snapshot.recentTurns || []).map((t) => t.instruction),
  ]
    .filter(Boolean)
    .join("\n");
}
export function validateSpec(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("绘图描述必须是 JSON 对象");
  const s = structuredClone(input);
  if (!SPEC_SCHEMA.properties.kind.enum.includes(s.kind))
    throw new Error("未知图表类型");
  for (const [key, max] of Object.entries({
    title: 32,
    subtitle: 70,
    source: 90,
    unit: 12,
    totalLabel: 20,
    totalEvidence: 500,
  })) {
    if (typeof s[key] !== "string" || s[key].length > max)
      throw new Error(`${key} 必须是 ${max} 字以内的文字`);
    s[key] = s[key].trim();
  }
  if (!s.title) throw new Error("缺少标题");
  if (!SPEC_SCHEMA.properties.theme.enum.includes(s.theme))
    throw new Error("未知配色");
  if (
    !Array.isArray(s.items) ||
    s.items.length > 8 ||
    (s.kind !== "free" && s.items.length < 2)
  )
    throw new Error("请使用 2–8 个数据项，复杂关系使用 free");
  const source = sourceContext(context),
    hasImage = context.references.some(
      (r) => r.asset.data && r.asset.mime !== "image/svg+xml",
    );
  function evidence(value, quote) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e15
    )
      throw new Error("数据必须是有限数字");
    if (typeof quote !== "string" || quote.length > 500)
      throw new Error("缺少数据原文");
    if (quote === "图片" && hasImage) return;
    if (
      !quote ||
      !normalize(source).includes(normalize(quote)) ||
      !hasValue(quote, value)
    )
      throw new Error(
        `数值 ${value} 找不到对应原文，请原样摘录 evidence，禁止猜测或换算`,
      );
  }
  const names = new Set();
  for (const item of s.items) {
    if (
      !item ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      item.label.length > 24 ||
      typeof item.description !== "string" ||
      item.description.length > 70
    )
      throw new Error("数据项标签最多 24 字、说明最多 70 字");
    item.label = item.label.trim();
    if (names.has(item.label)) throw new Error("数据项标签重复");
    names.add(item.label);
    if (quantitative.has(s.kind)) evidence(item.value, item.evidence);
    else if (item.value !== null)
      throw new Error("非统计信息图的 value 必须为 null");
  }
  if (s.total !== null) evidence(s.total, s.totalEvidence);
  if (["donut", "composition"].includes(s.kind)) {
    if (s.items.some((i) => i.value < 0)) throw new Error("比例图不能包含负数");
    const sum = s.items.reduce((a, b) => a + b.value, 0);
    if (sum <= 0) throw new Error("比例图合计必须大于零");
    if (
      s.total !== null &&
      Math.abs(sum - s.total) > Math.max(1e-6, Math.abs(s.total) * 1e-8)
    )
      throw new Error(
        "分项之和与总数不一致，请核对原文；不完整的数据请改用条形图",
      );
    if (s.unit === "%" && Math.abs(sum - 100) > 0.1)
      throw new Error("百分比合计不等于 100%，不能绘制完整构成图");
  }
  return s;
}
