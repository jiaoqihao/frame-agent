import { useEffect, useState } from "react";
import { assetUrl } from "./api";
import type { Asset, Job } from "./types";

export default function ReviewCard({
  job,
  assets,
  busy,
  onApprove,
  onCancel,
}: {
  job: Job;
  assets: Asset[];
  busy: boolean;
  onApprove: (job: Job, instruction: string) => void;
  onCancel: (job: Job) => void;
}) {
  const review = job.plan!.review!;
  const draftKey = `frame-review:${job.id}:${review.revision}`;
  const [text, setText] = useState(
    () => localStorage.getItem(draftKey) ?? review.adaptedInstruction,
  );
  useEffect(() => {
    localStorage.setItem(draftKey, text);
  }, [draftKey, text]);
  const images = assets.filter(
    (a) =>
      a.imageUrl && job.plan!.snapshot.references.some((r) => r.id === a.id),
  );
  return (
    <section className="card review-card" aria-label="审核绘图说明">
      <div className="section-title">
        <h2>审核绘图说明</h2>
        <span className="quiet">
          {review.suitability === "ready"
            ? "可直接表达"
            : review.suitability === "needs_information"
              ? "需要补充信息"
              : "已整理内容"}
        </span>
      </div>
      <p className="review-understanding">{review.understanding}</p>
      {review.changes.length > 0 && (
        <details className="review-details">
          <summary>整理了什么</summary>
          <ul>
            {review.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      {review.uncertainties.length > 0 && (
        <div className="review-questions">
          <strong>请核实或补充</strong>
          <ul>
            {review.uncertainties.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="review-details">
        <summary>查看原始内容与参考</summary>
        <p className="review-original">
          {job.request.selectionText || job.request.instruction}
        </p>
        {job
          .plan!.snapshot.references.filter((r) => !r.hasImage)
          .map((r) => (
            <p key={r.id} className="review-original">
              {r.content}
            </p>
          ))}
        {images.map((a) => (
          <img
            key={a.id}
            className="review-source-image"
            src={assetUrl(a.imageUrl)}
            alt={a.title || "原始截图"}
          />
        ))}
      </details>
      <label className="field">
        绘图说明
        <textarea
          aria-label="审核后的绘图说明"
          rows={7}
          value={text}
          maxLength={12000}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="review-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => onCancel(job)}
        >
          放弃
        </button>
        <button
          className="button primary"
          disabled={busy || !text.trim()}
          onClick={() => onApprove(job, text)}
        >
          确认并生成
        </button>
      </div>
    </section>
  );
}
