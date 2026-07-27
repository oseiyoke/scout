import { beforeEach, describe, expect, it } from "vitest";
import { actionSummary } from "../src/components/Card";
import { useScout } from "../src/state/store";
import type { Proposal } from "../src/lib/types";

const baseProposal: Proposal = {
  id: "proposal-1",
  sweep_id: null,
  created_at: "2026-07-25T10:00:00.000Z",
  status: "proposed",
  category: "follow_up",
  urgency: "medium",
  confidence: 0.9,
  headline: "A follow-up is due",
  observation: "The task needs attention.",
  recommended_action: null,
  evidence: "[]",
  action_kind: "tool_call",
  action_plan: "[]",
  approved_action_plan: null,
  draft: null,
  dedupe_key: "follow-up",
  decided_at: null,
  denial_reason: null,
  execution_result: null,
};

beforeEach(() => {
  useScout.setState({
    connectors: [
      {
        id: "tasks-id",
        catalog_id: null,
        name: "Tasks",
        url: "https://example.com/mcp",
        auth_type: "oauth",
        enabled: 1,
        status: "connected",
        last_error: null,
        tool_count: 2,
        last_connected_at: null,
        created_at: "2026-07-25T10:00:00.000Z",
      },
    ],
  });
});

describe("actionSummary", () => {
  it("uses the model-authored recommendation instead of exposing tool plumbing", () => {
    const proposal = {
      ...baseProposal,
      recommended_action: "Confirm what Chukwuemeka needs, then prepare a concise response for approval.",
      action_plan: JSON.stringify([{ connector_id: "browser", tool: "browser_open_page", args: {} }]),
    };

    expect(actionSummary(proposal)).toBe(proposal.recommended_action);
  });

  it("turns a multi-tool plan into a specific ordered action", () => {
    const proposal = {
      ...baseProposal,
      action_plan: JSON.stringify([
        { connector_id: "tasks-id", tool: "task_update_due_date", args: {} },
        { connector_id: "tasks-id", tool: "task_comment_add", args: {} },
      ]),
    };

    expect(actionSummary(proposal)).toBe(
      "Set a new due date in Tasks, then add a comment in Tasks",
    );
  });

  it("names the draft and destination for non-tool proposals", () => {
    const proposal = {
      ...baseProposal,
      action_kind: "draft_only" as const,
      category: "schedule_conflict" as const,
      draft: "Could we move this meeting?",
      evidence: JSON.stringify([{ connector_id: "tasks-id", source: "Calendar" }]),
    };

    expect(actionSummary(proposal)).toBe(
      "Review and send the prepared message to resolve the scheduling conflict.",
    );
  });
});
