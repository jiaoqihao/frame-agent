import { useEffect, useRef, useState } from "react";
import {
  Aperture,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  FileText,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Pin,
  Plus,
  Scan,
  Settings2,
  Settings as SettingsIcon,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { api, assetUrl, isExtension } from "./api";
import ChatPanel from "./ChatPanel";
import ReviewCard from "./ReviewCard";
import type { Asset, Capture, Detail, Job, Project, Settings } from "./types";

const modeNames = { new: "生成新图", edit: "继续修改", fuse: "融合素材" };
type Mode = keyof typeof modeNames;
const time = (v: string) =>
  new Date(v).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function App() {
  const [health, setHealth] = useState<{
    provider: string;
    ready: boolean;
  } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(
    isExtension ? "" : localStorage.getItem("frame-project") || "",
  );
  const currentId = useRef(projectId);
  currentId.current = projectId;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<Mode>("new");
  const [selected, setSelected] = useState<string[]>([]);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [autoMemory, setAutoMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewJobId, setViewJobId] = useState<string | null>(null);
  const [modal, setModal] = useState<"project" | "settings" | "text" | null>(
    null,
  );
  const [projectName, setProjectName] = useState("");
  const [textValue, setTextValue] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [memoryRevision, setMemoryRevision] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [workspace, setWorkspace] = useState<"image" | "chat">("image");
  const [explainTarget, setExplainTarget] = useState<{
    projectId: string;
    conversationId: string;
  } | null>(null);
  const [pendingExplain, setPendingExplain] = useState(false);
  const [draftReady, setDraftReady] = useState("");
  const seenExplain = useRef("");
  const processingCaptures = useRef(false);
  const creatingDefault = useRef(false);
  const [pendingQuick, setPendingQuick] = useState(false);
  const seenQuick = useRef("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);

  async function boot() {
    try {
      setError("");
      const [h, p] = await Promise.all([
        api<{ provider: string; ready: boolean }>("/api/health"),
        api<Project[]>("/api/projects"),
      ]);
      setHealth(h);
      setProjects(p);
      const saved = isExtension
        ? (await chrome.storage.local.get("activeProjectId")).activeProjectId
        : currentId.current;
      if (p.some((item) => item.id === saved)) setProjectId(saved);
      else if (!p.some((item) => item.id === currentId.current))
        setProjectId(p[0]?.id || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function refresh(id: string) {
    const result = await api<Detail>(`/api/projects/${id}`);
    if (currentId.current === id) setDetail(result);
    return result;
  }
  function chooseProject(id: string) {
    setProjectId(id);
    if (isExtension) void chrome.storage.local.set({ activeProjectId: id });
  }
  function updateInstruction(value: string) {
    setInstruction(value);
    if (currentId.current)
      localStorage.setItem(`draft:${currentId.current}`, value);
  }
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    localStorage.setItem("frame-project", projectId);
    setDetail(null);
    setSelected([]);
    setBaseId(null);
    setViewJobId(null);
    setMode("new");
    setInstruction(localStorage.getItem(`draft:${projectId}`) || "");
    setDraftReady(projectId);
    setShowPlan(false);
    if (!projectId) return;
    setLoading(true);
    refresh(projectId)
      .catch((e) => setError(e.message))
      .finally(() => {
        if (currentId.current === projectId) setLoading(false);
      });
  }, [projectId]);
  const running = detail?.jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  useEffect(() => {
    if (!running || !projectId) return;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refresh(projectId);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [running, projectId]);
  useEffect(() => {
    if (!isExtension) return;
    const load = async () => {
      const values = await chrome.storage.local.get(null);
      setCaptures(
        Object.entries(values)
          .filter(([key]) => key.startsWith("capture:"))
          .map(([, v]) => v as Capture)
          .sort((a, b) => a.createdAt - b.createdAt),
      );
      if (values.captureError) {
        setError(values.captureError);
        await chrome.storage.local.remove("captureError");
      }
      setPendingQuick(Boolean(values.pendingQuick));
      setPendingExplain(Boolean(values.pendingExplain));
      if (values.explainError) setError(values.explainError);
      if (values.quickError) setError(values.quickError);
      if (
        values.activeProjectId &&
        values.activeProjectId !== currentId.current
      )
        setProjectId(values.activeProjectId);
      const quick = values.lastQuickJob;
      const explanation = values.lastExplain;
      if (explanation && explanation.conversationId !== seenExplain.current) {
        seenExplain.current = explanation.conversationId;
        if (values.activeProjectId === explanation.projectId) {
          setExplainTarget(explanation);
          // Restore the last action; an older explanation must not hide a newer image request.
          if (!quick || explanation.createdAt >= quick.createdAt)
            setWorkspace("chat");
          setProjects(await api<Project[]>("/api/projects"));
          if (currentId.current === explanation.projectId)
            await refresh(explanation.projectId);
        }
      }
      if (quick && quick.jobId !== seenQuick.current) {
        seenQuick.current = quick.jobId;
        try {
          setProjects(await api<Project[]>("/api/projects"));
          if (values.activeProjectId === quick.projectId) {
            setProjectId(quick.projectId);
            if (currentId.current === quick.projectId)
              await refresh(quick.projectId);
            setViewJobId(quick.jobId);
            setError("");
            if (!explanation || quick.createdAt > explanation.createdAt)
              setWorkspace("image");
          }
        } catch (e) {
          setError((e as Error).message);
        }
      }
    };
    void load().catch((e) => setError(e.message));
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
    ) => {
      void load().catch((e) => setError(e.message));
      if (changes.modelSettingsRevision)
        void api<{ provider: string; ready: boolean }>("/api/health")
          .then(setHealth)
          .catch((e) => setError(e.message));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  useEffect(() => {
    if (
      !captures.length ||
      !health ||
      projectId ||
      projects.length ||
      creatingDefault.current
    )
      return;
    creatingDefault.current = true;
    void api<Project>("/api/projects", { name: "默认项目" })
      .then((p) => {
        setProjects([p]);
        chooseProject(p.id);
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        creatingDefault.current = false;
      });
  }, [captures, health, projectId, projects]);
  useEffect(() => {
    if (
      !projectId ||
      draftReady !== projectId ||
      !detail ||
      processingCaptures.current
    )
      return;
    const texts = captures.filter(
      (c) => c.kind === "text" && (!c.projectId || c.projectId === projectId),
    );
    if (!texts.length) return;
    processingCaptures.current = true;
    // Persist before acknowledging the inbox so reopening the panel never loses the draft.
    const previous = localStorage.getItem(`draft:${projectId}`) || "";
    const imported: string[] = JSON.parse(
      localStorage.getItem(`draft-imports:${projectId}`) || "[]",
    );
    const fresh = texts.filter((c) => !imported.includes(c.id));
    if (fresh.length) {
      updateInstruction(
        [previous, ...fresh.map((c) => c.content || "")]
          .filter(Boolean)
          .join("\n\n"),
      );
      localStorage.setItem(
        `draft-imports:${projectId}`,
        JSON.stringify([...imported, ...fresh.map((c) => c.id)].slice(-200)),
      );
      setMode("new");
      setBaseId(null);
      setWorkspace("image");
      setTimeout(() => instructionRef.current?.focus(), 0);
    }
    void chrome.storage.local
      .remove(texts.map((c) => `capture:${c.id}`))
      .finally(() => {
        processingCaptures.current = false;
      });
  }, [captures, projectId, draftReady, detail]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const assets = detail?.assets || [],
    jobs = detail?.jobs || [];
  const latest = jobs[0],
    viewed =
      jobs.find((j) => j.id === viewJobId) ||
      jobs.find((j) => j.status === "completed");
  const resultAsset = assets.find((a) => a.id === viewed?.result_asset_id);
  const pinned = assets.filter((a) => a.pinned);
  const selectedAssets = assets.filter((a) => selected.includes(a.id));
  const base = assets.find((a) => a.id === baseId);
  const project = detail?.project;
  const reviewJobs = jobs.filter(
    (j) => j.status === "awaiting_review" && j.plan?.review,
  );
  const activeJob = jobs.find(
    (j) => j.status === "queued" || j.status === "running",
  );

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggleAsset(id: string) {
    if (selected.includes(id)) setSelected(selected.filter((v) => v !== id));
    else if (new Set([...selected, id, baseId].filter(Boolean)).size > 6)
      setError("每次最多选择 6 份素材");
    else setSelected([...selected, id]);
  }
  async function addAsset(input: unknown) {
    const id = currentId.current;
    if (!id) throw new Error("请先创建一个项目");
    const asset = await api<Asset>(`/api/projects/${id}/assets`, input);
    await refresh(id);
    if (currentId.current === id)
      setSelected((prev) => (prev.length < 6 ? [...prev, asset.id] : prev));
    return asset;
  }
  async function generate() {
    if (!projectId || (!instruction.trim() && !selected.length)) return;
    const id = projectId;
    await action(async () => {
      const job = await api<Job>(`/api/projects/${id}/jobs`, {
        instruction:
          instruction.trim() || "理解所选素材，整理成表达核心信息的绘图说明。",
        mode,
        assetIds: selected,
        baseAssetId: mode === "edit" ? baseId : null,
        autoMemory,
      });
      if (currentId.current === id) setViewJobId(job.id);
      await refresh(id);
    });
  }
  async function reviewAction(job: Job, instruction?: string) {
    await action(async () => {
      await api<Job>(
        `/api/jobs/${job.id}/${instruction === undefined ? "cancel" : "approve"}`,
        {
          reviewRevision: job.plan!.review!.revision,
          ...(instruction === undefined ? {} : { instruction }),
        },
      );
      localStorage.removeItem(
        `frame-review:${job.id}:${job.plan!.review!.revision}`,
      );
      if (currentId.current === job.project_id) setViewJobId(job.id);
      await refresh(job.project_id);
    });
  }
  function continueFrom(asset: Asset) {
    setBaseId(asset.id);
    setMode("edit");
    setInstruction("");
    instructionRef.current?.focus();
    setNotice("已选择原图，请描述这次要修改的内容");
  }
  async function extensionAction(type: string) {
    setError("");
    if (!isExtension) {
      if (type === "START_CAPTURE") uploadRef.current?.click();
      else setModal("text");
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({ type });
      if (result?.error) throw new Error(result.error);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    await action(async () => {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 8 * 1024 * 1024
      )
        throw new Error("请上传不超过 8 MB 的 PNG、JPEG 或 WebP");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      await addAsset({
        kind: "image",
        title: file.name.slice(0, 120),
        dataUrl,
      });
      setNotice("图片已加入当前项目");
    });
    if (uploadRef.current) uploadRef.current.value = "";
  }
  async function importCapture(capture: Capture) {
    setCaptureBusy(true);
    setError("");
    try {
      const id = currentId.current;
      const asset = await addAsset(capture);
      const job = await api<Job>(`/api/projects/${id}/jobs`, {
        instruction:
          instruction.trim() || "理解截图中的内容，整理成适合配图的绘图说明。",
        mode: "new",
        assetIds: [asset.id],
        baseAssetId: null,
        autoMemory,
      });
      await chrome.storage.local.remove(`capture:${capture.id}`);
      if (currentId.current === id) {
        setViewJobId(job.id);
        setWorkspace("image");
      }
      await refresh(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCaptureBusy(false);
    }
  }
  async function download(asset: Asset, asPng = false) {
    try {
      const response = await fetch(assetUrl(asset.imageUrl));
      if (!response.ok) throw new Error();
      let blob = await response.blob();
      if (asPng && blob.type.includes("svg")) {
        const source = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = source;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d")!.drawImage(img, 0, 0);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) =>
                value ? resolve(value) : reject(new Error("PNG 导出失败")),
              "image/png",
            ),
          );
        } finally {
          URL.revokeObjectURL(source);
        }
      }
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `frame-${asset.id}.${blob.type.includes("svg") ? "svg" : blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch {
      setError("下载失败，请检查本地服务");
    }
  }
  function openSettings() {
    if (!project) return;
    const id = project.id;
    void action(async () => {
      const latest = await api<Detail>(`/api/projects/${id}`);
      if (currentId.current !== id) return;
      setDetail(latest);
      setSettings({ ...latest.project.settings });
      setMemoryRevision(latest.project.memoryRevision);
      setProjectName(latest.project.name);
      setModal("settings");
    });
  }
  function openModels() {
    if (isExtension) void chrome.runtime.openOptionsPage();
    else window.open("options.html", "frame-settings");
  }

  return (
    <div className="app-shell extension-shell">
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-brand">
              <Aperture size={20} /> frame.
            </span>
          </div>
          <div className="topbar-actions">
            <span className={`status-dot ${health ? "online" : ""}`} />
            <span>
              {!health
                ? "未连接服务"
                : health.provider === "demo"
                  ? "演示模式"
                  : health.ready
                    ? "模型已配置"
                    : "待配置密钥"}
            </span>
            <button
              className="icon-button"
              title="模型设置"
              onClick={openModels}
            >
              <SettingsIcon size={18} />
            </button>
            <button
              className="icon-button"
              title="项目记忆"
              disabled={!project}
              onClick={openSettings}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>
        <div className="mobile-projects">
          <select
            aria-label="切换项目"
            value={projectId}
            onChange={(e) => chooseProject(e.target.value)}
          >
            <option value="" disabled>
              选择项目
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title="新建项目"
            onClick={() => {
              setProjectName("");
              setModal("project");
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        <main>
          {error && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button
                onClick={() => {
                  setError("");
                  if (!health) void boot();
                }}
              >
                {health ? <X size={16} /> : "重试连接"}
              </button>
            </div>
          )}
          {health?.provider === "demo" && (
            <div className="demo-banner">
              <span className="demo-badge">DEMO</span>
              <span>演示模式 · 输出为示例</span>
            </div>
          )}
          {health && !health.ready && (
            <div className="banner error">
              <span>请先配置语言模型密钥。</span>
              <button onClick={openModels}>打开模型设置</button>
            </div>
          )}
          <div className="workspace-tabs" role="tablist" aria-label="工作模式">
            <button
              role="tab"
              aria-selected={workspace === "image"}
              onClick={() => setWorkspace("image")}
            >
              生图
            </button>
            <button
              role="tab"
              aria-selected={workspace === "chat"}
              onClick={() => setWorkspace("chat")}
            >
              AI 解释
            </button>
          </div>
          {pendingExplain && (
            <button
              className="button secondary full"
              onClick={() => void extensionAction("RETRY_EXPLAIN")}
            >
              重试 AI 解释
            </button>
          )}
          {pendingQuick && (
            <button
              className="button secondary full"
              onClick={() => void extensionAction("RETRY_QUICK")}
            >
              重试上次右键任务
            </button>
          )}

          {captures.some((c) => c.kind === "image") && (
            <section className="inbox">
              <div className="section-title">
                <h2>截图</h2>
              </div>
              {captures
                .filter((c) => c.kind === "image")
                .map((c) => (
                  <div className="capture-item" key={c.id}>
                    {c.dataUrl ? (
                      <img src={c.dataUrl} alt="选区预览" />
                    ) : (
                      <FileText size={28} />
                    )}
                    <div>
                      <strong>{c.title || "网页素材"}</strong>
                      <p>{c.content?.slice(0, 100) || c.source}</p>
                    </div>
                    <button
                      disabled={!project || captureBusy}
                      className="button small primary"
                      onClick={() => void importCapture(c)}
                    >
                      理解截图
                    </button>
                    <button
                      className="icon-button"
                      title="丢弃采集"
                      onClick={() =>
                        void chrome.storage.local.remove(`capture:${c.id}`)
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
            </section>
          )}

          {!projectId && (
            <section className="welcome-card">
              <div className="welcome-icon">
                <Layers3 size={34} />
              </div>
              <h2>开始创作</h2>
              <p>选中文字后右键，或创建项目。</p>
              <button
                className="button primary"
                disabled={!health}
                onClick={() => {
                  setProjectName("");
                  setModal("project");
                }}
              >
                <Plus size={17} />
                创建第一个项目
              </button>
            </section>
          )}
          {loading && (
            <div className="loading">
              <LoaderCircle className="spin" size={22} />
              正在读取项目…
            </div>
          )}
          {project && workspace === "chat" && (
            <ChatPanel
              key={project.id}
              projectId={project.id}
              conversations={detail?.conversations || []}
              targetId={
                explainTarget?.projectId === project.id
                  ? explainTarget.conversationId
                  : undefined
              }
            />
          )}
          {project && workspace === "image" && (
            <div className="studio-layout">
              <div className="creative-column">
                <ol className="workflow-steps" aria-label="生图工作流">
                  {["采集内容", "AI 理解", "用户审核", "生成图片"].map(
                    (label, i) => {
                      const step = activeJob
                        ? activeJob.request.approvedAt
                          ? 3
                          : 1
                        : reviewJobs.length
                          ? 2
                          : latest?.status === "completed"
                            ? 3
                            : 0;
                      return (
                        <li
                          key={label}
                          aria-current={i === step ? "step" : undefined}
                          className={
                            i === step ? "current" : i < step ? "done" : ""
                          }
                        >
                          <span>{i + 1}</span>
                          {label}
                        </li>
                      );
                    },
                  )}
                </ol>
                {reviewJobs.map((job) => (
                  <ReviewCard
                    key={job.id}
                    job={job}
                    assets={assets}
                    busy={busy}
                    onApprove={(j, text) => void reviewAction(j, text)}
                    onCancel={(j) => void reviewAction(j)}
                  />
                ))}

                <div className="manual-create">
                  <section className="card composer">
                    <div className="capture-actions">
                      <button
                        onClick={() => void extensionAction("START_CAPTURE")}
                      >
                        <Scan size={19} />
                        <span>{isExtension ? "框选网页" : "上传截图"}</span>
                      </button>
                      <button
                        onClick={() => void extensionAction("READ_SELECTION")}
                      >
                        <FileText size={19} />
                        <span>{isExtension ? "读取选中文字" : "添加文字"}</span>
                      </button>
                    </div>
                    <details
                      className="generation-options"
                      open={mode !== "new"}
                    >
                      <summary>更多选项</summary>
                      <div
                        className="mode-tabs"
                        role="tablist"
                        aria-label="生成模式"
                      >
                        {(Object.keys(modeNames) as Mode[]).map((m) => (
                          <button
                            key={m}
                            role="tab"
                            aria-selected={mode === m}
                            className={mode === m ? "selected" : ""}
                            onClick={() => setMode(m)}
                          >
                            {modeNames[m]}
                          </button>
                        ))}
                      </div>
                      {mode === "edit" && (
                        <div className="base-picker">
                          <label htmlFor="base-image">本次修改的原图</label>
                          <select
                            id="base-image"
                            value={baseId || ""}
                            onChange={(e) => setBaseId(e.target.value || null)}
                          >
                            <option value="">选择项目中的图片</option>
                            {assets
                              .filter((a) => a.imageUrl)
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.title}
                                </option>
                              ))}
                          </select>
                          {base?.imageUrl && (
                            <img src={assetUrl(base.imageUrl)} alt="修改原图" />
                          )}
                        </div>
                      )}
                    </details>
                    <textarea
                      className="prompt-input"
                      ref={instructionRef}
                      aria-label="本次生成要求"
                      value={instruction}
                      maxLength={12000}
                      onChange={(e) => updateInstruction(e.target.value)}
                      placeholder={
                        mode === "edit"
                          ? "想修改哪里？"
                          : "输入内容，或选中文字后加入这里。可以直接修改、补充生图要求。"
                      }
                    />
                    {selectedAssets.length > 0 && (
                      <div className="selected-chips">
                        {selectedAssets.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => toggleAsset(a.id)}
                            title="取消引用"
                          >
                            {a.imageUrl ? (
                              <img src={assetUrl(a.imageUrl)} alt="" />
                            ) : (
                              <FileText size={13} />
                            )}
                            <span>{a.title}</span>
                            <X size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="composer-footer">
                      <label className="memory-toggle">
                        <input
                          type="checkbox"
                          checked={autoMemory}
                          onChange={(e) => setAutoMemory(e.target.checked)}
                        />
                        <Layers3 size={15} />
                        沿用项目记忆
                      </label>
                      <span className="ratio-chip">
                        {project.settings.ratio}
                      </span>
                      <button
                        className="button primary generate-button"
                        disabled={
                          busy ||
                          !!running ||
                          (!instruction.trim() && !selected.length) ||
                          !health?.ready ||
                          (mode === "edit" && !baseId)
                        }
                        onClick={() => void generate()}
                      >
                        {busy || running ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Sparkles size={17} />
                        )}{" "}
                        {running ? "处理中" : "整理内容"}
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  </section>
                </div>

                <section className="result-section">
                  <div className="section-title">
                    <h2>
                      <span className="step-number">✦</span>生图结果
                    </h2>
                    <span className="quiet">
                      {resultAsset ? time(resultAsset.created_at) : ""}
                    </span>
                  </div>
                  {activeJob && (
                    <div className="progress-card" role="status">
                      <LoaderCircle className="spin" size={20} />
                      <div>
                        <strong>{activeJob.stage}</strong>
                      </div>
                    </div>
                  )}
                  {latest?.status === "failed" && (
                    <div className="banner error">
                      <span>{latest.error}</span>
                      <button
                        onClick={() => {
                          updateInstruction(
                            latest.request.approvedInstruction ||
                              latest.request.selectionText ||
                              latest.request.instruction,
                          );
                          setMode(latest.request.mode as Mode);
                          setSelected(latest.request.assetIds);
                          setBaseId(latest.request.baseAssetId);
                          setAutoMemory(latest.request.autoMemory);
                          instructionRef.current?.focus();
                        }}
                      >
                        恢复要求
                      </button>
                    </div>
                  )}
                  {resultAsset ? (
                    <div className="result-card">
                      <div className="result-image-wrap">
                        <img
                          className="result-image"
                          src={assetUrl(resultAsset.imageUrl)}
                          alt={resultAsset.title}
                        />
                        <span className="image-label">
                          {viewed?.plan?.provider === "demo"
                            ? viewed.plan.renderer === "svg"
                              ? "SVG 路由演示 · 非模型生成"
                              : "演示占位图 · 非 AI 生成"
                            : viewed?.plan?.renderer === "svg"
                              ? "SVG · 矢量图"
                              : "图片 API · 模型生成"}
                        </span>
                        <button
                          className="image-download"
                          title="下载图片"
                          onClick={() => void download(resultAsset)}
                        >
                          <ArrowDownToLine size={18} />
                        </button>
                      </div>
                      <div className="result-info">
                        <div>
                          <h3>{resultAsset.title}</h3>
                        </div>
                        <button
                          className="button secondary small"
                          onClick={() => continueFrom(resultAsset)}
                        >
                          <WandSparkles size={15} />
                          以此继续
                        </button>
                      </div>
                      <div className="result-bottom">
                        {resultAsset.mime === "image/svg+xml" && (
                          <button
                            className="text-button"
                            onClick={() => void download(resultAsset, true)}
                          >
                            <ArrowDownToLine size={14} />
                            导出 PNG
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() => setShowPlan(!showPlan)}
                        >
                          <Layers3 size={15} />
                          查看创作依据
                          <ChevronDown size={14} />
                        </button>
                        <button
                          className={`text-button ${resultAsset.pinned ? "pinned" : ""}`}
                          onClick={() =>
                            void action(async () => {
                              await api(
                                `/api/assets/${resultAsset.id}`,
                                { pinned: !resultAsset.pinned },
                                "PATCH",
                              );
                              await refresh(projectId);
                            })
                          }
                        >
                          <Pin size={14} />
                          {resultAsset.pinned
                            ? "已设为长期参考"
                            : "设为长期参考"}
                        </button>
                      </div>
                      {showPlan && viewed?.plan && (
                        <div className="plan-details">
                          <h4>创作依据</h4>
                          {viewed.plan.review && (
                            <details className="review-details">
                              <summary>审核记录</summary>
                              <p>{viewed.plan.review.understanding}</p>
                              <p className="review-original">
                                {viewed.plan.review.approvedInstruction}
                              </p>
                            </details>
                          )}
                          <p className="route-explanation">
                            {viewed.plan.routeReason}
                          </p>
                          {viewed.plan.skill && (
                            <p>
                              绘图技能：{viewed.plan.skill}
                              {viewed.plan.provider === "demo"
                                ? "（演示模式未调用模型）"
                                : ""}
                            </p>
                          )}
                          <p>{viewed.plan.summary}</p>
                          <div className="plan-columns">
                            <div>
                              <strong>保留</strong>
                              {viewed.plan.preserved.map((x, i) => (
                                <p key={i}>{x}</p>
                              ))}
                            </div>
                            <div>
                              <strong>改变</strong>
                              {viewed.plan.changes.map((x, i) => (
                                <p key={i}>{x}</p>
                              ))}
                            </div>
                          </div>
                          <div className="reference-list">
                            {viewed.plan.snapshot.references.map((r) => (
                              <div key={r.id}>
                                <span>{r.title}</span>
                                <small>{r.reason}</small>
                              </div>
                            ))}
                          </div>
                          {!!viewed.plan.snapshot.recentTurns?.length && (
                            <details>
                              <summary>本次使用的历史创作上下文</summary>
                              {viewed.plan.snapshot.recentTurns.map(
                                (turn, i) => (
                                  <p key={i}>
                                    {i + 1}. {turn.instruction}
                                  </p>
                                ),
                              )}
                            </details>
                          )}
                          <details>
                            <summary>生成时的项目设定</summary>
                            <pre>
                              {JSON.stringify(
                                viewed.plan.snapshot.settings,
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                          <div className="section-title">
                            <h4>发送给模型的提示词</h4>
                            <button
                              className="text-button"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(viewed.plan!.prompt)
                                  .then(() => setNotice("提示词已复制"))
                                  .catch(() =>
                                    setError("复制失败，请手动选中文字复制"),
                                  )
                              }
                            >
                              <Copy size={13} />
                              复制
                            </button>
                          </div>
                          <pre>{viewed.plan.prompt}</pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    !activeJob && (
                      <div className="empty-canvas">
                        <p>写下想法，生成第一张图。</p>
                      </div>
                    )
                  )}
                </section>
                {jobs.some((j) => j.status === "completed") && (
                  <section className="history-section">
                    <div className="section-title">
                      <h2>
                        <Clock3 size={17} />
                        创作轨迹
                      </h2>
                    </div>
                    <div className="history-grid">
                      {jobs
                        .filter((j) => j.status === "completed")
                        .map((j) => {
                          const a = assets.find(
                            (a) => a.id === j.result_asset_id,
                          );
                          return (
                            a && (
                              <button
                                key={j.id}
                                className={`history-item ${viewed?.id === j.id ? "active" : ""}`}
                                onClick={() => {
                                  setViewJobId(j.id);
                                  setShowPlan(false);
                                }}
                              >
                                <img src={assetUrl(a.imageUrl)} alt={a.title} />
                                <strong>{a.title}</strong>
                                <span>
                                  {modeNames[j.request.mode as Mode]} ·{" "}
                                  {time(j.created_at)}
                                </span>
                              </button>
                            )
                          );
                        })}
                    </div>
                  </section>
                )}
              </div>

              <details className="memory-drawer">
                <summary>素材与项目记忆 · {assets.length}</summary>
                <aside className="memory-column">
                  <section className="card memory-card">
                    <div className="section-title">
                      <h2>
                        <Layers3 size={18} />
                        项目记忆
                      </h2>
                      <span className="live-label">
                        <span />
                        持续生效
                      </span>
                    </div>

                    <div className="memory-fields">
                      <div>
                        <span>创作用途</span>
                        <strong>{project.settings.purpose || "未设置"}</strong>
                      </div>
                      <div>
                        <span>视觉风格</span>
                        <strong>{project.settings.style || "未设置"}</strong>
                      </div>
                      <div>
                        <span>项目配色</span>
                        <strong>{project.settings.palette || "未设置"}</strong>
                      </div>
                      <div>
                        <span>画面比例</span>
                        <strong>{project.settings.ratio}</strong>
                      </div>
                      {project.settings.constraints && (
                        <div>
                          <span>长期约束</span>
                          <strong>{project.settings.constraints}</strong>
                        </div>
                      )}
                      {(
                        [
                          ["subjectIdentity", "角色 / 产品"],
                          ["typography", "文字风格"],
                          ["avoid", "避免内容"],
                        ] as const
                      ).map(
                        ([key, label]) =>
                          project.settings[key] && (
                            <div key={key}>
                              <span>{label}</span>
                              <strong>{project.settings[key]}</strong>
                            </div>
                          ),
                      )}
                    </div>
                    <button
                      className="button secondary full"
                      onClick={openSettings}
                    >
                      <Settings2 size={15} />
                      编辑项目记忆
                    </button>
                    <div className="pinned-summary">
                      <Pin size={14} />
                      <span>{pinned.length} 份长期参考</span>
                      <small>按引用上限参与生成</small>
                    </div>
                  </section>
                  <section className="card assets-card">
                    <div className="section-title">
                      <h2>
                        灵感素材 <span className="count">{assets.length}</span>
                      </h2>
                      <button
                        className="icon-button"
                        title="上传图片"
                        onClick={() => uploadRef.current?.click()}
                      >
                        <ImagePlus size={18} />
                      </button>
                    </div>

                    {!assets.length ? (
                      <div className="empty-assets">
                        <div>
                          <Scan size={24} />
                        </div>
                        <strong>从一个片段开始</strong>
                        <p>
                          截图、文字、参考图片，
                          <br />
                          都可以成为下一帧的起点。
                        </p>
                        <button
                          className="text-button"
                          onClick={() => {
                            setTextValue("");
                            setTextTitle("");
                            setModal("text");
                          }}
                        >
                          添加第一份素材
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="asset-list">
                        {assets.map((a) => (
                          <article
                            className={`asset-card ${selected.includes(a.id) ? "selected" : ""}`}
                            key={a.id}
                          >
                            <button
                              className="asset-select"
                              onClick={() => toggleAsset(a.id)}
                              aria-label={`${selected.includes(a.id) ? "取消引用" : "引用"} ${a.title}`}
                            >
                              <div className="asset-thumb">
                                {a.imageUrl ? (
                                  <img src={assetUrl(a.imageUrl)} alt="" />
                                ) : (
                                  <FileText size={22} />
                                )}
                              </div>
                              <div className="asset-content">
                                <strong>{a.title}</strong>
                                <span>
                                  {a.kind === "generated"
                                    ? "生成图片"
                                    : a.kind === "image"
                                      ? "图片素材"
                                      : "文字素材"}
                                  {a.source ? " · 网页采集" : ""}
                                </span>
                              </div>
                              <span className="checkbox">
                                {selected.includes(a.id) && <Check size={12} />}
                              </span>
                            </button>
                            <div className="asset-meta">
                              <span title={a.content || a.source}>
                                {a.content?.slice(0, 46) || "视觉参考素材"}
                              </span>
                              <button
                                className={`icon-button ${a.pinned ? "pinned" : ""}`}
                                title={
                                  a.pinned ? "取消长期参考" : "设为长期参考"
                                }
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await api(
                                      `/api/assets/${a.id}`,
                                      { pinned: !a.pinned },
                                      "PATCH",
                                    );
                                    await refresh(projectId);
                                  })
                                }
                              >
                                <Pin size={13} />
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    <button
                      className="add-text-button"
                      onClick={() => {
                        setTextTitle("");
                        setTextValue("");
                        setModal("text");
                      }}
                    >
                      <Plus size={15} />
                      添加文字素材
                    </button>
                  </section>
                </aside>
              </details>
            </div>
          )}
        </main>
      </div>
      <input
        ref={uploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="section-title">
              <h2 id="modal-title">
                {modal === "project"
                  ? "创建一个新项目"
                  : modal === "settings"
                    ? "项目记忆"
                    : "添加文字素材"}
              </h2>
              <button
                className="icon-button"
                title="关闭"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  if (modal === "project") {
                    const p = await api<Project>("/api/projects", {
                      name: projectName,
                    });
                    setProjects((prev) => [p, ...prev]);
                    chooseProject(p.id);
                  }
                  if (modal === "settings") {
                    const id = projectId;
                    const p = await api<Project>(
                      `/api/projects/${id}`,
                      { name: projectName, settings, memoryRevision },
                      "PATCH",
                    );
                    setProjects((prev) =>
                      prev.map((x) => (x.id === p.id ? p : x)),
                    );
                    await refresh(id);
                    setNotice("项目记忆已保存");
                  }
                  if (modal === "text") {
                    await addAsset({
                      kind: "text",
                      title: textTitle.trim() || textValue.trim().slice(0, 32),
                      content: textValue,
                    });
                    setTextValue("");
                    setTextTitle("");
                  }
                  setModal(null);
                });
              }}
            >
              {(modal === "project" || modal === "settings") && (
                <label className="field">
                  项目名称
                  <input
                    autoFocus
                    value={projectName}
                    maxLength={80}
                    required
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="例如：森林里的机器人"
                  />
                </label>
              )}
              {modal === "settings" && settings && (
                <>
                  <p className="field-hint">
                    保存后用于后续创作；本次输入中的要求优先。
                  </p>
                  <label className="field">
                    创作用途
                    <input
                      value={settings.purpose}
                      maxLength={2000}
                      onChange={(e) =>
                        setSettings({ ...settings, purpose: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    视觉风格
                    <input
                      value={settings.style}
                      maxLength={2000}
                      onChange={(e) =>
                        setSettings({ ...settings, style: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    配色
                    <input
                      value={settings.palette}
                      maxLength={2000}
                      onChange={(e) =>
                        setSettings({ ...settings, palette: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    画面比例
                    <select
                      value={settings.ratio}
                      onChange={(e) =>
                        setSettings({ ...settings, ratio: e.target.value })
                      }
                    >
                      <option value="3:2">3:2 · 横向</option>
                      <option value="1:1">1:1 · 方形</option>
                      <option value="2:3">2:3 · 竖向</option>
                    </select>
                  </label>
                  <label className="field">
                    长期约束
                    <textarea
                      value={settings.constraints}
                      maxLength={2000}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          constraints: e.target.value,
                        })
                      }
                      placeholder="例如：角色始终佩戴橙色围巾；不要在图片中添加文字。"
                    />
                  </label>
                  <details className="memory-extra">
                    <summary>角色、文字与排除项</summary>
                    {(
                      [
                        [
                          "subjectIdentity",
                          "角色 / 产品特征",
                          "例如：圆形机器人，橙色围巾，保持同一外观",
                        ],
                        [
                          "typography",
                          "文字风格",
                          "例如：中文无衬线标题，深色文字，层级清楚",
                        ],
                        [
                          "avoid",
                          "避免内容",
                          "例如：不添加无关装饰，不使用荧光色",
                        ],
                      ] as const
                    ).map(([key, label, placeholder]) => (
                      <label className="field" key={key}>
                        {label}
                        <textarea
                          aria-label={label}
                          value={settings[key] || ""}
                          maxLength={2000}
                          placeholder={placeholder}
                          onChange={(e) =>
                            setSettings({ ...settings, [key]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                  </details>
                  <div className="memory-tools">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        setSettings({
                          ...settings,
                          purpose: "",
                          style: "",
                          palette: "",
                          constraints: "",
                          subjectIdentity: "",
                          typography: "",
                          avoid: "",
                        })
                      }
                    >
                      清空风格
                    </button>
                    {project?.canUndoMemory && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const id = projectId;
                            const p = await api<Project>(
                              `/api/projects/${id}/memory/undo`,
                              { memoryRevision },
                            );
                            setSettings({ ...p.settings });
                            setMemoryRevision(p.memoryRevision);
                            setProjects((prev) =>
                              prev.map((x) => (x.id === p.id ? p : x)),
                            );
                            await refresh(id);
                            setNotice("已恢复上次项目记忆");
                          })
                        }
                      >
                        撤销上次保存
                      </button>
                    )}
                  </div>
                </>
              )}
              {modal === "text" && (
                <>
                  <label className="field">
                    标题
                    <input
                      autoFocus
                      value={textTitle}
                      maxLength={120}
                      onChange={(e) => setTextTitle(e.target.value)}
                      placeholder="给这份素材起个名字（可选）"
                    />
                  </label>
                  <label className="field">
                    素材内容
                    <textarea
                      value={textValue}
                      maxLength={12000}
                      required
                      onChange={(e) => setTextValue(e.target.value)}
                      placeholder="粘贴文字，或描述想长期参考的角色、产品与场景…"
                      rows={7}
                    />
                  </label>
                </>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setModal(null)}
                  disabled={busy}
                >
                  取消
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}{" "}
                  {modal === "project" ? "创建项目" : "保存"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
