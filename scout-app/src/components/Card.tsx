import { motion, type PanInfo } from "framer-motion";
import { ArrowDown, ArrowRight, ArrowUpRight, Bot, CircleX, MessageCircle } from "lucide-react";
import type { PlannedToolCall, Proposal } from "../lib/types";
import { useScout } from "../state/store";

export const CATEGORY_LABEL: Record<string, string> = {
  dropped_commitment: "Dropped commitment",
  needs_reply: "Needs reply",
  schedule_conflict: "Schedule conflict",
  stale_pr: "Stale PR",
  follow_up: "Follow-up",
  fyi: "FYI",
  other: "Other",
};

export function actionSummary(p: Proposal): string {
  const authored = p.recommended_action?.trim();
  if (authored) return truncate(authored, 200);

  const connectors = useScout.getState().connectors;
  const connectorName = (id: string) => connectors.find((c) => c.id === id)?.name;

  if (p.action_kind === "fyi") {
    return "Review the full source and decide whether any follow-up is needed.";
  }
  if (p.action_kind === "draft_only") {
    if (p.category === "needs_reply") return "Review the prepared reply, then send it to close the loop.";
    if (p.category === "schedule_conflict") return "Review and send the prepared message to resolve the scheduling conflict.";
    if (p.category === "stale_pr") return "Send the prepared pull request follow-up and ask for a clear next step.";
    if (p.category === "dropped_commitment") return "Send the prepared commitment update with a specific revised timeline.";
    return "Review and send the prepared follow-up.";
  }
  try {
    const plan = JSON.parse(p.action_plan || "[]") as PlannedToolCall[];
    if (plan.length === 0) return "Prepare this for you to handle";
    if (plan.some((call) => call.tool.startsWith("browser_"))) {
      if (p.category === "needs_reply") return "Read the full conversation, identify what they need from you, and prepare the right response.";
      return "Review the full source, confirm the missing context, and return with a specific next step.";
    }
    const steps = plan.map((c) => humanizeToolCall(c.tool, connectorName(c.connector_id) ?? idFallback(c.connector_id)));
    return steps
      .map((step, index) => index === 0 ? step : lowerFirst(step))
      .join(", then ");
  } catch {
    return "Carry out the proposed action";
  }
}

export function statementFor(p: Proposal): string {
  const [statement] = p.headline.split(/\s+(?:—|–|--)\s+/);
  return statement.trim() || p.headline;
}

function humanizeToolCall(tool: string, connector: string): string {
  const normalized = tool.toLowerCase();
  const destination = connector ? ` in ${connector}` : "";

  if (/(set|update).*(due|date)|(due|date).*(set|update)/.test(normalized)) return `Set a new due date${destination}`;
  if (/(add|create|post).*(comment|note)|(comment|note).*(add|create|post)/.test(normalized)) return `Add a comment${destination}`;
  if (/(send|post).*(message|email|reply)|(message|email|reply).*(send|post)/.test(normalized)) return `Send the prepared message${destination}`;
  if (/create.*(task|issue|ticket)|(task|issue|ticket).*create/.test(normalized)) return `Create the task${destination}`;
  if (/update.*(task|issue|ticket)|(task|issue|ticket).*update/.test(normalized)) return `Update the task${destination}`;
  if (/(schedule|create).*(event|meeting)|(event|meeting).*(schedule|create)/.test(normalized)) return `Schedule the event${destination}`;
  if (/archive|close|resolve/.test(normalized)) return `Close this out${destination}`;

  return `Complete the proposed step${destination}`;
}

function idFallback(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

interface Props {
  proposal: Proposal;
  onDecision: (decision: "approve" | "dismiss" | "takeover") => void;
  onNavigate: (direction: "next" | "previous") => void;
  onExpand: (focusChat?: boolean) => void;
}

export default function Card({ proposal: p, onDecision, onNavigate, onExpand }: Props) {
  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const THRESHOLD = 75;
    if (info.offset.x < -THRESHOLD) onNavigate("next");
    else if (info.offset.x > THRESHOLD) onNavigate("previous");
  };

  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.32}
      onDragEnd={handleDragEnd}
      initial={{ opacity: 0, x: 18, scale: .99 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      whileDrag={{ scale: 1.01, cursor: "grabbing" }}
      exit={{ opacity: 0, x: -18, transition: { duration: 0.13 } }}
      className="proposal-card cursor-grab"
    >
      <h2 className="proposal-headline">{statementFor(p)}</h2>

      {p.status === "failed" && (
        <div className="proposal-error">
          The last attempt failed. Open details for the error, or run it again.
        </div>
      )}

      <div className="agent-recommendation">
        <div className="agent-recommendation-mark"><Bot size={16} /></div>
        <div>
          <div className="agent-recommendation-label">Scout recommends</div>
          <div className="proposed-action-copy">{actionSummary(p)}</div>
        </div>
      </div>

      {p.action_kind === "tool_call" && <ActionPlan plan={p.action_plan} />}

      <button className="go-deeper-button" onClick={() => onExpand(false)} aria-keyshortcuts="ArrowDown" title="Go deeper (↓)">
        <ArrowDown size={15} /> Go deeper
      </button>

      <div className="proposal-actions" onClick={(event) => event.stopPropagation()}>
        <button className="proposal-action proposal-action-reject" onClick={() => onDecision("dismiss")}>
          <CircleX size={16} /><span>Not useful</span><kbd>D</kbd>
        </button>
        <button className="proposal-action proposal-action-takeover" onClick={() => onDecision("takeover")}>
          <ArrowUpRight size={16} /><span>I’ll take it</span><kbd>M</kbd>
        </button>
        <button className="proposal-action proposal-action-comment" onClick={() => onExpand(true)}>
          <MessageCircle size={16} /><span>Comment</span><kbd>C</kbd>
        </button>
        <button className="proposal-action proposal-action-primary" onClick={() => onDecision("approve")}>
          <span>Advance</span><kbd>A</kbd><ArrowRight size={16} />
        </button>
      </div>
    </motion.div>
  );
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function ActionPlan({ plan }: { plan: string }) {
  const calls = safePlan(plan);
  if (!calls.length) return null;
  return (
    <details className="evidence-detail" open>
      <summary>Exact actions requiring approval</summary>
      {calls.map((call, index) => (
        <div className="approval-plan-step" key={`${call.connector_id}:${call.tool}:${index}`}>
          <code>{call.connector_id} :: {call.tool}</code>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
        </div>
      ))}
    </details>
  );
}

function safePlan(plan: string): PlannedToolCall[] {
  try {
    const value = JSON.parse(plan);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
