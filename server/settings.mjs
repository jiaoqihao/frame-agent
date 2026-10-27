import { randomUUID } from "node:crypto";
import { InputError } from "./memory.mjs";
import { DemoProvider, OpenAIProvider } from "./providers.mjs";
import { ImageAPI } from "./image-api.mjs";

export function environmentSettings(env = process.env) {
  return {
    mode:
      env.PROVIDER === "live" || env.PROVIDER === "openai" ? "live" : "demo",
    llm: {
      baseUrl:
        env.LLM_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || "",
      model: env.LLM_MODEL || env.PLANNER_MODEL || "gpt-4.1-mini",
      apiStyle: env.LLM_API_STYLE || "responses",
    },
    image: {
      baseUrl:
        env.IMAGE_API_BASE_URL ||
        env.OPENAI_BASE_URL ||
        "https://api.openai.com/v1",
      apiKey:
        env.IMAGE_API_KEY ||
        (!env.IMAGE_API_BASE_URL ? env.OPENAI_API_KEY : "") ||
        "",
      model: env.IMAGE_API_MODEL || env.IMAGE_MODEL || "gpt-image-1",
      supportsEdit: env.IMAGE_API_SUPPORTS_EDIT !== "false",
      responseFormat: env.IMAGE_API_RESPONSE_FORMAT || "auto",
      downloadHosts: (env.IMAGE_DOWNLOAD_HOSTS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
  };
}
function string(value, label, max = 2048) {
  if (typeof value !== "string" || value.length > max)
    throw new InputError(`${label}格式无效`);
  return value.trim();
}
function baseUrl(value) {
  const text = string(value, "接口地址");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InputError("接口地址必须是完整的 http:// 或 https:// 地址");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new InputError("接口地址不能包含用户名、密码、查询参数或锚点");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new InputError("远程接口请使用 HTTPS；本机服务可以使用 HTTP");
  return url.href.replace(/\/+$/, "");
}
function section(input, old, label) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError(`${label}配置无效`);
  const address = baseUrl(input.baseUrl),
    model = string(input.model, "模型名称", 200);
  if (!model || /[\r\n]/.test(model)) throw new InputError("请填写模型名称");
  if (input.clearKey !== undefined && typeof input.clearKey !== "boolean")
    throw new InputError("清除密钥标记无效");
  const entered =
    input.apiKey === undefined ? "" : string(input.apiKey, "API 密钥", 8192);
  if (/[\s]/.test(entered)) throw new InputError("API 密钥不能包含空格或换行");
  // Changing provider origin never forwards a previously saved credential implicitly.
  const sameOrigin = new URL(address).origin === new URL(old.baseUrl).origin;
  const apiKey = input.clearKey
    ? ""
    : entered || (sameOrigin ? old.apiKey : "");
  return { baseUrl: address, model, apiKey };
}
export class ModelSettings {
  constructor({
    store,
    defaults = environmentSettings(),
    fetchFn = fetch,
    providerFactory,
  } = {}) {
    this.store = store;
    this.defaults = structuredClone(defaults);
    this.fetch = fetchFn;
    this.factory = providerFactory;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS model_settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, revision TEXT NOT NULL)",
    );
  }
  current() {
    const row = this.store.db
      .prepare("SELECT config,revision FROM model_settings WHERE id=1")
      .get();
    return row
      ? { ...JSON.parse(row.config), revision: row.revision, source: "saved" }
      : {
          ...structuredClone(this.defaults),
          revision: "environment",
          source: "environment",
        };
  }
  public() {
    const data = this.current();
    return {
      ...data,
      llm: { ...data.llm, apiKey: undefined, hasKey: Boolean(data.llm.apiKey) },
      image: {
        ...data.image,
        apiKey: undefined,
        hasKey: Boolean(data.image.apiKey),
      },
    };
  }
  candidate(input) {
    const old = this.current();
    if (!input || input.revision !== old.revision)
      throw new InputError(
        "配置已在其他窗口更新，请重新加载后再保存或检查连接",
        409,
      );
    if (!["demo", "live"].includes(input.mode))
      throw new InputError("运行模式无效");
    const llm = section(input.llm, old.llm, "语言模型"),
      image = section(input.image, old.image, "图片模型");
    if (!["responses", "chat"].includes(input.llm.apiStyle))
      throw new InputError("语言模型协议无效");
    if (typeof input.image.supportsEdit !== "boolean")
      throw new InputError("参考图支持选项无效");
    if (!["auto", "b64_json", "url"].includes(input.image.responseFormat))
      throw new InputError("图片返回格式无效");
    const hosts = input.image.downloadHosts;
    if (!Array.isArray(hosts) || hosts.length > 30)
      throw new InputError("图片下载域名列表无效");
    const downloadHosts = [
      ...new Set(
        hosts.map((host) => {
          const value = string(host, "下载域名", 253).toLowerCase();
          if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value))
            throw new InputError(
              "下载域名只填写主机名，例如 cdn.example.com，不含协议、路径或端口",
            );
          return value;
        }),
      ),
    ];
    return {
      mode: input.mode,
      llm: { ...llm, apiStyle: input.llm.apiStyle },
      image: {
        ...image,
        supportsEdit: input.image.supportsEdit,
        responseFormat: input.image.responseFormat,
        downloadHosts,
      },
    };
  }
  save(input) {
    const config = this.candidate(input),
      revision = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO model_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,revision=excluded.revision",
      )
      .run(JSON.stringify(config), revision);
    return this.public();
  }
  provider() {
    const config = this.current();
    const provider = this.factory
      ? this.factory(config)
      : config.mode === "demo"
        ? new DemoProvider()
        : new OpenAIProvider({
            apiKey: config.llm.apiKey,
            baseUrl: config.llm.baseUrl,
            plannerModel: config.llm.model,
            llmApiStyle: config.llm.apiStyle,
            fetchFn: this.fetch,
            imageApi: new ImageAPI({ ...config.image, fetchFn: this.fetch }),
          });
    return { provider, revision: config.revision };
  }
  async test(input, target) {
    if (!["llm", "image"].includes(target))
      throw new InputError("请选择要检查的模型类型");
    const config = this.candidate(input),
      selected = config[target];
    if (!selected.apiKey)
      throw new InputError(
        "请填写该接口的 API 密钥；更换服务域名后需要重新填写密钥",
      );
    let response;
    try {
      response = await this.fetch(selected.baseUrl + "/models", {
        headers: { Authorization: `Bearer ${selected.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new InputError("连接失败或超过 10 秒，请检查接口地址和网络", 502);
    }
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? "请检查 API 密钥或访问权限"
          : response.status === 404 || response.status === 405
            ? "此服务未提供 /models 检查接口，仍可保存后通过实际生成验证"
            : response.status === 429
              ? "服务限流或额度受限"
              : "请检查服务状态与接口地址";
      throw new InputError(`检查接口返回 ${response.status}：${hint}`, 502);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new InputError("服务没有返回有效的模型列表 JSON", 502);
    }
    if (!Array.isArray(payload.data))
      throw new InputError("返回格式不是兼容的模型列表；尚未验证连接", 502);
    const models = [
      ...new Set(
        payload.data
          .map((v) => v?.id)
          .filter((id) => typeof id === "string" && id.length <= 200),
      ),
    ].sort();
    const modelFound = models.includes(selected.model);
    return {
      connected: true,
      modelFound,
      models: models.slice(0, 500),
      message: modelFound
        ? "接口连接成功，列表包含当前模型。尚未验证实际生成能力。"
        : "接口连接成功，但返回列表未包含当前模型。可以选择列表中的模型，或核对服务文档。",
    };
  }
}
