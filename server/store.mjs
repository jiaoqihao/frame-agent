import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const DEFAULT_SETTINGS = {
  purpose: "系列配图",
  style: "简洁的编辑插画，清晰的视觉层次",
  palette: "森林绿、奶油白、暖橙色",
  ratio: "3:2",
  constraints: "",
};
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', mime TEXT, data BLOB, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, plan TEXT, result_asset_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quick_requests(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), selection TEXT NOT NULL, source TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL, error TEXT, provider TEXT, revision TEXT, created_at TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  project(id) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id);
    return row ? { ...row, settings: JSON.parse(row.settings) } : null;
  }
  projects() {
    return this.db
      .prepare("SELECT id FROM projects ORDER BY created_at DESC, rowid DESC")
      .all()
      .map((r) => this.project(r.id));
  }
  createProject(name) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO projects VALUES(?,?,?,?)")
      .run(
        id,
        name,
        JSON.stringify(DEFAULT_SETTINGS),
        new Date().toISOString(),
      );
    return this.project(id);
  }
  updateProject(id, name, settings) {
    this.db
      .prepare("UPDATE projects SET name=?,settings=? WHERE id=?")
      .run(name, JSON.stringify(settings), id);
    return this.project(id);
  }
  asset(id) {
    return this.db.prepare("SELECT * FROM assets WHERE id=?").get(id);
  }
  svgSpec(assetId) {
    const row = this.db
      .prepare(
        "SELECT plan FROM jobs WHERE result_asset_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(assetId);
    return row?.plan ? JSON.parse(row.plan).svgSpec || null : null;
  }
  assets(projectId) {
    return this.db
      .prepare(
        "SELECT * FROM assets WHERE project_id=? ORDER BY created_at DESC,rowid DESC",
      )
      .all(projectId);
  }
  publicAsset(a) {
    if (!a) return null;
    const { data, ...row } = a;
    return {
      ...row,
      pinned: Boolean(row.pinned),
      imageUrl: data ? `/api/assets/${a.id}/image` : null,
    };
  }
  createAsset(projectId, input) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        projectId,
        input.kind,
        input.title,
        input.content || "",
        input.source || "",
        input.mime || null,
        input.data || null,
        0,
        new Date().toISOString(),
      );
    return this.asset(id);
  }
  pinAsset(id, pinned) {
    this.db
      .prepare("UPDATE assets SET pinned=? WHERE id=?")
      .run(pinned ? 1 : 0, id);
    return this.asset(id);
  }
  createJob(projectId, request) {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        projectId,
        JSON.stringify(request),
        "queued",
        "等待处理",
        null,
        null,
        null,
        now,
        now,
      );
    return this.job(id);
  }
  job(id) {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return r
      ? {
          ...r,
          request: JSON.parse(r.request),
          plan: r.plan ? JSON.parse(r.plan) : null,
        }
      : null;
  }
  jobs(projectId) {
    return this.db
      .prepare(
        "SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 60",
      )
      .all(projectId)
      .map((r) => this.job(r.id));
  }
  updateJob(id, changes) {
    const allowed = ["status", "stage", "plan", "result_asset_id", "error"];
    const entries = Object.entries(changes).filter(([key]) =>
      allowed.includes(key),
    );
    this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([k]) => `${k}=?`).join(",")},updated_at=? WHERE id=?`,
      )
      .run(
        ...entries.map(([k, v]) => (k === "plan" ? JSON.stringify(v) : v)),
        new Date().toISOString(),
        id,
      );
    return this.job(id);
  }
  recoverJobs() {
    this.db
      .prepare(
        "UPDATE chat_turns SET status='failed', error='服务已重启，请重试。' WHERE status IN ('queued','running')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE jobs SET status='failed', stage='任务中断', error='服务已重启，请重新生成。', updated_at=? WHERE status IN ('queued','running')",
      )
      .run(new Date().toISOString());
  }
  conversation(id) {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(id);
    return row
      ? {
          ...row,
          turns: this.db
            .prepare(
              "SELECT * FROM chat_turns WHERE conversation_id=? ORDER BY rowid",
            )
            .all(id),
        }
      : null;
  }
  conversations(projectId) {
    return this.db
      .prepare(
        "SELECT id,selection,created_at FROM conversations WHERE project_id=? ORDER BY rowid DESC LIMIT 60",
      )
      .all(projectId);
  }
  createConversation(id, projectId, selection, source, fingerprint) {
    this.db
      .prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?)")
      .run(
        id,
        projectId,
        selection,
        source,
        fingerprint,
        new Date().toISOString(),
      );
    return this.conversation(id);
  }
  chatTurn(id) {
    return this.db.prepare("SELECT * FROM chat_turns WHERE id=?").get(id);
  }
  createChatTurn(id, conversationId, question) {
    this.db
      .prepare(
        "INSERT INTO chat_turns VALUES(?,?,?,NULL,'queued',NULL,NULL,NULL,?)",
      )
      .run(id, conversationId, question, new Date().toISOString());
    return this.chatTurn(id);
  }
  updateChatTurn(
    id,
    { status, answer = null, error = null, provider = null, revision = null },
  ) {
    this.db
      .prepare(
        "UPDATE chat_turns SET status=?,answer=?,error=?,provider=?,revision=? WHERE id=?",
      )
      .run(status, answer, error, provider, revision, id);
  }
}
