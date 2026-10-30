import { readFileSync } from "node:fs";
import { validateSvg } from "./svg.mjs";
export const reviewSkill = readFileSync(
  new URL("../agent-skills/source-review/SKILL.md", import.meta.url),
  "utf8",
);
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    understanding: { type: "string" },
    suitability: {
      type: "string",
      enum: ["ready", "needs_adaptation", "needs_information"],
    },
    adaptedInstruction: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
  },
  required: [
    "understanding",
    "suitability",
    "adaptedInstruction",
    "changes",
    "uncertainties",
  ],
};
export function validateReview(review) {
  if (!review || typeof review !== "object")
    throw new Error("内容理解结果无效");
  for (const key of ["understanding", "adaptedInstruction"])
    if (
      typeof review[key] !== "string" ||
      !review[key].trim() ||
      review[key].length > 12000
    )
      throw new Error("内容理解缺少解释或绘图说明");
  if (!REVIEW_SCHEMA.properties.suitability.enum.includes(review.suitability))
    throw new Error("缺少内容适用性判断");
  for (const key of ["changes", "uncertainties"])
    if (
      !Array.isArray(review[key]) ||
      review[key].length > 20 ||
      review[key].some((s) => typeof s !== "string" || s.length > 2000)
    )
      throw new Error(
        `${key} 必须是最多 20 条的字符串数组，没有内容时返回 []，不得返回对象或 null`,
      );
  return review;
}
export async function reviewSource(
  provider,
  { request, snapshot, references },
) {
  const content = [
    {
      type: "input_text",
      text: JSON.stringify({ currentRequest: request, memory: snapshot }),
    },
  ];
  for (const { asset } of references.filter((r) => r.asset.data)) {
    content.push({
      type: "input_text",
      text: `参考素材 ${asset.id}：${asset.title}`,
    });
    content.push(
      asset.mime === "image/svg+xml"
        ? {
            type: "input_text",
            text: validateSvg(Buffer.from(asset.data).toString("utf8")),
          }
        : {
            type: "input_image",
            image_url: `data:${asset.mime};base64,${Buffer.from(asset.data).toString("base64")}`,
          },
    );
  }
  try {
    let output = await provider.complete(reviewSkill, content, REVIEW_SCHEMA);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return validateReview(JSON.parse(output));
      } catch (error) {
        if (attempt === 1) throw error;
        output = await provider.complete(
          reviewSkill,
          [
            ...content,
            {
              type: "input_text",
              text: `修复此结果的格式，保留原文事实。错误：${error.message}\n结果：${String(output).slice(0, 24000)}`,
            },
          ],
          REVIEW_SCHEMA,
        );
      }
    }
  } catch (error) {
    if (content.some((c) => c.type === "input_image"))
      throw new Error(
        `截图理解失败：${error.message} 请确认语言模型支持图片输入，或改用可读文字。`,
      );
    throw error;
  }
}
