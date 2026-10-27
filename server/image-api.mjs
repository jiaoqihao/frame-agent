import { svgToPng } from "./svg.mjs";

export class ImageAPI {
  constructor({
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    model = "gpt-image-1",
    fetchFn = fetch,
    supportsEdit = true,
    downloadHosts = [],
    responseFormat = "auto",
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.fetch = fetchFn;
    this.supportsEdit = supportsEdit;
    this.downloadHosts = downloadHosts;
    this.responseFormat = responseFormat;
  }
  async generate({ plan, snapshot, references }) {
    if (!this.apiKey)
      throw new Error(
        "Agent 已选择图片 API，请在插件「模型设置」中配置图片服务地址与密钥后重试。SVG 路线只需语言模型密钥。",
      );
    const size =
      { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" }[
        snapshot.settings.ratio
      ] || "1536x1024";
    const images = references.filter((r) => r.asset.data);
    if (images.length && !this.supportsEdit)
      throw new Error(
        "当前图片 API 未启用参考图编辑。请接入支持 /images/edits 的服务，或取消图片参考后生成新图。",
      );
    let body,
      path,
      headers = { Authorization: `Bearer ${this.apiKey}` };
    if (images.length) {
      path = "/images/edits";
      body = new FormData();
      body.set("model", this.model);
      body.set("prompt", plan.prompt);
      body.set("size", size);
      body.set("n", "1");
      if (this.responseFormat !== "auto")
        body.set("response_format", this.responseFormat);
      for (const { asset } of images) {
        const isSvg = asset.mime === "image/svg+xml",
          data = isSvg
            ? svgToPng(Buffer.from(asset.data).toString("utf8"))
            : asset.data,
          mime = isSvg ? "image/png" : asset.mime;
        body.append(
          "image[]",
          new Blob([data], { type: mime }),
          `${asset.id}.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`,
        );
      }
    } else {
      path = "/images/generations";
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        model: this.model,
        prompt: plan.prompt,
        size,
        n: 1,
        ...(this.responseFormat === "auto"
          ? {}
          : { response_format: this.responseFormat }),
      });
    }
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new Error("图片 API 连接失败或超时，请检查配置。");
    }
    if (!response.ok)
      throw new Error(
        `图片 API 返回 ${response.status}：${response.status === 429 ? "额度或速率受限" : response.status === 401 ? "请检查 IMAGE_API_KEY" : "请检查模型、接口格式或参考图支持情况"}。`,
      );
    const payload = await response.json(),
      item = payload.data?.[0];
    let data;
    if (item?.b64_json) {
      if (
        typeof item.b64_json !== "string" ||
        item.b64_json.length > 32 * 1024 * 1024
      )
        throw new Error("图片 API 返回的图片过大或格式无效");
      data = Buffer.from(item.b64_json, "base64");
    } else if (item?.url) {
      const url = new URL(item.url),
        allowed = new Set([
          new URL(this.baseUrl).hostname,
          ...this.downloadHosts,
        ]);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !allowed.has(url.hostname)
      )
        throw new Error(
          "图片下载域名未允许。请把 API 返回的图片域名加入 IMAGE_DOWNLOAD_HOSTS，或配置 base64 返回格式。",
        );
      const image = await this.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!image.ok)
        throw new Error("图片生成成功，但下载失败，请检查图片 API 的返回链接");
      const parts = [];
      let length = 0;
      for await (const chunk of image.body) {
        length += chunk.length;
        if (length > 24 * 1024 * 1024) throw new Error("返回图片超过 24 MB");
        parts.push(chunk);
      }
      data = Buffer.concat(parts);
    } else
      throw new Error(
        "图片 API 未返回 data[0].b64_json 或 data[0].url，请检查兼容接口格式",
      );
    const mime = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : data[0] === 255 && data[1] === 216
        ? "image/jpeg"
        : data.toString("ascii", 0, 4) === "RIFF" &&
            data.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
    if (!mime) throw new Error("图片 API 返回的内容不是 PNG、JPEG 或 WebP");
    return { mime, data };
  }
}
