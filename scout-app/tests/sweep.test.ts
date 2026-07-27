import { describe, it, expect, beforeEach, vi } from "vitest";
import { __setDbForTests, getDb } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";
import { truncateSnapshot } from "../src/lib/sweep";
import { isQuietHours } from "../src/lib/settings";
import type { SourceChunk } from "../src/lib/types";

// Mock the LLM + connectors so the pipeline runs offline.
const chatMock = vi.fn();
vi.mock("../src/lib/llm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/llm")>();
  return { ...orig, chat: (...args: unknown[]) => chatMock(...args) };
});
vi.mock("../src/lib/connectors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/connectors")>();
  return {
    ...orig,
    connectEnabled: vi.fn(async () => [
      { id: "c1", name: "Acme", url: "demo://acme", enabled: 1, status: "connected", last_error: null, tool_count: 2, created_at: "" },
    ]),
  };
});

import { runSweep } from "../src/lib/sweep";
import { connectorManager } from "../src/lib/connectors";
import { listOpenProposals } from "../src/lib/proposals";

function llmResult(content: string) {
  return {
    content,
    reasoning: "trace",
    toolCalls: [],
    usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, reasoningTokens: 0, costUsd: 0.001 },
  };
}

beforeEach(() => {
  __setDbForTests(async () => makeTestDb() as never);
  chatMock.mockReset();
  connectorManager.__register(
    "c1",
    { callTool: async () => ({ text: "fixture data", isError: false }) },
    [
      { name: "read_meetings", description: "transcripts" },
      {
        name: "task_set_due_date",
        description: "set a due date",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" }, dueDate: { type: "string" } },
          required: ["taskId", "dueDate"],
        },
      },
    ],
  );
});

describe("snapshot truncation", () => {
  const chunk = (id: string, body: string): SourceChunk => ({
    header: `=== SOURCE ${id} ===`,
    body,
    connectorId: "c1",
    tool: "t",
  });

  it("drops oldest sources first", () => {
    const chunks = [chunk("old", "x".repeat(4000)), chunk("mid", "y".repeat(4000)), chunk("new", "z".repeat(4000))];
    const out = truncateSnapshot(chunks, 2200); // ~2 chunks fit
    expect(out.map((c) => c.header)).not.toContain("=== SOURCE old ===");
    expect(out.map((c) => c.header)).toContain("=== SOURCE new ===");
  });

  it("truncates a single oversized source from the front", () => {
    const out = truncateSnapshot([chunk("only", "A".repeat(4000) + "RECENT")], 300);
    expect(out).toHaveLength(1);
    expect(out[0].body.endsWith("RECENT")).toBe(true);
    expect(out[0].body).toContain("truncated");
    expect(out[0].body.length).toBeLessThan(300 * 4);
  });

  it("leaves small snapshots alone", () => {
    const chunks = [chunk("a", "tiny")];
    expect(truncateSnapshot(chunks, 1000)).toEqual(chunks);
  });
});

describe("quiet hours", () => {
  it("parses overnight windows", () => {
    expect(isQuietHours("22:00-07:00", new Date("2026-01-01T23:00:00"))).toBe(true);
    expect(isQuietHours("22:00-07:00", new Date("2026-01-01T03:00:00"))).toBe(true);
    expect(isQuietHours("22:00-07:00", new Date("2026-01-01T12:00:00"))).toBe(false);
    expect(isQuietHours("", new Date())).toBe(false);
  });
});

describe("sweep pipeline (mocked LLM)", () => {
  const validProposal = {
    category: "follow_up",
    urgency: "high",
    confidence: 0.9,
    headline: "You owe Rita a shortlist",
    observation: "obs",
    recommended_action: "Send Rita the prepared shortlist and close the loop today.",
    evidence: [{ source: "Gmail", connector_id: "c1", ref: "email", quote: "need your top 3" }],
    action_kind: "draft_only",
    action_plan: [],
    draft: "Hi Rita…",
    dedupe_key: "rita-shortlist",
  };

  it("runs an explicit manual sweep while automation is paused", async () => {
    const db = await getDb();
    await db.execute("INSERT INTO settings (key,value) VALUES ('autonomy','off');");
    chatMock
      .mockResolvedValueOnce(llmResult(JSON.stringify({ calls: [{ connector_id: "c1", tool: "read_meetings", args: {} }] })))
      .mockResolvedValueOnce(llmResult(JSON.stringify({ proposals: [] })));
    const out = await runSweep("manual");
    expect(out.status).toBe("done");
  });

  it("skips scheduled sweeps while automation is paused", async () => {
    const db = await getDb();
    await db.execute("INSERT INTO settings (key,value) VALUES ('autonomy','off');");
    const out = await runSweep("scheduled");
    expect(out.status).toBe("skipped");
    expect(out.error).toBe("automatic sweeps paused");
  });

  it("planner → snapshot → judgment → proposals in DB, with usage recorded", async () => {
    const responses = [
      JSON.stringify({ calls: [{ connector_id: "c1", tool: "read_meetings", args: {}, why: "meetings" }] }),
      JSON.stringify({ proposals: [validProposal] }),
    ];
    chatMock.mockImplementation(async (_req: unknown, opts: { sweepId?: string | null; purpose: string }) => {
      const content = responses.shift()!;
      // persist an llm_calls row, as the real client does
      const db = await getDb();
      await db.execute(
        "INSERT INTO llm_calls (id, sweep_id, proposal_id, at, purpose, request_json, reasoning_content, content) VALUES ($1,$2,NULL,$3,$4,'{}','trace',$5);",
        [crypto.randomUUID(), opts.sweepId ?? null, new Date().toISOString(), opts.purpose, content],
      );
      return llmResult(content);
    });

    const out = await runSweep("manual");
    expect(out.status).toBe("done");
    expect(out.proposalCount).toBe(1);
    const judgmentRequest = chatMock.mock.calls[1][0] as { messages: { content: string }[] };
    expect(judgmentRequest.messages[0].content).toContain('"taskId"');
    expect(judgmentRequest.messages[0].content).toContain('"dueDate"');
    expect(judgmentRequest.messages[0].content).toContain("recommended_action");
    expect(judgmentRequest.messages[0].content).toContain("Browser open page");
    const open = await listOpenProposals();
    expect(open).toHaveLength(1);
    expect(open[0].headline).toBe("You owe Rita a shortlist");
    expect(open[0].recommended_action).toBe(validProposal.recommended_action);

    const db = await getDb();
    const sweeps = await db.select<{ status: string; input_tokens: number; cost_usd: number }[]>("SELECT * FROM sweeps;");
    expect(sweeps[0].status).toBe("done");
    expect(sweeps[0].input_tokens).toBe(200); // planner + judgment
    expect(sweeps[0].cost_usd).toBeCloseTo(0.002, 6);

    // activity lines were written
    const lines = await db.select<{ line: string }[]>("SELECT * FROM activity;");
    expect(lines.some((l) => l.line.includes("read_meetings"))).toBe(true);

    // both LLM calls recorded (mock persists rows like the real client does)
    const calls = await db.select<{ purpose: string; reasoning_content: string }[]>("SELECT * FROM llm_calls ORDER BY at;");
    expect(calls.map((c) => c.purpose)).toEqual(["sweep_planner", "sweep_judgment"]);
    expect(calls.every((c) => c.reasoning_content === "trace")).toBe(true);
  });

  it("retries once when judgment output fails validation", async () => {
    chatMock
      .mockResolvedValueOnce(llmResult(JSON.stringify({ calls: [{ connector_id: "c1", tool: "read_meetings", args: {} }] })))
      .mockResolvedValueOnce(llmResult("this is not json"))
      .mockResolvedValueOnce(llmResult(JSON.stringify({ proposals: [validProposal] })));
    const out = await runSweep("manual");
    expect(out.status).toBe("done");
    expect(chatMock).toHaveBeenCalledTimes(3);
  });

  it("fails the sweep when output is invalid twice", async () => {
    chatMock
      .mockResolvedValueOnce(llmResult(JSON.stringify({ calls: [{ connector_id: "c1", tool: "read_meetings", args: {} }] })))
      .mockResolvedValueOnce(llmResult("nope"))
      .mockResolvedValueOnce(llmResult("still nope"));
    const out = await runSweep("manual");
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/invalid after retry/);
  });

  it("dedupes across sweeps via dedupe_key", async () => {
    const plan = llmResult(JSON.stringify({ calls: [{ connector_id: "c1", tool: "read_meetings", args: {} }] }));
    const judgment = llmResult(JSON.stringify({ proposals: [validProposal] }));
    chatMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(judgment);
    await runSweep("manual");
    chatMock.mockResolvedValueOnce(plan).mockResolvedValueOnce(judgment);
    const out2 = await runSweep("manual");
    expect(out2.proposalCount).toBe(0); // same dedupe_key → not re-proposed
    expect(await listOpenProposals()).toHaveLength(1);
  });

  it("refuses a second concurrent sweep", async () => {
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    chatMock.mockImplementationOnce(async () => {
      await gate;
      return llmResult(JSON.stringify({ calls: [] }));
    });
    const first = runSweep("manual");
    const second = await runSweep("manual");
    expect(second.status).toBe("skipped");
    expect(second.error).toBe("already running");
    release!();
    await first;
  });
});
