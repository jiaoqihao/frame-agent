import { renderStructuredSvg } from "../server/svg-renderer.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("test-results", { recursive: true });
const base = {
  title: "全国人口构成",
  subtitle: "总量与性别比例",
  source: "来源：用户提供数据",
  unit: "万人",
  totalLabel: "总人口",
  total: 140545,
  totalEvidence: "总人口140545万人",
  theme: "forest",
  items: [
    { label: "男性", description: "", value: 71722, evidence: "男性71722万人" },
    { label: "女性", description: "", value: 68823, evidence: "女性68823万人" },
  ],
};
for (const kind of [
  "composition",
  "donut",
  "bar",
  "line",
  "steps",
  "timeline",
  "list",
]) {
  for (const ratio of ["3:2", "2:3"]) {
    const spec = { ...base, kind };
    if (["steps", "timeline", "list"].includes(kind))
      Object.assign(spec, {
        title: "从选中文字到生成图片",
        subtitle: "Frame 自动完成整个过程",
        total: null,
        items: ["选择内容", "理解要求", "生成图片", "检查结果"].map(
          (label) => ({
            label,
            description: "结合项目记忆生成清晰的图像",
            value: null,
            evidence: "",
          }),
        ),
      });
    try {
      const r = await renderStructuredSvg(spec, ratio);
      writeFileSync(
        `test-results/engine-${kind}-${ratio.replace(":", "-")}.png`,
        r.png,
      );
      writeFileSync(
        `test-results/engine-${kind}-${ratio.replace(":", "-")}.svg`,
        r.svg,
      );
      console.log(kind, ratio, "PASS");
    } catch (e) {
      console.log(kind, ratio, e.message);
      process.exitCode = 1;
    }
  }
}
