// Single source of truth for model ids, providers and pricing.
// Prices verified against https://platform.moonshot.ai/docs/pricing/chat-k3 (build time).

export const PROVIDERS = {
  moonshot: {
    label: "Moonshot direct",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "moonshotai/kimi-k3",
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

// USD per 1M tokens. Reasoning tokens are billed as output tokens.
export const PRICING = {
  inputPer1M: 3.0, // cache miss
  cachedInputPer1M: 0.3, // cache hit
  outputPer1M: 15.0, // includes reasoning tokens
} as const;

export const DEFAULTS = {
  sweepIntervalMinutes: 30,
  maxSnapshotTokens: 300_000,
  maxPlannerToolCalls: 12,
  maxProposalsPerSweep: 6,
  proposalExpiryHours: 48,
  dedupeWindowDays: 7,
  quietHours: "", // e.g. "22:00-07:00", empty = off
  autonomy: "manual" as Autonomy,
  userName: "there",
  userContext: "",
  model: PROVIDERS.moonshot.defaultModel,
  provider: "moonshot" as ProviderId,
  judgmentEffort: "max" as ReasoningEffort,
  browserSweepEnabled: false,
  browserAccessMode: "allowed_sites" as const,
  browserAllowedDomains: [] as string[],
};

export type Autonomy = "off" | "manual";
export type ReasoningEffort = "low" | "high" | "max";

export const CATEGORIES = [
  "dropped_commitment",
  "needs_reply",
  "schedule_conflict",
  "stale_pr",
  "follow_up",
  "fyi",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ["high", "medium", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

// Tool names matching these are treated as read-only; everything else is a write tool.
export const READ_TOOL_PATTERN = /(^|_)(get|list|search|read|find|fetch|query|retrieve|describe|show)(_|$)/i;
export const DESTRUCTIVE_TOOL_PATTERN = /(^|_)(create|update|edit|set|write|send|post|put|patch|delete|remove|archive|execute|run|trigger|approve|reject|cancel|close|merge|move|upload)(_|$)/i;

export function computeCostUsd(usage: {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (
    (uncached * PRICING.inputPer1M +
      usage.cachedTokens * PRICING.cachedInputPer1M +
      usage.outputTokens * PRICING.outputPer1M) /
    1_000_000
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
