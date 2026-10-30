export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requiredText(value, label, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new InputError(`${label}不能为空且不得超过 ${max} 个字符`);
  return value.trim();
}
export function tokens(text) {
  const lower = text.toLowerCase();
  const parts = lower.match(/[a-z0-9]+|[\u3400-\u9fff]/g) || [];
  const chinese = lower.match(/[\u3400-\u9fff]+/g) || [];
  for (const phrase of chinese)
    for (let i = 0; i < phrase.length - 1; i++)
      parts.push(phrase.slice(i, i + 2));
  return new Set(parts);
}
export function retrieveMemory(store, projectId, request) {
  const all = store.assets(projectId),
    byId = new Map(all.map((a) => [a.id, a]));
  const selected = [
    ...new Set(
      [request.baseAssetId, ...(request.assetIds || [])].filter(Boolean),
    ),
  ];
  if (selected.length > 6) throw new InputError("每次最多引用 6 份素材");
  if (selected.some((id) => !byId.has(id)))
    throw new InputError("引用素材不属于当前项目");
  if (
    request.mode === "edit" &&
    (!request.baseAssetId || !byId.get(request.baseAssetId)?.data)
  )
    throw new InputError("修改模式需要先选择一张历史图片");
  const query = tokens(
    request.instruction +
      " " +
      selected.map((id) => byId.get(id).content).join(" "),
  );
  const continuation =
    /之前|上次|刚才|沿用|继续|保持|保留|同一个|上一张|它|这个角色|same character|previous|keep|continue/i.test(
      request.selectionText || request.instruction,
    );
  const latestImage = all.find((a) => a.kind === "generated");
  const result = selected.map((id) => ({
    asset: byId.get(id),
    reason: id === request.baseAssetId ? "本次修改的原图" : "你选择的素材",
  }));
  const ranked = all
    .filter((a) => !selected.includes(a.id))
    .map((asset, index) => {
      const terms = tokens(asset.title + " " + asset.content);
      const overlap = [...query].filter((t) => terms.has(t)).length;
      const carryForward = continuation && asset.id === latestImage?.id;
      return {
        asset,
        overlap,
        carryForward,
        score:
          (asset.pinned ? 10000 : 0) +
          (carryForward ? 500 : 0) +
          overlap * 10 -
          index * 0.01,
      };
    })
    .filter(
      (x) =>
        x.asset.pinned ||
        (request.autoMemory !== false &&
          (x.carryForward || (x.asset.kind !== "generated" && x.overlap >= 2))),
    )
    .sort((a, b) => b.score - a.score);
  for (const item of ranked) {
    if (result.length >= 6) break;
    result.push({
      asset: item.asset,
      reason: item.asset.pinned
        ? "项目长期参考"
        : item.carryForward
          ? "延续最近一次创作"
          : "与本次内容相关",
    });
  }
  if (request.mode === "fuse" && result.length < 2)
    throw new InputError("融合模式至少需要两份素材，可以是文字或图片");
  return result;
}
export function memorySnapshot(project, references, jobs = []) {
  return {
    settings: { ...project.settings },
    memoryRevision: project.memoryRevision,
    recentTurns: jobs
      .filter((j) => j.status === "completed")
      .slice(0, 3)
      .reverse()
      .map((j) => ({
        instruction:
          j.request.approvedInstruction ||
          j.request.selectionText ||
          j.request.instruction,
        summary: j.plan?.summary || "",
        resultAssetId: j.result_asset_id,
      })),
    references: references.map(({ asset, reason }) => ({
      id: asset.id,
      title: asset.title,
      kind: asset.kind,
      content: asset.content,
      source: asset.source,
      reason,
      hasImage: Boolean(asset.data),
    })),
  };
}
