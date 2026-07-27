import { connectorManager } from "./connectors";
import { transition, getProposal } from "./proposals";
import { logActivity } from "./activity";
import type { PlannedToolCall } from "./types";

export interface ExecutionOutcome {
  ok: boolean;
  results: { tool: string; connector_id: string; text: string; isError: boolean }[];
  error?: string;
}

/** Run the immutable action-plan snapshot captured by the user's approval. */
export async function executeProposal(proposalId: string): Promise<ExecutionOutcome> {
  const p = await getProposal(proposalId);
  if (!p) throw new Error(`Proposal ${proposalId} not found`);
  if (p.status !== "approved") {
    throw new Error(`Cannot execute proposal in status ${p.status}`);
  }

  if (p.action_kind === "tool_call" && !p.approved_action_plan) {
    throw new Error("This proposal has no approved action-plan snapshot");
  }
  const plan: PlannedToolCall[] = JSON.parse(p.approved_action_plan || "[]");

  // draft_only: nothing to run — caller copies the draft / opens the link.
  if (p.action_kind === "draft_only" || p.action_kind === "fyi" || plan.length === 0) {
    await transition(proposalId, "executing");
    const outcome: ExecutionOutcome = { ok: true, results: [] };
    await transition(proposalId, "executed", { execution_result: JSON.stringify(outcome) });
    return outcome;
  }

  await transition(proposalId, "executing");
  await logActivity(`Executing: ${p.headline}`, p.sweep_id);

  const results: ExecutionOutcome["results"] = [];
  let failure: string | null = null;
  for (const call of plan) {
    try {
      const r = await connectorManager.callWriteTool(call.connector_id, call.tool, call.args);
      results.push({ tool: call.tool, connector_id: call.connector_id, text: r.text, isError: r.isError });
      await logActivity(
        r.isError ? `✗ ${call.tool} failed: ${toolErrorSummary(r.text)}` : `✓ ${call.tool} executed`,
        p.sweep_id,
      );
      if (r.isError) {
        failure = `${call.tool}: ${r.text.slice(0, 300)}`;
        break; // sequential plan: stop at first failure, keep partial results
      }
    } catch (e) {
      failure = `${call.tool}: ${e instanceof Error ? e.message : String(e)}`;
      results.push({ tool: call.tool, connector_id: call.connector_id, text: failure, isError: true });
      await logActivity(`✗ ${call.tool} threw: ${failure}`, p.sweep_id);
      break;
    }
  }

  const outcome: ExecutionOutcome = { ok: !failure, results, error: failure ?? undefined };
  if (failure) {
    // failed cards return to the inbox with the error shown
    await transition(proposalId, "failed", { execution_result: JSON.stringify(outcome) });
  } else {
    await transition(proposalId, "executed", { execution_result: JSON.stringify(outcome) });
  }
  return outcome;
}

function toolErrorSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.slice(0, 240);
  } catch {
    // Tool errors are allowed to be plain text.
  }
  return text.trim().slice(0, 240) || "The connector returned an unspecified error";
}
