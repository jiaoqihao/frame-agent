export type Settings = {
  purpose: string;
  style: string;
  palette: string;
  ratio: string;
  constraints: string;
  subjectIdentity: string;
  typography: string;
  avoid: string;
};
export type Project = {
  id: string;
  name: string;
  settings: Settings;
  created_at: string;
  memoryRevision: string;
  canUndoMemory: boolean;
};
export type Asset = {
  id: string;
  project_id: string;
  kind: "text" | "image" | "generated";
  title: string;
  content: string;
  source: string;
  pinned: boolean;
  imageUrl: string | null;
  mime: string | null;
  created_at: string;
};
export type Reference = {
  id: string;
  title: string;
  kind: string;
  reason: string;
  content: string;
  source: string;
  hasImage: boolean;
};
export type Plan = {
  title: string;
  summary: string;
  prompt: string;
  preserved: string[];
  changes: string[];
  provider: string;
  renderer?: "svg" | "image_api";
  routeReason?: string;
  routeSource?: string;
  skill?: string | null;
  svgEngine?: "echarts" | "antv" | "free";
  svgSpec?: Record<string, unknown> | null;
  quality?: { checks: string[]; repairs: number };
  snapshot: {
    settings: Settings;
    references: Reference[];
    recentTurns?: {
      instruction: string;
      summary: string;
      resultAssetId: string;
    }[];
  };
};
export type Job = {
  id: string;
  project_id: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  result_asset_id: string | null;
  error: string | null;
  plan: Plan | null;
  created_at: string;
  request: {
    instruction: string;
    selectionText?: string;
    mode: string;
    assetIds: string[];
    baseAssetId: string | null;
    autoMemory: boolean;
  };
};
export type ConversationSummary = {
  id: string;
  selection: string;
  created_at: string;
};
export type Conversation = ConversationSummary & {
  project_id: string;
  source: string;
  turns: {
    id: string;
    question: string;
    answer: string | null;
    status: "queued" | "running" | "completed" | "failed";
    error: string | null;
  }[];
};
export type Detail = {
  project: Project;
  assets: Asset[];
  jobs: Job[];
  conversations: ConversationSummary[];
};
export type Capture = {
  id: string;
  kind: "text" | "image";
  title: string;
  content?: string;
  dataUrl?: string;
  source: string;
  createdAt: number;
  projectId?: string | null;
};
