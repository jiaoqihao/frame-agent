import * as echarts from "echarts";
import {
  FONT,
  antvSvg,
  normalizeEngineSvg,
  inspectSvg,
  withRenderPage,
} from "./svg-browser.mjs";
import { dimensions, xml, validateSvg } from "./svg.mjs";

export const THEMES = {
  forest: [
    "#254E3C",
    "#DF873D",
    "#80A68C",
    "#A18AB6",
    "#A3A862",
    "#719FA6",
    "#BA7C82",
    "#899484",
  ],
  blue: ["#2455A5", "#E6A04A", "#60A6BE", "#8C83BB"],
  violet: ["#6B47A5", "#D8915B", "#829FBA", "#A0B186"],
  mono: ["#263B45", "#647886", "#9BA9AF", "#C2CBCF"],
};
const label = (s) => s.replace(/[<>]/g, (c) => (c === "<" ? "＜" : "＞"));
const number = (v) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(v);
function lines(text, max) {
  const result = [];
  let line = "",
    len = 0;
  for (const c of text) {
    const n = /[\x00-\xff]/.test(c) ? 0.55 : 1;
    if (len + n > max) {
      result.push(line);
      line = "";
      len = 0;
    }
    line += c;
    len += n;
  }
  if (line) result.push(line);
  return result;
}
function textBlock(value, x, y, size, max, color = "#263B31", weight = 400) {
  return lines(value, max)
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * size * 1.45}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(line)}</text>`,
    )
    .join("");
}
function frame(spec, w, h, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><title>${xml(spec.title)}</title><desc>${xml(spec.subtitle)}</desc><rect width="${w}" height="${h}" fill="#FAF9F5"/><rect x="48" y="48" width="6" height="42" rx="3" fill="${THEMES[spec.theme][0]}"/>${textBlock(spec.title, 76, 80, 36, (w - 132) / 36, "#263B31", 700)}${textBlock(spec.subtitle, 56, 150, 21, (w - 112) / 21, "#58675E")}<line x1="56" y1="195" x2="${w - 56}" y2="195" stroke="#DCE2D8"/>${content}${textBlock(spec.source, 56, h - 38, 18, (w - 112) / 18, "#657268")}</svg>`;
}
async function chartSvg(page, s, w, h) {
  const colors = THEMES[s.theme],
    cw = w - 112;
  let height = h - 290,
    top = 220,
    option,
    extra = "";
  const values = s.items.map((i) => i.value),
    sum = values.reduce((a, b) => a + b, 0);
  const common = {
    animation: false,
    color: colors,
    textStyle: { fontFamily: FONT, fontSize: 22 },
    tooltip: { show: false },
  };
  if (s.kind === "composition") {
    height = 100;
    top = s.total !== null ? 360 : 245;
    if (s.total !== null)
      extra +=
        textBlock(s.totalLabel || "合计", 56, 245, 22, 25, "#58675E") +
        textBlock(
          `${number(s.total)} ${s.unit}`,
          56,
          315,
          52,
          (w - 112) / 52,
          colors[0],
          700,
        );
    option = {
      ...common,
      grid: { left: 0, right: 0, top: 10, bottom: 10 },
      xAxis: { type: "value", max: sum, show: false },
      yAxis: { type: "category", data: [""], show: false },
      series: s.items.map((item, i) => ({
        type: "bar",
        stack: "total",
        data: [item.value],
        barWidth: 60,
        itemStyle: { color: colors[i % colors.length] },
      })),
    };
    const columns = w >= 1000 && s.items.length > 4 ? 4 : 2,
      cardWidth = cw / columns;
    extra += s.items
      .map((item, i) => {
        const x = 56 + (i % columns) * cardWidth,
          y = top + 140 + Math.floor(i / columns) * 105;
        return (
          `<rect x="${x}" y="${y - 18}" width="10" height="24" rx="3" fill="${colors[i % colors.length]}"/>` +
          textBlock(item.label, x + 24, y, 23, (cardWidth - 35) / 23) +
          textBlock(
            `${number(item.value)} ${s.unit}  ·  ${((item.value / sum) * 100).toFixed(2)}%`,
            x + 24,
            y + 40,
            22,
            (cardWidth - 35) / 22,
            "#58675E",
          )
        );
      })
      .join("");
  } else if (s.kind === "donut") {
    option = {
      ...common,
      series: [
        {
          type: "pie",
          radius: ["36%", "60%"],
          center: ["50%", "44%"],
          avoidLabelOverlap: true,
          minShowLabelAngle: 5,
          label: {
            show: true,
            position: "outside",
            fontSize: 22,
            color: "#263B31",
            textBorderWidth: 0,
            formatter: (p) =>
              `${p.name}\n${number(p.value)} ${s.unit}\n${p.percent}%`,
            lineHeight: 32,
          },
          labelLine: { length: 20, length2: 20 },
          data: s.items.map((i) => ({ name: label(i.label), value: i.value })),
        },
      ],
      legend: {
        bottom: 0,
        left: "center",
        textStyle: { fontFamily: FONT, fontSize: 20 },
        itemGap: 24,
      },
    };
  } else if (s.kind === "bar") {
    option = {
      ...common,
      grid: { left: 155, right: 105, top: 32, bottom: 55 },
      xAxis: {
        type: "value",
        splitNumber: w < 1000 ? 3 : 5,
        name: s.unit,
        nameTextStyle: { fontSize: 20 },
        axisLabel: { fontSize: 20 },
        splitLine: { lineStyle: { color: "#E2E7DF" } },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: s.items.map((i) => label(i.label)),
        axisLabel: {
          fontSize: 22,
          formatter: (v) => lines(v, 6).join("\n"),
          lineHeight: 28,
        },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 54,
          data: s.items.map((item, i) => ({
            value: item.value,
            itemStyle: { color: colors[i % colors.length] },
          })),
          label: {
            show: true,
            position: "right",
            fontSize: 22,
            formatter: (p) => number(p.value),
          },
        },
      ],
    };
  } else {
    option = {
      ...common,
      grid: { left: 85, right: 45, top: 50, bottom: 100 },
      xAxis: {
        type: "category",
        data: s.items.map((i) => label(i.label)),
        axisLabel: {
          fontSize: 19,
          interval: 0,
          formatter: (v) => lines(v, 4).join("\n"),
          lineHeight: 25,
        },
      },
      yAxis: {
        type: "value",
        name: s.unit,
        nameTextStyle: { fontSize: 20 },
        axisLabel: { fontSize: 20 },
        splitLine: { lineStyle: { color: "#E2E7DF" } },
      },
      series: [
        {
          type: "line",
          data: values,
          symbolSize: 12,
          lineStyle: { width: 4 },
          label: { show: true, fontSize: 19, position: "top" },
          smooth: false,
        },
      ],
    };
  }
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: cw,
    height,
  });
  let raw;
  try {
    chart.setOption(option);
    raw = chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
  const normalized = await normalizeEngineSvg(page, raw, cw, height);
  const inner = normalized.svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "");
  return frame(
    s,
    w,
    h,
    `<g transform="translate(56 ${top})">${inner}</g>${extra}`,
  );
}
async function infographicSvg(page, s, w, h) {
  const templates = {
    steps:
      s.items.length > 4
        ? "sequence-snake-steps-simple"
        : w < h
          ? "list-column-simple-vertical-arrow"
          : "list-row-simple-horizontal-arrow",
    timeline: "sequence-timeline-simple",
    list: "list-grid-badge-card",
  };
  const colors = THEMES[s.theme];
  const snake =
    s.items.length > 4 &&
    (s.kind === "steps" || (s.kind === "timeline" && w >= h));
  const design =
    s.kind === "list"
      ? {
          title: "default",
          structure: {
            type: "list-grid",
            columns: w < h || s.items.length === 4 ? 2 : 3,
          },
          items: [{ type: "badge-card" }],
        }
      : snake
        ? {
            title: "default",
            structure: {
              type: "sequence-snake-steps",
              itemsPerRow: w < h ? 2 : 4,
            },
            items: [{ type: "simple" }],
          }
        : undefined;
  const raw = await antvSvg(page, {
    width: w - 112,
    height: h - 290,
    padding: 24,
    template: templates[s.kind],
    design,
    data: {
      items: s.items.map((i) => ({
        label: label(i.label),
        desc: label(i.description),
      })),
    },
    themeConfig: {
      colorPrimary: colors[0],
      colorBg: "#FAF9F5",
      palette: colors,
      base: { text: { "font-family": FONT } },
    },
  });
  const { svg, box } = await normalizeEngineSvg(page, raw, w - 112, h - 290);
  const scale = Math.min((w - 112) / box[2], (h - 290) / box[3]);
  const x = 56 + (w - 112 - box[2] * scale) / 2,
    y = 220 + (h - 290 - box[3] * scale) / 2;
  return frame(
    s,
    w,
    h,
    `<g transform="translate(${x} ${y}) scale(${scale}) translate(${-box[0]} ${-box[1]})">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g>`,
  );
}
export async function renderStructuredSvg(spec, ratio) {
  const [w, h] = dimensions(ratio);
  return withRenderPage(w, h, async (page) => {
    const engine = ["steps", "list", "timeline"].includes(spec.kind)
      ? "antv"
      : "echarts";
    const svg = validateSvg(
      await (engine === "antv"
        ? infographicSvg(page, spec, w, h)
        : chartSvg(page, spec, w, h)),
    );
    const checked = await inspectSvg(page, svg, w, h);
    if (checked.issues.length) throw new Error(checked.issues.join("；"));
    return {
      svg,
      png: checked.png,
      engine,
      checks: [
        "data-evidence",
        "geometry-by-engine",
        "text-bounds",
        "text-overlap",
      ],
    };
  });
}
