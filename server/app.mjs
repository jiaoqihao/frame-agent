import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHash } from "node:crypto";
import { createChatHandler } from "./chat.mjs";
import {
  InputError,
  requiredText,
  retrieveMemory,
  memorySnapshot,
} from "./memory.mjs";

function parseImage(dataUrl) {
  if (typeof dataUrl !== "string") throw new InputError("缺少图片");
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new InputError("仅支持 PNG、JPEG、WebP 图片");
  const data = Buffer.from(match[2], "base64"),
    mime = match[1];
  if (!data.length || data.length > 8 * 1024 * 1024)
    throw new InputError("单张图片不得超过 8 MB");
  const valid =
    mime === "image/png"
      ? data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : data.toString("ascii", 0, 4) === "RIFF" &&
          data.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new InputError("图片格式与内容不匹配");
  return { mime, data };
}
async function readJson(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new InputError("请求必须使用 JSON", 415);
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new InputError("请求超过大小限制", 413);
    parts.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts).toString());
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error();
    return body;
  } catch {
    throw new InputError("JSON 格式无效");
  }
}
function settingsFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError("项目设定格式无效");
  const result = {};
  for (const key of ["purpose", "style", "palette", "constraints"]) {
    if (typeof value[key] !== "string" || value[key].length > 2000)
      throw new InputError("项目设定需要是 2000 字以内的文字");
    result[key] = value[key].trim();
  }
  for (const key of ["subjectIdentity", "typography", "avoid"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || value[key].length > 2000)
    )
      throw new InputError("项目记忆需要是 2000 字以内的文字");
    result[key] = (value[key] || "").trim();
  }
  if (!["1:1", "3:2", "2:3"].includes(value.ratio))
    throw new InputError("不支持的图片比例");
  return { ...result, ratio: value.ratio };
}
export function createApp({
  store,
  provider,
  settings,
  staticDir = resolve("dist"),
  servePreview = false,
}) {
  const pending = new Set();
  let active = 0;
  const queue = [];
  const handleChat = createChatHandler({
    store,
    settings,
    provider,
    hasCapacity: () => pending.size < 12,
    enqueue: (task) => {
      let finish;
      const promise = new Promise((resolve) => {
        finish = resolve;
      });
      pending.add(promise);
      queue.push(async () => {
        try {
          await task();
        } finally {
          active--;
          pending.delete(promise);
          finish();
          pump();
        }
      });
      pump();
    },
  });
  function schedule(job, context) {
    context.references = context.references.map((r) => ({
      ...r,
      asset: { ...r.asset, svgSpec: store.svgSpec(r.asset.id) },
    }));
    const configured = settings?.provider();
    const taskProvider = configured?.provider || provider;
    let finish;
    const promise = new Promise((r) => {
      finish = r;
    });
    pending.add(promise);
    queue.push(async () => {
      try {
        store.updateJob(job.id, {
          status: "running",
          stage: "Agent 正在理解内容并选择生图方式",
        });
        const plan = await taskProvider.plan(context);
        const recorded = {
          ...plan,
          snapshot: context.snapshot,
          provider: taskProvider.name,
          configRevision: configured?.revision || null,
          skill:
            plan.renderer === "svg"
              ? "svg-drawing"
              : plan.promptQuality?.skill || null,
        };
        store.updateJob(job.id, {
          plan: recorded,
          stage:
            plan.renderer === "svg"
              ? "正在绘制并检查排版"
              : context.references.some((r) => r.asset.data)
                ? "正在使用参考图生成"
                : "正在调用图片 API 生成",
        });
        const image = await taskProvider.generate({ ...context, plan });
        const result = store.createAsset(job.project_id, {
          kind: "generated",
          title: plan.title,
          content: `${plan.summary}\n用户要求：${context.request.selectionText || context.request.instruction}`,
          ...image,
        });
        store.updateJob(job.id, {
          status: "completed",
          stage: "已完成",
          result_asset_id: result.id,
          plan: {
            ...recorded,
            ...(image.svgEngine
              ? {
                  svgEngine: image.svgEngine,
                  svgSpec: image.svgSpec || null,
                  quality: image.quality,
                }
              : {}),
          },
        });
      } catch (error) {
        store.updateJob(job.id, {
          status: "failed",
          stage: "生成失败",
          error: error instanceof Error ? error.message : "未知错误",
        });
      } finally {
        active--;
        pending.delete(promise);
        finish();
        pump();
      }
    });
    pump();
  }
  function pump() {
    while (active < 2 && queue.length) {
      active++;
      void queue.shift()();
    }
  }
  const server = createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return send(403, { error: "只允许本机访问" });
    const origin = req.headers.origin;
    if (origin) {
      if (
        !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) &&
        ![
          "http://127.0.0.1:5173",
          "http://localhost:5173",
          `http://${host}`,
        ].includes(origin)
      )
        return send(403, { error: "不允许此来源访问本地服务" });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname.split("/").filter(Boolean);
      if (await handleChat(req, url, readJson, send)) return;
      if (url.pathname === "/api/settings" && settings) {
        if (req.method === "GET") return send(200, settings.public());
        if (req.method === "PATCH")
          return send(200, settings.save(await readJson(req)));
      }
      if (
        url.pathname === "/api/settings/test" &&
        settings &&
        req.method === "POST"
      ) {
        const body = await readJson(req);
        return send(200, await settings.test(body.config, body.target));
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        const activeProvider = settings?.provider().provider || provider;
        return send(200, {
          ok: true,
          service: "frame-agent",
          provider: activeProvider.name,
          ready:
            activeProvider.name === "demo" || Boolean(activeProvider.apiKey),
          imageApiReady:
            activeProvider.name === "demo" ||
            Boolean(activeProvider.imageAPI?.apiKey),
          version: "0.6.0",
        });
      }
      if (url.pathname === "/api/quick-generate" && req.method === "POST") {
        const b = await readJson(req),
          text = requiredText(b.selectionText, "选中文字", 12000),
          requestId = requiredText(b.requestId, "请求标识", 80);
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))
          throw new InputError("请求标识格式无效");
        if (b.projectId != null && typeof b.projectId !== "string")
          throw new InputError("项目标识无效");
        const source =
          typeof b.source === "string" ? b.source.slice(0, 2000) : "";
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([b.projectId || null, text, source]))
          .digest("hex");
        const prior = store.db
          .prepare("SELECT * FROM quick_requests WHERE id=?")
          .get(requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new InputError("同一个请求标识不能用于不同内容", 409);
          const job = store.job(prior.job_id);
          return send(200, { project: store.project(job.project_id), job });
        }
        if (pending.size >= 12)
          throw new InputError("等待中的任务较多，请稍后再试", 429);
        let project, job, context;
        store.db.exec("BEGIN");
        try {
          project = b.projectId
            ? store.project(b.projectId)
            : store.projects()[0] || store.createProject("默认项目");
          if (!project)
            throw new InputError("当前项目不存在，请在插件中重新选择项目", 404);
          const asset = store.createAsset(project.id, {
            kind: "text",
            title: text.slice(0, 40),
            content: text,
            source,
          });
          const request = {
            instruction: "为选中的网页文字生成一张最合适的配图。",
            selectionText: text,
            origin: "context-menu",
            mode: "new",
            assetIds: [asset.id],
            baseAssetId: null,
            autoMemory: true,
          };
          const references = retrieveMemory(store, project.id, request),
            snapshot = memorySnapshot(
              project,
              references,
              store.jobs(project.id),
            );
          job = store.createJob(project.id, request);
          context = { request, references, snapshot };
          store.db
            .prepare("INSERT INTO quick_requests VALUES(?,?,?)")
            .run(requestId, job.id, fingerprint);
          store.db.exec("COMMIT");
        } catch (error) {
          store.db.exec("ROLLBACK");
          throw error;
        }
        schedule(job, context);
        return send(202, { project, job: store.job(job.id) });
      }
      if (url.pathname === "/api/projects") {
        if (req.method === "GET") return send(200, store.projects());
        if (req.method === "POST") {
          const body = await readJson(req);
          return send(
            201,
            store.createProject(requiredText(body.name, "项目名称", 80)),
          );
        }
      }
      if (path[0] === "api" && path[1] === "projects" && path[2]) {
        const project = store.project(path[2]);
        if (!project) throw new InputError("项目不存在", 404);
        if (path.length === 3 && req.method === "GET")
          return send(200, {
            project,
            assets: store.assets(project.id).map((a) => store.publicAsset(a)),
            jobs: store.jobs(project.id),
            conversations: store.conversations(project.id),
          });
        if (path.length === 3 && req.method === "PATCH") {
          const b = await readJson(req);
          const latestProject = store.project(project.id);
          if (
            !b.settings ||
            typeof b.settings !== "object" ||
            Array.isArray(b.settings)
          )
            throw new InputError("项目设定格式无效");
          if (
            b.memoryRevision !== undefined &&
            b.memoryRevision !== latestProject.memoryRevision
          )
            throw new InputError(
              "项目记忆已在其他窗口更新，请关闭后重新打开编辑。",
              409,
            );
          return send(
            200,
            store.updateProject(
              project.id,
              requiredText(b.name, "项目名称", 80),
              settingsFrom({ ...latestProject.settings, ...b.settings }),
            ),
          );
        }
        if (
          path.length === 5 &&
          path[3] === "memory" &&
          path[4] === "undo" &&
          req.method === "POST"
        ) {
          const b = await readJson(req);
          if (b.memoryRevision !== store.project(project.id).memoryRevision)
            throw new InputError("项目记忆已更新，请关闭后重新打开编辑。", 409);
          return send(200, store.undoMemory(project.id));
        }
        if (
          path[3] === "assets" &&
          path.length === 4 &&
          req.method === "POST"
        ) {
          const b = await readJson(req);
          if (!["text", "image"].includes(b.kind))
            throw new InputError("未知素材类型");
          const input = {
            kind: b.kind,
            title: requiredText(b.title, "素材标题", 120),
            source: typeof b.source === "string" ? b.source.slice(0, 2000) : "",
          };
          if (b.kind === "text")
            input.content = requiredText(b.content, "素材文字", 12000);
          else {
            Object.assign(input, parseImage(b.dataUrl));
            input.content =
              typeof b.content === "string" ? b.content.slice(0, 12000) : "";
          }
          return send(
            201,
            store.publicAsset(store.createAsset(project.id, input)),
          );
        }
        if (path[3] === "jobs" && path.length === 4 && req.method === "POST") {
          if (pending.size >= 12)
            throw new InputError("等待中的任务较多，请稍后再试", 429);
          const b = await readJson(req);
          if (!["new", "edit", "fuse"].includes(b.mode))
            throw new InputError("未知生成模式");
          if (
            !Array.isArray(b.assetIds) ||
            b.assetIds.some((id) => typeof id !== "string")
          )
            throw new InputError("素材列表格式无效");
          if (b.baseAssetId != null && typeof b.baseAssetId !== "string")
            throw new InputError("原图格式无效");
          const request = {
            instruction: requiredText(b.instruction, "生成要求", 12000),
            mode: b.mode,
            assetIds: b.assetIds,
            baseAssetId: b.baseAssetId || null,
            autoMemory: b.autoMemory !== false,
          };
          const references = retrieveMemory(store, project.id, request),
            snapshot = memorySnapshot(
              project,
              references,
              request.autoMemory ? store.jobs(project.id) : [],
            );
          const job = store.createJob(project.id, request);
          schedule(job, { request, snapshot, references });
          return send(202, store.job(job.id));
        }
      }
      if (
        path[0] === "api" &&
        path[1] === "jobs" &&
        path.length === 3 &&
        req.method === "GET"
      ) {
        const job = store.job(path[2]);
        if (!job) throw new InputError("任务不存在", 404);
        return send(200, job);
      }
      if (path[0] === "api" && path[1] === "assets" && path[2]) {
        const asset = store.asset(path[2]);
        if (!asset) throw new InputError("素材不存在", 404);
        if (path.length === 3 && req.method === "PATCH") {
          const b = await readJson(req);
          if (typeof b.pinned !== "boolean")
            throw new InputError("参考状态格式无效");
          return send(
            200,
            store.publicAsset(store.pinAsset(asset.id, b.pinned)),
          );
        }
        if (
          path[3] === "image" &&
          path.length === 4 &&
          req.method === "GET" &&
          asset.data
        ) {
          const ext =
            asset.mime === "image/svg+xml"
              ? "svg"
              : asset.mime === "image/jpeg"
                ? "jpg"
                : asset.mime.split("/")[1];
          res.setHeader("Content-Type", asset.mime);
          if (asset.mime === "image/svg+xml")
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; sandbox",
            );
          res.setHeader("Cache-Control", "private, max-age=86400");
          if (url.searchParams.has("download"))
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="frame-${asset.id}.${ext}"`,
            );
          return res.end(Buffer.from(asset.data));
        }
      }
      if (path[0] !== "api" && req.method === "GET") {
        if (!servePreview)
          return send(200, {
            service: "Frame browser extension agent",
            version: "0.6.0",
            message:
              "这是插件的本地 API 服务。请加载 dist 扩展，在网页选中文字后右键选择「Frame · 直接生图」。",
          });
        const file = resolve(
          staticDir,
          "." +
            (url.pathname === "/"
              ? "/index.html"
              : decodeURIComponent(url.pathname)),
        );
        if (!file.startsWith(resolve(staticDir) + sep))
          throw new InputError("路径无效", 403);
        try {
          const data = await readFile(file);
          const mime =
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".json": "application/json",
              ".svg": "image/svg+xml",
            }[extname(file)] || "application/octet-stream";
          res.setHeader("Content-Type", mime);
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:8787; script-src 'self'",
          );
          return res.end(data);
        } catch {
          throw new InputError("请先运行 npm run build", 404);
        }
      }
      throw new InputError("接口不存在", 404);
    } catch (error) {
      send(error instanceof InputError ? error.status : 500, {
        error:
          error instanceof InputError
            ? error.message
            : "本地服务处理失败，请查看服务日志",
      });
      if (!(error instanceof InputError)) console.error(error);
    }
  });
  return { server, drain: () => Promise.all([...pending]) };
}
