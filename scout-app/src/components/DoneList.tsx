import { useScout } from "../state/store";
import { actionSummary, CATEGORY_LABEL, statementFor, truncate } from "./Card";
import { timeAgo } from "../App";
import { CheckCircle2, CircleDollarSign, Clock3, History } from "lucide-react";

export default function DoneList() {
  const done = useScout((s) => s.done);
  const sweeps = useScout((s) => s.sweeps);

  const weekAgo = Date.now() - 7 * 86400_000;
  const weekSweeps = sweeps.filter((s) => new Date(s.started_at).getTime() > weekAgo && s.status === "done");
  const weekCost = sweeps
    .filter((s) => new Date(s.started_at).getTime() > weekAgo)
    .reduce((sum, s) => sum + (s.cost_usd || 0), 0);

  return (
    <div className="history-page scroll-thin">
      <div className="history-stats">
        <div className="history-stat history-stat-featured">
          <div className="history-stat-icon"><CheckCircle2 size={18} /></div>
          <div><span>Decisions recorded</span><strong>{done.length}</strong></div>
        </div>
        <div className="history-stat">
          <div className="history-stat-icon"><History size={18} /></div>
          <div><span>Sweeps this week</span><strong>{weekSweeps.length}</strong></div>
        </div>
        <div className="history-stat">
          <div className="history-stat-icon"><CircleDollarSign size={18} /></div>
          <div><span>Cost this week</span><strong>${weekCost.toFixed(2)}</strong></div>
        </div>
      </div>

      {done.length === 0 ? (
        <div className="empty-page-state history-empty">
          <div><Clock3 size={25} /></div>
          <h2>No decisions recorded yet</h2>
          <p>Actions you run, dismiss, or take over will appear here.</p>
        </div>
      ) : (
        <>
          <div className="history-section-heading"><span>Recent decisions</span><small>{done.length} total</small></div>
          <ul className="history-list">
          {done.map((p) => (
            <li key={p.id} className="history-item">
              <div className="history-item-meta">
                <StatusChip status={p.status} />
                <span className="category-chip">
                  {CATEGORY_LABEL[p.category] ?? p.category}
                </span>
                <span className="history-item-time"><Clock3 size={11} /> {p.decided_at ? timeAgo(p.decided_at) : ""}</span>
              </div>
              <div className="history-item-title">{statementFor(p)}</div>
              <div className="history-decision-summary">
                <span>What you did</span>
                <strong>{decisionSentence(p.status)}</strong>
              </div>
              <div className="history-action-summary">
                <span>{p.status === "executed" ? "Scout did" : "Proposed action"}</span>
                <strong>{actionSummary(p)}</strong>
              </div>
              {p.denial_reason && (
                <div className="history-item-note"><span>You said</span> “{p.denial_reason}”</div>
              )}
              {p.execution_result && hasUsefulResult(p.execution_result) && (
                <details className="history-results">
                  <summary>See what happened</summary>
                  <pre className="mono scroll-thin">
                    {pretty(p.execution_result)}
                  </pre>
                </details>
              )}
            </li>
          ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    executed: ["Advanced", "history-status-success"],
    dismissed: ["Not useful", "history-status-danger"],
    handled_by_human: ["I’ll take it", "history-status-brand"],
    expired: ["Expired", "history-status-muted"],
    failed: ["Failed", "history-status-danger"],
  };
  const [label, cls] = map[status] ?? [status, "history-status-muted"];
  return <span className={`history-status ${cls}`}>{label}</span>;
}

function decisionSentence(status: string): string {
  if (status === "executed") return "You chose “Advance.”";
  if (status === "dismissed") return "You chose “Not useful.”";
  if (status === "handled_by_human") return "You chose “I’ll take it from here.”";
  if (status === "failed") return "You chose “Advance,” but the action failed.";
  if (status === "expired") return "No decision was made before this expired.";
  return `This decision is marked ${status.replace(/_/g, " ")}.`;
}

function hasUsefulResult(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { results?: unknown[]; ok?: boolean };
    return !Array.isArray(parsed.results) || parsed.results.length > 0 || parsed.ok === false;
  } catch {
    return Boolean(json.trim());
  }
}

function pretty(json: string): string {
  try {
    return truncate(JSON.stringify(JSON.parse(json), null, 2), 4000);
  } catch {
    return truncate(json, 4000);
  }
}
