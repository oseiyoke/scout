import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbForTests } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";

const chatMock = vi.fn();
vi.mock("../src/lib/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/llm")>();
  return { ...original, chat: (...args: unknown[]) => chatMock(...args) };
});

vi.mock("../src/lib/connectors", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/connectors")>();
  return {
    ...original,
    connectEnabled: vi.fn(async () => [{
      id: "mail",
      name: "Mail",
      url: "demo://mail",
      catalog_id: "demo",
      auth_type: "local",
      enabled: 1,
      status: "connected",
      last_error: null,
      tool_count: 1,
      last_connected_at: null,
      created_at: "",
    }]),
  };
});

import { connectorManager } from "../src/lib/connectors";
import { reviseProposal } from "../src/lib/judgments";
import { getProposal, insertProposal } from "../src/lib/proposals";

describe("task chat", () => {
  beforeEach(async () => {
    __setDbForTests(async () => makeTestDb() as never);
    chatMock.mockReset();
    await connectorManager.disconnect("mail");
  });

  it("uses a read tool before updating the user-facing recommendation", async () => {
    const reads: unknown[] = [];
    connectorManager.__register(
      "mail",
      {
        listTools: async () => [],
        callTool: async (_name, args) => {
          reads.push(args);
          return { text: "Chukwuemeka asked for the launch notes by 3pm.", isError: false };
        },
      },
      [{ name: "search_gmail", description: "Read a complete mail thread", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
    );
    const id = (await insertProposal({
      sweep_id: null,
      category: "needs_reply",
      urgency: "medium",
      confidence: 0.7,
      headline: "Chukwuemeka mentioned you while you were away",
      observation: "The notification excerpt was incomplete.",
      recommended_action: "Check what Chukwuemeka needs.",
      evidence: "[]",
      action_kind: "draft_only",
      action_plan: "[]",
      draft: null,
      dedupe_key: "mention",
    }))!;
    const proposal = (await getProposal(id))!;

    chatMock
      .mockResolvedValueOnce({
        content: "",
        reasoning: "inspect",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "inspect_0", arguments: '{"query":"Chukwuemeka"}' } }],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          message: "I found the full ask and updated the action.",
          recommended_action: "Send Chukwuemeka the launch notes before 3pm today, then confirm delivery in the thread.",
          draft: "I’ll send the launch notes before 3pm today.",
          action_plan: [],
        }),
        reasoning: "done",
        toolCalls: [],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0 },
      });

    const result = await reviseProposal(proposal, "Check what this is actually about.");

    expect(reads).toEqual([{ query: "Chukwuemeka" }]);
    expect(result.message).toContain("full ask");
    expect((await getProposal(id))!.recommended_action).toContain("launch notes");
  });
});
