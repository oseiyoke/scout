import { describe, it, expect, beforeEach } from "vitest";
import { applyChunk, parseModelList, parseSseStream, parseUsage, chat, toReplayMessage, __setTransportForTests } from "../src/lib/llm";
import { computeCostUsd, PRICING } from "../src/lib/constants";
import { redactSecrets } from "../src/lib/secrets";
import { __setDbForTests, getDb } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("SSE parsing", () => {
  it("splits reasoning_content from content deltas", async () => {
    const res = sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking " } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: "more" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "answer" } }] }),
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ]);
    const acc = { content: "", reasoning: "", toolCalls: new Map(), usage: null };
    for await (const chunk of parseSseStream(res.body!)) applyChunk(acc, chunk);
    expect(acc.reasoning).toBe("thinking more");
    expect(acc.content).toBe("answer");
    expect(acc.usage?.inputTokens).toBe(10);
  });

  it("assembles streamed tool_calls across chunks", async () => {
    const acc = { content: "", reasoning: "", toolCalls: new Map(), usage: null };
    applyChunk(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_", arguments: "{\"a\":" } }] } }] });
    applyChunk(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] });
    const calls = [...acc.toolCalls.values()];
    expect(calls[0].function.name).toBe("read_");
    expect(calls[0].function.arguments).toBe('{"a":1}');
    expect(calls[0].id).toBe("c1");
  });

  it("handles fragmented SSE events across byte boundaries", async () => {
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(full);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); // 3-byte fragments
        c.close();
      },
    });
    const acc = { content: "", reasoning: "", toolCalls: new Map(), usage: null };
    for await (const chunk of parseSseStream(stream)) applyChunk(acc, chunk);
    expect(acc.content).toBe("hello");
  });
});

describe("usage + cost accounting", () => {
  it("reads cached tokens from prompt_tokens_details", () => {
    const u = parseUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } });
    expect(u.cachedTokens).toBe(600);
    expect(u.inputTokens).toBe(1000);
  });

  it("reads cached tokens from Moonshot-style prompt_cache_hit_tokens", () => {
    const u = parseUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400 });
    expect(u.cachedTokens).toBe(400);
  });

  it("prices uncached input, cached input and output per the constants file", () => {
    const cost = computeCostUsd({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(PRICING.cachedInputPer1M + PRICING.outputPer1M, 6);
  });

  it("counts reasoning tokens as output (billed at output rate)", () => {
    const u = parseUsage({ prompt_tokens: 0, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } });
    expect(u.reasoningTokens).toBe(500);
    expect(u.costUsd).toBeCloseTo((500 * PRICING.outputPer1M) / 1_000_000, 9);
  });
});

describe("model catalog", () => {
  it("normalizes, deduplicates, and sorts provider models", () => {
    expect(parseModelList({ data: [
      { id: "z/model", name: "Zulu" },
      { id: "a/model", name: "Alpha" },
      { id: "z/model", name: "Duplicate" },
      { id: "plain-model" },
      { name: "missing id" },
    ] })).toEqual([
      { id: "a/model", name: "Alpha" },
      { id: "plain-model", name: "plain-model" },
      { id: "z/model", name: "Zulu" },
    ]);
  });
});

describe("secret redaction", () => {
  it("strips bearer tokens and api keys from logs", () => {
    const out = redactSecrets("Authorization: Bearer sk-abc123def456");
    expect(out).not.toContain("sk-abc123def456");
    expect(out).toContain("[REDACTED]");
    expect(redactSecrets('{"api_key":"sk-xyz"}')).toBe('{"api_key":"[REDACTED]"}');
  });

  it("strips OAuth credentials and tokens from provider errors", () => {
    const out = redactSecrets("client_secret=hunter2&access_token=abc123 refresh_token: refresh-me");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("refresh-me");
  });
});

describe("replay contract", () => {
  it("toReplayMessage includes the full reasoning trace and tool calls", () => {
    const msg = toReplayMessage({
      content: "ans",
      reasoning: "long trace",
      toolCalls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }],
      usage: parseUsage(null),
    });
    expect(msg.reasoning_content).toBe("long trace");
    expect(msg.tool_calls).toHaveLength(1);
  });
});

describe("chat() persistence", () => {
  beforeEach(() => __setDbForTests(async () => makeTestDb() as never));

  it("redacts persisted model diagnostics by default", async () => {
    __setTransportForTests(async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
        JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] }),
        JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      ]),
    );
    const res = await chat(
      { messages: [{ role: "user", content: "hi" }] },
      { purpose: "test", apiKey: "sk-test", provider: "moonshot", model: "kimi-k3" },
    );
    expect(res.reasoning).toBe("hmm");
    const db = await getDb();
    const rows = await db.select<{ request_json: string; reasoning_content: string | null; usage_json: string; purpose: string }[]>(
      "SELECT * FROM llm_calls;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reasoning_content).toBeNull();
    expect(JSON.parse(rows[0].request_json)).toEqual({ redacted: true, purpose: "test" });
    expect(JSON.parse(rows[0].usage_json).inputTokens).toBe(12);
    expect(rows[0].purpose).toBe("test");
    __setTransportForTests(null);
  });
});
