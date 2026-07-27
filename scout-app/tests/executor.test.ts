import { describe, it, expect, beforeEach } from "vitest";
import { __setDbForTests } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";
import { connectorManager, isReadTool, type ConnectorClient } from "../src/lib/connectors";
import { insertProposal, applyVerb, getProposal } from "../src/lib/proposals";
import { executeProposal } from "../src/lib/executor";

class FakeClient implements ConnectorClient {
  calls: { tool: string; args: unknown }[] = [];
  failOn?: string;
  async callTool(tool: string, args: Record<string, unknown>) {
    this.calls.push({ tool, args });
    if (tool === this.failOn) return { text: "server said no", isError: true };
    return { text: `ok:${tool}`, isError: false };
  }
}

const TOOLS = [
  { name: "read_meetings", description: "read" },
  { name: "task_create", description: "write" },
  {
    name: "task_set_due_date",
    description: "set a due date",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, dueDate: { type: "string" } },
      required: ["taskId", "dueDate"],
    },
  },
  { name: "post_slack_message", description: "write" },
];

function setupConnector() {
  const client = new FakeClient();
  connectorManager.__register("c1", client, TOOLS);
  return client;
}

const mk = (over: Record<string, unknown> = {}) => ({
  sweep_id: null,
  category: "follow_up" as const,
  urgency: "high" as const,
  confidence: 0.9,
  headline: "H",
  observation: "O",
  recommended_action: "Complete the proposed action.",
  evidence: "[]",
  action_kind: "tool_call" as const,
  action_plan: "[]",
  draft: null,
  dedupe_key: Math.random().toString(36).slice(2),
  ...over,
});

beforeEach(() => {
  __setDbForTests(async () => makeTestDb() as never);
  connectorManager.disconnect("c1");
});

describe("read/write classification", () => {
  it("classifies tools by name heuristic", () => {
    expect(isReadTool({ name: "read_meetings" })).toBe(true);
    expect(isReadTool({ name: "search_gmail" })).toBe(true);
    expect(isReadTool({ name: "task_my_open" })).toBe(false);
    expect(isReadTool({ name: "anything", annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadTool({ name: "delete_preview", annotations: { readOnlyHint: true } })).toBe(false);
    expect(isReadTool({ name: "task_create" })).toBe(false);
    expect(isReadTool({ name: "send_email" })).toBe(false);
  });

  it("GUARDRAIL: sweeps cannot call write tools via callReadTool", async () => {
    setupConnector();
    await expect(connectorManager.callReadTool("c1", "task_create", {})).rejects.toThrow(/write tool/);
    const r = await connectorManager.callReadTool("c1", "read_meetings", {});
    expect(r.text).toBe("ok:read_meetings");
  });
});

describe("executor", () => {
  it("runs action plans sequentially and records results", async () => {
    const client = setupConnector();
    const id = (await insertProposal(
      mk({
        action_plan: JSON.stringify([
          { connector_id: "c1", tool: "task_create", args: { title: "x" } },
          { connector_id: "c1", tool: "post_slack_message", args: { channel: "#eng" } },
        ]),
      }),
    ))!;
    await applyVerb(id, "run");
    const out = await executeProposal(id);
    expect(out.ok).toBe(true);
    expect(client.calls.map((c) => c.tool)).toEqual(["task_create", "post_slack_message"]);
    expect((await getProposal(id))!.status).toBe("executed");
  });

  it("aligns snake_case plan arguments to the tool's advertised schema", async () => {
    const client = setupConnector();
    const id = (await insertProposal(
      mk({
        action_plan: JSON.stringify([
          {
            connector_id: "c1",
            tool: "task_set_due_date",
            args: { task_id: "task-1", due_date: "2026-07-29T12:00:00.000Z" },
          },
        ]),
      }),
    ))!;
    await applyVerb(id, "run");

    const out = await executeProposal(id);

    expect(out.ok).toBe(true);
    expect(client.calls[0].args).toEqual({
      taskId: "task-1",
      dueDate: "2026-07-29T12:00:00.000Z",
    });
  });

  it("stops at first failure, keeps partial results, re-queues to inbox", async () => {
    const client = setupConnector();
    client.failOn = "task_create";
    const id = (await insertProposal(
      mk({
        action_plan: JSON.stringify([
          { connector_id: "c1", tool: "task_create", args: {} },
          { connector_id: "c1", tool: "post_slack_message", args: {} },
        ]),
      }),
    ))!;
    await applyVerb(id, "run");
    const out = await executeProposal(id);
    expect(out.ok).toBe(false);
    expect(client.calls).toHaveLength(1); // second call never ran
    const p = (await getProposal(id))!;
    expect(p.status).toBe("failed");
    expect(JSON.parse(p.execution_result!).results).toHaveLength(1);
    // retry path: failed → approved is legal
    await applyVerb(id, "run");
    expect((await getProposal(id))!.status).toBe("approved");
  });

  it("draft_only proposals execute without tool calls", async () => {
    const client = setupConnector();
    const id = (await insertProposal(mk({ action_kind: "draft_only", draft: "hello" })))!;
    await applyVerb(id, "run");
    const out = await executeProposal(id);
    expect(out.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect((await getProposal(id))!.status).toBe("executed");
  });

  it("refuses to execute unapproved proposals", async () => {
    setupConnector();
    const id = (await insertProposal(mk()))!;
    await expect(executeProposal(id)).rejects.toThrow(/Cannot execute/);
  });

  it("executes the immutable plan snapshot captured at approval", async () => {
    const client = setupConnector();
    const id = (await insertProposal(
      mk({ action_plan: JSON.stringify([{ connector_id: "c1", tool: "task_create", args: {} }]) }),
    ))!;
    await applyVerb(id, "run");
    const db = await import("../src/lib/db").then((m) => m.getDb());
    await db.execute("UPDATE proposals SET action_plan=$1 WHERE id=$2", [
      JSON.stringify([{ connector_id: "c1", tool: "post_slack_message", args: {} }]), id,
    ]);
    await executeProposal(id);
    expect(client.calls.map((call) => call.tool)).toEqual(["task_create"]);
  });

  it("rejects tools that are not in the current catalog", async () => {
    setupConnector();
    const id = (await insertProposal(
      mk({ action_plan: JSON.stringify([{ connector_id: "c1", tool: "unknown_write", args: {} }]) }),
    ))!;
    await applyVerb(id, "run");
    const outcome = await executeProposal(id);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not found/);
  });
});
