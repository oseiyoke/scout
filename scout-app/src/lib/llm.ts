import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { emit } from "@tauri-apps/api/event";
import { PROVIDERS, computeCostUsd, type ProviderId, type ReasoningEffort } from "./constants";
import { getApiKeyInfo, redactSecrets } from "./secrets";
import { getDb, nowIso, uuid } from "./db";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  // K3 contract: the full reasoning trace must be passed back on tool-loop turns.
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  responseFormatJsonObject?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface LlmResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ProviderModel {
  id: string;
  name: string;
}

export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ChatOptions {
  purpose: "sweep_planner" | "sweep_judgment" | "revise" | "denial_distill" | "test";
  sweepId?: string | null;
  proposalId?: string | null;
  onReasoningDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
  transport?: TransportFetch;
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
}

export function parseUsage(raw: any): Usage {
  const u = raw ?? {};
  const cached =
    u.prompt_tokens_details?.cached_tokens ??
    u.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    0;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const usage: Usage = {
    inputTokens: input,
    cachedTokens: Math.min(cached, input),
    outputTokens: output,
    reasoningTokens: reasoning,
    costUsd: 0,
  };
  usage.costUsd = computeCostUsd(usage);
  return usage;
}

/** Incrementally parse an SSE byte stream into JSON payload objects. Exported for tests. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        for (const line of rawEvent.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // ignore non-JSON keep-alive lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** OpenRouter streams reasoning as reasoning_details chunks (reasoning.text / reasoning.summary). */
export function extractReasoningDetails(details: unknown): string {
  if (!Array.isArray(details)) return "";
  return details
    .map((d) => {
      if (!d || typeof d !== "object") return "";
      const item = d as { type?: string; text?: string; summary?: string };
      if (item.type === "reasoning.text" && item.text) return item.text;
      if (item.type === "reasoning.summary" && item.summary) return item.summary;
      return "";
    })
    .join("");
}

interface Accumulated {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCall>;
  usage: Usage | null;
}

/** Apply one streamed chunk to the accumulator. Exported for tests. */
export function applyChunk(acc: Accumulated, chunk: any): { reasoningDelta: string; contentDelta: string } {
  let reasoningDelta = "";
  let contentDelta = "";
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    const rc =
      (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
      (typeof delta.reasoning === "string" && delta.reasoning) ||
      extractReasoningDetails(delta.reasoning_details);
    if (rc) {
      reasoningDelta = rc;
      acc.reasoning += reasoningDelta;
    }
    if (typeof delta.content === "string" && delta.content) {
      contentDelta = delta.content;
      acc.content += contentDelta;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        const existing = acc.toolCalls.get(i) ?? {
          id: tc.id ?? `call_${i}`,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name = tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        acc.toolCalls.set(i, existing);
      }
    }
  }
  if (chunk?.usage) acc.usage = parseUsage(chunk.usage);
  return { reasoningDelta, contentDelta };
}

/**
 * K3 API contract: when replaying an assistant turn inside a multi-turn tool loop,
 * the COMPLETE message must go back — including the reasoning trace, not just the
 * answer. Use this to build replay messages from a result.
 */
export function toReplayMessage(r: LlmResult): ChatMessage {
  return {
    role: "assistant",
    content: r.content || null,
    reasoning_content: r.reasoning || undefined,
    tool_calls: r.toolCalls.length ? r.toolCalls : undefined,
  };
}

function safeEmit(event: string, payload: unknown) {
  try {
    void emit(event, payload);
  } catch {
    // not inside a tauri webview (tests) — ignore
  }
}

let resolvedTransport: TransportFetch | null = null;
async function defaultTransport(): Promise<TransportFetch> {
  if (!resolvedTransport) {
    // tauri-plugin-http bypasses webview CORS for arbitrary API/MCP endpoints.
    resolvedTransport = (url, init) => tauriFetch(url, init as never) as unknown as Promise<Response>;
  }
  return resolvedTransport;
}

/** Test hook */
export function __setTransportForTests(t: TransportFetch | null) {
  resolvedTransport = t;
}

export function parseModelList(payload: unknown): ProviderModel[] {
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : [];
  const seen = new Set<string>();
  return data
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !id.trim() || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name: typeof name === "string" && name.trim() ? name : id }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listProviderModels(
  providerId: ProviderId,
  transportOverride?: TransportFetch,
): Promise<ProviderModel[]> {
  const provider = PROVIDERS[providerId];
  const { key } = await getApiKeyInfo();
  const transport = transportOverride ?? (await defaultTransport());
  const response = await transport(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!response.ok) {
    const detail = redactSecrets(await response.text().catch(() => ""));
    throw new Error(`Could not load models (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  const models = parseModelList(await response.json());
  if (!models.length) throw new Error("The provider returned no compatible models.");
  return models;
}

export async function chat(req: ChatRequest, opts: ChatOptions): Promise<LlmResult> {
  const keyInfo = await getApiKeyInfo();
  const providerId = opts.provider ?? keyInfo.provider ?? (await currentProvider());
  const provider = PROVIDERS[providerId];
  const model = opts.model ?? (keyInfo.provider ? PROVIDERS[keyInfo.provider].defaultModel : await currentModel());
  const apiKey = opts.apiKey ?? keyInfo.key;
  if (!apiKey) throw new Error("No API key configured. Add one in Settings → Model.");

  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.reasoningEffort) {
    if (providerId === "openrouter") {
      // OpenRouter's unified reasoning param (supports low/medium/high/max; maps per-model).
      body.reasoning = { effort: req.reasoningEffort };
    } else {
      body.reasoning_effort = req.reasoningEffort;
    }
  }
  if (req.responseFormatJsonObject) body.response_format = { type: "json_object" };
  if (req.tools) body.tools = req.tools;
  if (req.toolChoice) body.tool_choice = req.toolChoice;
  if (req.maxTokens) body.max_tokens = req.maxTokens;

  const transport = opts.transport ?? (await defaultTransport());
  const callId = uuid();
  const startedAt = nowIso();
  let eventSequence = 0;

  safeEmit("scout:thinking", {
    kind: "start",
    purpose: opts.purpose,
    sweepId: opts.sweepId ?? null,
    callId,
    sequence: eventSequence++,
  });

  const response = await transport(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = redactSecrets(await response.text().catch(() => ""));
    throw new Error(`LLM request failed (${response.status}): ${errText.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("LLM response has no body stream");

  const acc: Accumulated = { content: "", reasoning: "", toolCalls: new Map(), usage: null };
  for await (const chunk of parseSseStream(response.body)) {
    const { reasoningDelta, contentDelta } = applyChunk(acc, chunk);
    if (reasoningDelta) {
      opts.onReasoningDelta?.(reasoningDelta);
      safeEmit("scout:thinking", {
        kind: "reasoning",
        purpose: opts.purpose,
        sweepId: opts.sweepId ?? null,
        callId,
        sequence: eventSequence++,
        delta: reasoningDelta,
      });
    }
    if (contentDelta) {
      opts.onContentDelta?.(contentDelta);
    }
  }

  const result: LlmResult = {
    content: acc.content,
    reasoning: acc.reasoning,
    toolCalls: [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc),
    usage: acc.usage ?? parseUsage(null),
  };

  // Diagnostic content is opt-in because prompts can contain private workspace data.
  try {
    const db = await getDb();
    const { getSettings } = await import("./settings");
    const retain = (await getSettings()).retain_diagnostics;
    await db.execute(
      `INSERT INTO llm_calls (id, sweep_id, proposal_id, at, purpose, request_json, reasoning_content, content, tool_calls_json, usage_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);`,
      [
        callId,
        opts.sweepId ?? null,
        opts.proposalId ?? null,
        startedAt,
        opts.purpose,
        retain ? redactSecrets(JSON.stringify(body)) : JSON.stringify({ redacted: true, purpose: opts.purpose }),
        retain ? result.reasoning || null : null,
        retain ? result.content || null : null,
        retain && result.toolCalls.length ? JSON.stringify(result.toolCalls) : null,
        JSON.stringify(result.usage),
      ],
    );
  } catch {
    // logging must never break the pipeline
  }

  safeEmit("scout:thinking", {
    kind: "end",
    purpose: opts.purpose,
    sweepId: opts.sweepId ?? null,
    callId,
    sequence: eventSequence++,
  });

  return result;
}

// Avoid circular imports: settings are read lazily.
async function currentProvider(): Promise<ProviderId> {
  try {
    const { getSettings } = await import("./settings");
    return (await getSettings()).provider;
  } catch {
    return "moonshot";
  }
}
async function currentModel(): Promise<string> {
  try {
    const { getSettings } = await import("./settings");
    return (await getSettings()).model;
  } catch {
    return PROVIDERS.moonshot.defaultModel;
  }
}

/** 1-token connectivity test for Settings → Model. */
export async function testConnection(opts: Partial<ChatOptions> = {}): Promise<string> {
  const res = await chat(
    { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 8, reasoningEffort: "low" },
    { purpose: "test", ...opts },
  );
  return res.content.trim() || "(empty response)";
}
