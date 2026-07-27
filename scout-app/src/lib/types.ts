import type { Autonomy, Category, ProviderId, ReasoningEffort, Urgency } from "./constants";

export interface Connector {
  id: string;
  name: string;
  url: string;
  catalog_id: string | null;
  auth_type: "oauth" | "oauth_credentials" | "bearer" | "headers" | "local";
  enabled: number; // 0|1
  status: "disconnected" | "connected" | "error";
  last_error: string | null;
  tool_count: number;
  last_connected_at: string | null;
  created_at: string;
}

export interface Sweep {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "done" | "error";
  sources_summary: string | null; // JSON
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  proposal_count: number;
  error: string | null;
}

export type ProposalStatus =
  | "proposed"
  | "approved"
  | "executing"
  | "executed"
  | "failed"
  | "dismissed"
  | "handled_by_human"
  | "expired";

export interface EvidenceItem {
  source: string;
  connector_id: string;
  ref: string;
  quote: string;
  url?: string;
}

export interface PlannedToolCall {
  connector_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Proposal {
  id: string;
  sweep_id: string | null;
  created_at: string;
  status: ProposalStatus;
  category: Category;
  urgency: Urgency;
  confidence: number;
  headline: string;
  observation: string;
  recommended_action: string | null;
  evidence: string; // JSON EvidenceItem[]
  action_kind: "tool_call" | "draft_only" | "fyi";
  action_plan: string; // JSON PlannedToolCall[]
  approved_action_plan: string | null; // immutable JSON snapshot captured at approval
  draft: string | null;
  dedupe_key: string;
  decided_at: string | null;
  denial_reason: string | null;
  execution_result: string | null;
}

export interface Judgment {
  id: string;
  created_at: string;
  kind: "denial" | "preference" | "takeover";
  category: string | null;
  lesson: string;
  source_proposal_id: string | null;
}

export interface ActivityLine {
  id: number;
  sweep_id: string | null;
  at: string;
  line: string;
}

export interface LlmCall {
  id: string;
  sweep_id: string | null;
  proposal_id: string | null;
  at: string;
  purpose: "sweep_planner" | "sweep_judgment" | "revise" | "denial_distill" | "test";
  request_json: string;
  reasoning_content: string | null;
  content: string | null;
  tool_calls_json: string | null;
  usage_json: string | null;
}

export interface Settings {
  sweep_interval_minutes: number;
  provider: ProviderId;
  model: string;
  autonomy: Autonomy;
  quiet_hours: string;
  user_name: string;
  user_context: string;
  judgment_effort: ReasoningEffort;
  safe_tools: string[]; // retained only to migrate older installations
  demo_mode: boolean;
  menu_bar_only: boolean;
  launch_at_login: boolean;
  browser_sweep_enabled: boolean;
  browser_access_mode: "current_tab" | "allowed_sites" | "full_profile";
  browser_allowed_domains: string[];
  retain_diagnostics: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface SourceChunk {
  header: string;
  body: string;
  connectorId: string;
  tool: string;
}
