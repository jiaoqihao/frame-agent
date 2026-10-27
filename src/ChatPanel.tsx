import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { api } from "./api";
import type { Conversation, ConversationSummary } from "./types";

function Answer({ text }: { text: string }) {
  // Render common emphasis without interpreting HTML or loading remote content.
  return (
    <>
      {text
        .split(/(\*\*[^*\n]+\*\*)/g)
        .map((part, i) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </>
  );
}

export default function ChatPanel({
  projectId,
  conversations,
  targetId,
}: {
  projectId: string;
  conversations: ConversationSummary[];
  targetId?: string;
}) {
  const [id, setId] = useState(
    targetId ||
      localStorage.getItem(`chat:${projectId}`) ||
      conversations[0]?.id ||
      "",
  );
  const [chat, setChat] = useState<Conversation | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const current = useRef(id);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  current.current = id;
  const retry = useRef<{ requestId: string; question: string } | null>(null);
  useEffect(() => {
    if (targetId) setId(targetId);
  }, [targetId]);
  useEffect(() => {
    if (!id && conversations[0]) setId(conversations[0].id);
  }, [id, conversations]);
  useEffect(() => {
    setChat(null);
    followLatest.current = true;
    setError("");
    setQuestion(localStorage.getItem(`question:${id}`) || "");
    retry.current = null;
  }, [id]);
  useEffect(() => {
    if (!id) return;
    localStorage.setItem(`chat:${projectId}`, id);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<Conversation>(
          `/api/projects/${projectId}/conversations/${id}`,
        );
        if (stopped) return;
        setChat(value);
        if (value.turns.some((t) => ["queued", "running"].includes(t.status)))
          timer = setTimeout(load, 1000);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, projectId, refreshToken]);
  useEffect(() => {
    if (messagesRef.current && followLatest.current)
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [chat]);
  const running =
    sending ||
    chat?.turns.some((t) => ["queued", "running"].includes(t.status));
  async function send(value = question) {
    if (!value.trim() || running || !id) return;
    const destination = id;
    const body =
      retry.current?.question === value
        ? retry.current
        : { requestId: crypto.randomUUID(), question: value };
    retry.current = body;
    followLatest.current = true;
    setSending(true);
    setError("");
    try {
      const updated = await api<Conversation>(
        `/api/projects/${projectId}/conversations/${destination}/messages`,
        body,
      );
      if (current.current === destination) {
        setChat(updated);
        setQuestion("");
        localStorage.removeItem(`question:${destination}`);
        retry.current = null;
        setRefreshToken((v) => v + 1);
      }
    } catch (e) {
      if (current.current === destination) setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="chat-panel" aria-label="AI 解释对话">
      {!!conversations.length && (
        <select
          aria-label="解释记录"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.selection.slice(0, 45)}
            </option>
          ))}
        </select>
      )}
      {!id ? (
        <div className="chat-empty">在网页选中文字，右键选择「AI 解释」。</div>
      ) : (
        <>
          {chat && (
            <details className="chat-source">
              <summary>原文</summary>
              <p>{chat.selection}</p>
            </details>
          )}
          <div
            className="chat-messages"
            role="log"
            aria-live="polite"
            ref={messagesRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              followLatest.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {chat?.turns.map((turn, index) => (
              <div className="chat-turn" key={turn.id}>
                {index > 0 && (
                  <div className="chat-question">{turn.question}</div>
                )}
                <div className="chat-answer">
                  {turn.status === "completed" ? (
                    <Answer text={turn.answer || ""} />
                  ) : turn.status === "failed" ? (
                    <>
                      <p role="alert">{turn.error}</p>
                      <button
                        className="text-button"
                        disabled={!!running}
                        onClick={() => void send(turn.question)}
                      >
                        重试
                      </button>
                    </>
                  ) : (
                    <span className="chat-pending">
                      <LoaderCircle className="spin" size={16} />
                      正在思考…
                    </span>
                  )}
                </div>
              </div>
            ))}
            {!chat && !error && (
              <span className="chat-pending">
                <LoaderCircle className="spin" size={16} />
                正在读取…
              </span>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  setRefreshToken((v) => v + 1);
                }}
              >
                刷新对话
              </button>
            </p>
          )}
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="继续追问"
              placeholder="继续追问…"
              maxLength={4000}
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                localStorage.setItem(`question:${id}`, e.target.value);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="button primary"
              type="submit"
              disabled={!question.trim() || !!running || !chat}
              aria-label="发送追问"
            >
              <Send size={17} />
            </button>
          </form>
        </>
      )}
    </section>
  );
}
