import { useEffect, useState } from "react";
import {
  Aperture,
  ArrowUpRight,
  Check,
  ChevronDown,
  Image,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Shapes,
  SlidersHorizontal,
  Wifi,
} from "lucide-react";
import { api, isExtension } from "./api";

type Common = {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  apiKey?: string;
  clearKey?: boolean;
};
type Config = {
  mode: "demo" | "live";
  revision: string;
  source: string;
  llm: Common & { apiStyle: "responses" | "chat" };
  image: Common & {
    supportsEdit: boolean;
    responseFormat: "auto" | "b64_json" | "url";
    downloadHosts: string[];
  };
};
type CheckResult = {
  connected: boolean;
  modelFound: boolean;
  models: string[];
  message: string;
};
type Target = "llm" | "image";
const emptyKeys = (data: Config): Config => ({
  ...data,
  llm: { ...data.llm, apiKey: "", clearKey: false },
  image: { ...data.image, apiKey: "", clearKey: false },
});

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null),
    [saved, setSaved] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState<Target | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [results, setResults] = useState<Partial<Record<Target, CheckResult>>>(
      {},
    ),
    [checkErrors, setCheckErrors] = useState<Partial<Record<Target, string>>>(
      {},
    );
  const [hosts, setHosts] = useState("");
  const [loading, setLoading] = useState(true);
  const dirty = Boolean(
    config &&
    saved &&
    (JSON.stringify(config) !== JSON.stringify(saved) ||
      hosts !== saved.image.downloadHosts.join(", ")),
  );
  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = emptyKeys(await api<Config>("/api/settings"));
      setConfig(data);
      setSaved(data);
      setHosts(data.image.downloadHosts.join(", "));
      setResults({});
      setCheckErrors({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  function patch(target: Target, values: Partial<Config[Target]>) {
    setConfig((prev) =>
      prev ? { ...prev, [target]: { ...prev[target], ...values } } : prev,
    );
    setResults((prev) => ({ ...prev, [target]: undefined }));
    setCheckErrors((prev) => ({ ...prev, [target]: undefined }));
    setNotice("");
  }
  function payload() {
    return {
      ...config!,
      image: {
        ...config!.image,
        downloadHosts: hosts
          .split(/[,，\n]/)
          .map((v) => v.trim())
          .filter(Boolean),
      },
    };
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = emptyKeys(
        await api<Config>("/api/settings", payload(), "PATCH"),
      );
      setConfig(data);
      setSaved(data);
      setHosts(data.image.downloadHosts.join(", "));
      setNotice("设置已保存，新任务立即生效。");
      if (isExtension)
        await chrome.storage.local.set({
          modelSettingsRevision: data.revision,
        });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function check(target: Target) {
    setChecking(target);
    setCheckErrors((prev) => ({ ...prev, [target]: undefined }));
    try {
      const result = await api<CheckResult>("/api/settings/test", {
        target,
        config: payload(),
      });
      setResults((prev) => ({ ...prev, [target]: result }));
    } catch (e) {
      setCheckErrors((prev) => ({ ...prev, [target]: (e as Error).message }));
    } finally {
      setChecking(null);
    }
  }
  function keyHint(target: Target) {
    if (!config || !saved) return "";
    let changed = false;
    try {
      changed =
        new URL(config[target].baseUrl).origin !==
        new URL(saved[target].baseUrl).origin;
    } catch {
      changed = true;
    }
    return config[target].clearKey
      ? "保存后将清除密钥"
      : changed && saved[target].hasKey
        ? "服务域名已改变，请重新填写密钥"
        : config[target].hasKey
          ? "已有密钥，留空保持不变"
          : "尚未保存密钥";
  }
  const disabled = busy || Boolean(checking) || loading;
  return (
    <div className="settings-shell">
      <header className="settings-header">
        <a href="index.html" className="settings-brand">
          <span>
            <Aperture size={23} />
          </span>
          frame.
        </a>
        <span>插件设置</span>
        <a className="text-button" href="index.html">
          生图面板
          <ArrowUpRight size={14} />
        </a>
      </header>
      <main className="settings-content">
        <div className="settings-title">
          <div>
            <h1>模型设置</h1>
            <p>语言模型用于解释和绘图，图片模型用于人物、风景。</p>
          </div>
          <SlidersHorizontal size={30} strokeWidth={1.3} />
        </div>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            {(!config || error.includes("其他窗口")) && (
              <button onClick={() => void load()}>
                {config ? "重新读取设置" : "重试连接"}
              </button>
            )}
          </div>
        )}
        {loading ? (
          <div className="loading">
            <LoaderCircle className="spin" size={20} />
            正在读取模型设置…
          </div>
        ) : (
          config && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <section className="settings-mode card">
                <div>
                  <h2>运行模式</h2>
                </div>
                <div
                  className="settings-segment"
                  role="group"
                  aria-label="运行模式"
                >
                  <button
                    type="button"
                    aria-pressed={config.mode === "demo"}
                    disabled={disabled}
                    className={config.mode === "demo" ? "active" : ""}
                    onClick={() => {
                      setConfig({ ...config, mode: "demo" });
                      setNotice("");
                    }}
                  >
                    演示模式
                  </button>
                  <button
                    type="button"
                    aria-pressed={config.mode === "live"}
                    disabled={disabled}
                    className={config.mode === "live" ? "active" : ""}
                    onClick={() => {
                      setConfig({ ...config, mode: "live" });
                      setNotice("");
                    }}
                  >
                    真实模型
                  </button>
                </div>
              </section>
              <p className="settings-mode-note">
                {config.mode === "demo"
                  ? "演示输出为示例，不调用生成模型。"
                  : "按需配置；只用解释和 SVG 时，仅需语言模型。"}
              </p>
              <div className="settings-grid">
                {(["llm", "image"] as Target[]).map((target) => {
                  const item = config[target],
                    result = results[target],
                    isLLM = target === "llm";
                  return (
                    <section className="card provider-card" key={target}>
                      <div className="provider-heading">
                        <span className={`provider-icon ${target}`}>
                          {isLLM ? <Shapes size={23} /> : <Image size={23} />}
                        </span>
                        <div>
                          <h2>{isLLM ? "语言模型" : "图片模型"}</h2>
                          <p>
                            {isLLM
                              ? "理解内容 · 自动选路 · SVG skill"
                              : "人物风景 · 图片生成 · 参考图编辑"}
                          </p>
                        </div>
                        <span className="provider-step">
                          {isLLM ? "01" : "02"}
                        </span>
                      </div>
                      <label className="field">
                        {isLLM ? "语言模型接口地址" : "图片模型接口地址"}
                        <input
                          type="url"
                          autoComplete="off"
                          spellCheck={false}
                          value={item.baseUrl}
                          disabled={disabled}
                          required
                          onChange={(e) =>
                            patch(target, { baseUrl: e.target.value })
                          }
                          placeholder="https://api.example.com/v1"
                        />
                      </label>
                      <p className="field-hint">
                        填写 Base URL，通常以 /v1 结尾。
                      </p>
                      <label className="field">
                        {isLLM ? "语言模型 API 密钥" : "图片模型 API 密钥"}
                        <div className="secret-input">
                          <KeyRound size={15} />
                          <input
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            value={item.apiKey || ""}
                            disabled={disabled}
                            onChange={(e) =>
                              patch(target, {
                                apiKey: e.target.value,
                                clearKey: false,
                              })
                            }
                            placeholder={
                              item.hasKey
                                ? "已保存，留空保持原密钥"
                                : "粘贴此服务的 API Key"
                            }
                          />
                        </div>
                      </label>
                      <div className="key-state">
                        <span>{keyHint(target)}</span>
                        {item.hasKey && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={disabled}
                            onClick={() =>
                              patch(target, {
                                clearKey: !item.clearKey,
                                apiKey: "",
                              })
                            }
                          >
                            {item.clearKey ? "撤销清除" : "清除已存密钥"}
                          </button>
                        )}
                      </div>
                      <label className="field">
                        {isLLM ? "语言模型名称" : "图片模型名称"}
                        <input
                          list={`${target}-models`}
                          autoComplete="off"
                          spellCheck={false}
                          value={item.model}
                          disabled={disabled}
                          required
                          onChange={(e) =>
                            patch(target, { model: e.target.value })
                          }
                          placeholder="填写服务提供的模型 ID"
                        />
                      </label>
                      <datalist id={`${target}-models`}>
                        {result?.models.map((model) => (
                          <option key={model} value={model} />
                        ))}
                      </datalist>
                      {isLLM ? (
                        <label className="field">
                          语言模型协议
                          <select
                            aria-label="语言模型协议"
                            value={config.llm.apiStyle}
                            disabled={disabled}
                            onChange={(e) =>
                              patch("llm", {
                                apiStyle: e.target.value as
                                  "responses" | "chat",
                              })
                            }
                          >
                            <option value="responses">Responses API</option>
                            <option value="chat">
                              Chat Completions（兼容接口）
                            </option>
                          </select>
                        </label>
                      ) : (
                        <label className="field">
                          图片返回格式
                          <select
                            aria-label="图片返回格式"
                            value={config.image.responseFormat}
                            disabled={disabled}
                            onChange={(e) =>
                              patch("image", {
                                responseFormat: e.target.value as
                                  "auto" | "b64_json" | "url",
                              })
                            }
                          >
                            <option value="auto">服务默认</option>
                            <option value="b64_json">Base64 图片</option>
                            <option value="url">图片下载 URL</option>
                          </select>
                        </label>
                      )}
                      {!isLLM && (
                        <>
                          <label className="settings-checkbox">
                            <input
                              type="checkbox"
                              checked={config.image.supportsEdit}
                              disabled={disabled}
                              onChange={(e) =>
                                patch("image", {
                                  supportsEdit: e.target.checked,
                                })
                              }
                            />
                            服务支持参考图编辑（/images/edits）
                          </label>
                          <details className="advanced-settings">
                            <summary>
                              图片下载域名
                              <ChevronDown size={13} />
                            </summary>
                            <label className="field">
                              允许的下载域名
                              <textarea
                                value={hosts}
                                disabled={disabled}
                                onChange={(e) => {
                                  setHosts(e.target.value);
                                  setNotice("");
                                }}
                                placeholder="cdn.example.com, images.example.com"
                                rows={2}
                              />
                            </label>
                            <p className="field-hint">
                              仅返回图片 URL
                              的服务需要填写。只写主机名，多个用逗号或换行分隔。
                            </p>
                          </details>
                        </>
                      )}
                      {isLLM && (
                        <p className="provider-tip">
                          模型需支持结构化 JSON
                          输出。使用截图作为素材时，还需要视觉输入能力。
                        </p>
                      )}
                      <div className="connection-check">
                        <button
                          type="button"
                          className="button secondary full"
                          disabled={disabled}
                          onClick={() => void check(target)}
                        >
                          {checking === target ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <Wifi size={15} />
                          )}
                          检查{isLLM ? "语言模型" : "图片模型"}连接
                        </button>
                        <p>只读取模型列表，不生成图片或发送素材。</p>
                      </div>
                      {checkErrors[target] && (
                        <div
                          className="settings-check-result failure"
                          role="alert"
                        >
                          {checkErrors[target]}
                        </div>
                      )}
                      {result && (
                        <div
                          className={`settings-check-result ${result.modelFound ? "success" : "warning"}`}
                          role="status"
                        >
                          <strong>
                            {result.modelFound
                              ? "连接检查通过"
                              : "请核对模型名称"}
                          </strong>
                          <p>{result.message}</p>
                          {result.models.length > 0 && (
                            <label className="field">
                              {isLLM
                                ? "选择已发现的语言模型"
                                : "选择已发现的图片模型"}
                              <select
                                aria-label={
                                  isLLM
                                    ? "选择已发现的语言模型"
                                    : "选择已发现的图片模型"
                                }
                                value=""
                                onChange={(e) => {
                                  const model = e.target.value;
                                  if (model) {
                                    setConfig((prev) =>
                                      prev
                                        ? {
                                            ...prev,
                                            [target]: {
                                              ...prev[target],
                                              model,
                                            },
                                          }
                                        : prev,
                                    );
                                    setResults((prev) => ({
                                      ...prev,
                                      [target]: {
                                        ...result,
                                        modelFound: true,
                                        message:
                                          "已选择列表中的模型。保存后生效，实际生成能力仍需验证。",
                                      },
                                    }));
                                    setNotice("");
                                  }
                                }}
                              >
                                <option value="" disabled>
                                  从 {result.models.length} 个模型中选择
                                </option>
                                {result.models.map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
              <div className="settings-storage">
                <KeyRound size={15} />
                <p>密钥保存在本机，留空可保留；更换服务需重新填写。</p>
              </div>
              <footer className="settings-savebar">
                <div>
                  {notice ? (
                    <span className="saved-state" role="status">
                      <Check size={15} />
                      {notice}
                    </span>
                  ) : (
                    <span>
                      {dirty
                        ? "有未保存的修改"
                        : config.source === "saved"
                          ? "使用已保存的模型设置"
                          : "首次配置从本地环境读取"}
                    </span>
                  )}
                </div>
                <div className="save-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled || !dirty}
                    onClick={() => {
                      setConfig(saved);
                      setHosts(saved!.image.downloadHosts.join(", "));
                      setResults({});
                      setCheckErrors({});
                      setError("");
                      setNotice("");
                    }}
                  >
                    <RefreshCw size={14} />
                    撤销修改
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={disabled || !dirty}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Save size={16} />
                    )}
                    保存设置
                  </button>
                </div>
              </footer>
            </form>
          )
        )}
      </main>
    </div>
  );
}
