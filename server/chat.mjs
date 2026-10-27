import { createHash, randomUUID } from "node:crypto";
import { InputError, requiredText } from "./memory.mjs";

function requestId(value) {
  const id = requiredText(value, "请求标识", 80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id))
    throw new InputError("请求标识格式无效");
  return id;
}

export function createChatHandler({
  store,
  settings,
  provider,
  enqueue,
  hasCapacity,
}) {
  function schedule(conversation, turn) {
    const configured = settings?.provider(),
      model = configured?.provider || provider;
    const history = conversation.turns
      .filter((t) => t.status === "completed")
      .slice(-12)
      .map((t) => ({ question: t.question, answer: t.answer.slice(0, 12000) }));
    const metadata = {
      provider: model.name,
      revision: configured?.revision || null,
    };
    enqueue(async () => {
      store.updateChatTurn(turn.id, { status: "running", ...metadata });
      try {
        const answer = await model.explain({
          selection: conversation.selection,
          history,
          question: turn.question,
        });
        store.updateChatTurn(turn.id, {
          status: "completed",
          answer,
          ...metadata,
        });
      } catch (error) {
        store.updateChatTurn(turn.id, {
          status: "failed",
          error: error.message || "解释失败",
          ...metadata,
        });
      }
    });
  }
  return async (req, url, readJson, send) => {
    if (url.pathname === "/api/quick-explain" && req.method === "POST") {
      const body = await readJson(req),
        id = requestId(body.requestId);
      const selection = requiredText(body.selectionText, "选中文字", 12000);
      if (body.projectId != null && typeof body.projectId !== "string")
        throw new InputError("项目标识无效");
      const source =
        typeof body.source === "string" ? body.source.slice(0, 2000) : "";
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([body.projectId || null, selection, source]))
        .digest("hex");
      const prior = store.conversation(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new InputError("请求标识已用于其他内容", 409);
        send(200, {
          project: store.project(prior.project_id),
          conversation: prior,
        });
        return true;
      }
      if (!hasCapacity()) throw new InputError("任务较多，请稍后再试", 429);
      let project, conversation, turn;
      store.db.exec("BEGIN");
      try {
        project = body.projectId
          ? store.project(body.projectId)
          : store.projects()[0] || store.createProject("默认项目");
        if (!project) throw new InputError("项目不存在", 404);
        conversation = store.createConversation(
          id,
          project.id,
          selection,
          source,
          fingerprint,
        );
        turn = store.createChatTurn(randomUUID(), id, "请解释这段文字。");
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
      schedule(conversation, turn);
      send(202, { project, conversation: store.conversation(id) });
      return true;
    }
    const match =
      /^\/api\/projects\/([^/]+)\/conversations\/([^/]+)(\/messages)?$/.exec(
        url.pathname,
      );
    if (!match) return false;
    const conversation = store.conversation(match[2]);
    if (!conversation || conversation.project_id !== match[1])
      throw new InputError("对话不存在", 404);
    if (!match[3] && req.method === "GET") {
      send(200, conversation);
      return true;
    }
    if (match[3] && req.method === "POST") {
      const body = await readJson(req),
        id = requestId(body.requestId),
        question = requiredText(body.question, "问题", 4000);
      const prior = store.chatTurn(id);
      if (prior) {
        if (
          prior.conversation_id !== conversation.id ||
          prior.question !== question
        )
          throw new InputError("请求标识已用于其他问题", 409);
        send(200, conversation);
        return true;
      }
      if (
        conversation.turns.some((t) => ["queued", "running"].includes(t.status))
      )
        throw new InputError("请等待当前回复完成", 409);
      if (conversation.turns.length >= 100)
        throw new InputError("本次对话已达上限，请重新选择原文开始对话");
      if (!hasCapacity()) throw new InputError("任务较多，请稍后再试", 429);
      const turn = store.createChatTurn(id, conversation.id, question);
      schedule(conversation, turn);
      send(202, store.conversation(conversation.id));
      return true;
    }
    return false;
  };
}
