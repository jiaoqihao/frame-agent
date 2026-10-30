import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function checkNode(version = process.versions.node) {
  if (Number(version.split(".")[0]) < 24)
    throw new Error("请安装 Node.js 24 或更新版本：https://nodejs.org/");
}
export async function probeService(port = 8787) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    const health = await response.json();
    if (response.ok && health.ok && health.service === "frame-agent")
      return { state: "ready", version: health.version };
    return { state: "occupied" };
  } catch {
    // A successful bind distinguishes a stopped service from a busy/unresponsive port.
    return new Promise((done) => {
      const server = createServer();
      server.once("error", () => done({ state: "occupied" }));
      server.listen(port, "127.0.0.1", () =>
        server.close(() => done({ state: "stopped" })),
      );
    });
  }
}
export async function ensureRunning({
  probe = probeService,
  prepare,
  start,
  attempts = 60,
  wait = () => delay(500),
}) {
  const initial = await probe();
  if (initial.state === "ready") return { ...initial, started: false };
  if (initial.state === "occupied")
    throw new Error(
      "8787 端口被占用或旧版服务仍在运行。请关闭旧服务后重试，不会自动结束其他程序。",
    );
  await prepare();
  const child = await start();
  for (let i = 0; i < attempts; i++) {
    const status = await probe();
    if (status.state === "ready") return { ...status, started: true };
    if (child.exitCode !== null && child.exitCode !== undefined) break;
    await wait();
  }
  throw new Error(
    "服务未能启动，请查看 .data/service.log；也可运行 npm run server 查看错误。",
  );
}
function runNpm(args) {
  // Invoke npm's JS entrypoint directly; project paths never become shell code.
  const npmCli =
    process.env.npm_execpath ||
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(npmCli))
    throw new Error("找不到 npm，请使用包含 npm 的 Node.js 官方安装包。");
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(new Error("准备环境失败。请检查网络后重新双击启动。")),
    );
  });
}
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => unlinkSync(file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("启动锁无效，请删除 .data/launch.lock 后重试。");
      try {
        process.kill(pid, 0);
        throw new Error("另一个启动窗口正在准备环境，请稍等。");
      } catch (check) {
        if (check.code !== "ESRCH") throw check;
      }
      try {
        unlinkSync(file);
      } catch (remove) {
        if (remove.code !== "ENOENT") throw remove;
      }
    }
  }
  throw new Error("启动进行中，请稍后再试。");
}
export async function launch() {
  checkNode();
  const data = join(root, ".data");
  mkdirSync(data, { recursive: true });
  const release = acquireLock(join(data, "launch.lock"));
  try {
    const result = await ensureRunning({
      prepare: async () => {
        if (!existsSync(join(root, "node_modules/.package-lock.json"))) {
          console.log("首次启动，正在安装依赖…");
          await runNpm(["ci", "--no-audit", "--no-fund"]);
        }
        if (!existsSync(join(root, "dist/manifest.json"))) {
          console.log("正在准备浏览器插件…");
          await runNpm(["run", "build"]);
        }
      },
      start: async () => {
        const log = openSync(join(data, "service.log"), "a");
        let child;
        try {
          child = spawn(
            process.execPath,
            ["--env-file-if-exists=.env", "server/index.mjs"],
            {
              cwd: root,
              detached: true,
              windowsHide: true,
              stdio: ["ignore", log, log],
              env: { ...process.env, PORT: "8787" },
            },
          );
          await new Promise((done, reject) => {
            child.once("spawn", done);
            child.once("error", reject);
          });
          child.unref();
          return child;
        } finally {
          closeSync(log);
        }
      },
    });
    const expected = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).version;
    if (result.version !== expected)
      throw new Error(
        "已有其他版本的 Frame 服务正在运行，请关闭旧服务后重试。",
      );
    console.log(
      result.started
        ? "Frame 已启动，可以关闭此窗口。"
        : "Frame 已在运行，无需重复启动。",
    );
    console.log(
      "请在浏览器中打开 Frame 插件。首次安装时，加载此文件夹下的 dist 目录。",
    );
  } finally {
    release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  launch().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
