import { readFileSync } from "node:fs";

export const imagePromptSkill = readFileSync(
  new URL("../agent-skills/image-prompt/SKILL.md", import.meta.url),
  "utf8",
);
const string = { type: "string" };
const strings = { type: "array", items: string };
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
export const IMAGE_BRIEF_SCHEMA = object({
  intent: string,
  scene: string,
  subject: string,
  composition: string,
  appearance: string,
  lighting: string,
  text: {
    type: "array",
    items: object({ text: string, placement: string, typography: string }),
  },
  references: {
    type: "array",
    items: object({
      imageIndex: { type: "integer" },
      role: string,
      use: string,
    }),
  },
  preserve: strings,
  changes: strings,
  constraints: strings,
});

// Same filter and ordering as ImageAPI's multipart attachments, including SVGs.
export function imageInputs(references, request) {
  return references
    .filter(({ asset }) => asset.data)
    .map(({ asset, reason }, i) => ({
      imageIndex: i + 1,
      assetId: asset.id,
      title: asset.title,
      role:
        request.mode === "edit" && asset.id === request.baseAssetId
          ? "edit_target"
          : "reference",
      reason,
    }));
}

export function validateBrief(value, inputs, mode) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("绘图说明必须是对象");
  for (const key of [
    "intent",
    "scene",
    "subject",
    "composition",
    "appearance",
    "lighting",
  ])
    if (typeof value[key] !== "string" || value[key].length > 3000)
      throw new Error(`绘图说明缺少有效的 ${key}`);
  if (!value.subject.trim() || !value.composition.trim())
    throw new Error("绘图说明缺少主体或构图");
  for (const key of ["preserve", "changes", "constraints"])
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 30 ||
      value[key].some((s) => typeof s !== "string" || s.length > 2000)
    )
      throw new Error(`绘图说明 ${key} 格式无效`);
  if (
    !Array.isArray(value.text) ||
    value.text.length > 40 ||
    value.text.some(
      (t) =>
        !t ||
        ["text", "placement", "typography"].some(
          (k) => typeof t[k] !== "string" || !t[k].trim() || t[k].length > 3000,
        ),
    )
  )
    throw new Error("画面文字需要原文、位置和排版说明");
  if (
    !Array.isArray(value.references) ||
    value.references.length !== inputs.length ||
    new Set(value.references.map((r) => r?.imageIndex)).size !==
      inputs.length ||
    value.references.some(
      (r) =>
        !r ||
        !Number.isInteger(r.imageIndex) ||
        !inputs.some((i) => i.imageIndex === r.imageIndex) ||
        ["role", "use"].some(
          (k) => typeof r[k] !== "string" || !r[k].trim() || r[k].length > 2000,
        ),
    )
  )
    throw new Error("参考图编号或用途与实际图片不一致");
  if (
    mode === "edit" &&
    (!value.preserve.some((s) => s.trim()) ||
      !value.changes.some((s) => s.trim()))
  )
    throw new Error("修改图片需要明确变化和保留项");
  return value;
}

export function compileImagePrompt(brief, inputs, request, ratio) {
  const lines = [];
  for (const [key, label] of [
    ["intent", "用途"],
    ["scene", "场景"],
    ["subject", "主体"],
    ["composition", "构图"],
    ["appearance", "视觉表现"],
    ["lighting", "光照与材质"],
  ])
    if (brief[key].trim()) lines.push(`${label}：${brief[key].trim()}`);
  lines.push(`画幅比例：${ratio}。`);
  if (inputs.length) {
    lines.push("参考图（按附件顺序）：");
    for (const input of inputs) {
      const ref = brief.references.find(
        (r) => r.imageIndex === input.imageIndex,
      );
      lines.push(
        `图 ${input.imageIndex}${input.role === "edit_target" ? "（本次修改的原图）" : ""}：${ref.role}；${ref.use}`,
      );
    }
  }
  if (brief.text.length) {
    lines.push(
      "画面文字（逐字呈现，保留原始语言、标点与大小写，不添加额外文案；每条默认出现一次）：",
    );
    for (const item of brief.text)
      lines.push(
        `${JSON.stringify(item.text)}；位置：${item.placement}；排版：${item.typography}。确保清晰可读。`,
      );
  } else
    lines.push(
      request.mode === "edit"
        ? "不新增文字；原有文字按下列变化与保留项处理。"
        : "不添加未经要求的文字、标志或水印。",
    );
  if (brief.changes.length) lines.push(`本次变化：${brief.changes.join("；")}`);
  if (brief.preserve.length)
    lines.push(`保持不变：${brief.preserve.join("；")}`);
  if (request.mode === "edit")
    lines.push("仅实施上述指定修改，其余内容保持原样。");
  if (brief.constraints.length)
    lines.push(`约束：${brief.constraints.join("；")}`);
  return lines.join("\n");
}

export async function refineImagePrompt(provider, context, content) {
  const { request, references, snapshot, plan } = context;
  const inputs = imageInputs(references, request);
  const input = [
    ...content,
    {
      type: "input_text",
      text: JSON.stringify({
        selectedRenderer: plan.renderer,
        imageInputs: inputs,
      }),
    },
  ];
  let output = await provider.complete(
    imagePromptSkill,
    input,
    IMAGE_BRIEF_SCHEMA,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const brief = validateBrief(JSON.parse(output), inputs, request.mode);
      const prompt = compileImagePrompt(
        brief,
        inputs,
        request,
        snapshot.settings.ratio,
      );
      if (prompt.length > 24000) throw new Error("绘图说明过长，请精简");
      return {
        ...plan,
        summary: brief.intent.trim() || plan.summary,
        prompt,
        preserved: brief.preserve,
        changes: brief.changes,
        imageBrief: brief,
        promptQuality: {
          skill: "image-prompt-v1",
          repairs: attempt,
          checks: ["结构完整", "参考图编号", "编辑保留项"],
        },
      };
    } catch (error) {
      if (attempt === 1)
        throw new Error(`图片提示词检查失败：${error.message}`);
      output = await provider.complete(
        imagePromptSkill,
        [
          ...input,
          {
            type: "input_text",
            text: `修正以下输出，仍遵循原始需求。错误：${error.message}\n待修正数据：${String(output).slice(0, 24000)}`,
          },
        ],
        IMAGE_BRIEF_SCHEMA,
      );
    }
  }
}
