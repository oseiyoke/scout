import { useState } from "react";
import { Archive, CheckCircle2, History, InboxIcon, Moon, Radar, Settings } from "lucide-react";
import Card from "./components/Card";
import CardExpanded from "./components/CardExpanded";
import type { Proposal } from "./lib/types";
import { useScout } from "./state/store";

const proposal: Proposal = {
  id: "showcase-proposal",
  sweep_id: "showcase-sweep",
  created_at: "2026-07-27T10:00:00.000Z",
  status: "proposed",
  category: "dropped_commitment",
  urgency: "high",
  confidence: 0.94,
  headline: "You promised a project update today, but the task is still waiting on you.",
  observation: "The project thread asks for a revised delivery date before the afternoon planning call. The task has no owner update yet.",
  recommended_action: "Move the task to Friday and post a concise update explaining the revised timeline.",
  evidence: JSON.stringify([
    {
      source: "Project workspace",
      connector_id: "projects",
      ref: "Launch checklist · Today",
      quote: "Can you confirm the revised date before our planning call this afternoon?",
    },
    {
      source: "Team messages",
      connector_id: "messages",
      ref: "#launch · 10:18",
      quote: "I’ll update the task and share the new timeline today.",
    },
  ]),
  action_kind: "tool_call",
  action_plan: JSON.stringify([
    { connector_id: "projects", tool: "task_update_due_date", args: { task_id: "LAUNCH-42", due_date: "2026-07-31" } },
    { connector_id: "messages", tool: "message_post", args: { channel: "launch", text: "The delivery date is now Friday. I’ll share a progress update after tomorrow’s review." } },
  ]),
  approved_action_plan: null,
  draft: "The delivery date is now Friday. I’ll share a progress update after tomorrow’s review.",
  dedupe_key: "launch-timeline-update",
  decided_at: null,
  denial_reason: null,
  execution_result: null,
};

useScout.setState({
  proposals: [proposal],
  connectors: [
    { id: "projects", name: "Projects", url: "https://example.com/mcp", catalog_id: null, auth_type: "oauth", enabled: 1, status: "connected", last_error: null, tool_count: 8, last_connected_at: proposal.created_at, created_at: proposal.created_at },
    { id: "messages", name: "Messages", url: "https://example.com/mcp", catalog_id: null, auth_type: "oauth", enabled: 1, status: "connected", last_error: null, tool_count: 6, last_connected_at: proposal.created_at, created_at: proposal.created_at },
  ],
});

export default function Showcase() {
  const [expanded, setExpanded] = useState(new URLSearchParams(location.search).get("view") === "detail");
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand"><div className="brand-radar"><Radar size={18} /></div><div><div className="app-brand-name">Scout</div><div className="app-brand-tagline">Your signal desk</div></div></div>
        <nav className="app-nav" aria-label="Primary navigation">
          <div className="app-nav-label">Workspace</div>
          <button className="app-nav-item app-nav-item-active"><InboxIcon size={17} /><span>Decision queue</span><span className="nav-count">3</span></button>
          <button className="app-nav-item"><History size={17} /><span>Activity</span></button>
          <button className="app-nav-item"><Archive size={17} /><span>History</span></button>
        </nav>
        <div className="sweep-status-card"><div className="sweep-status-icon"><CheckCircle2 size={15} /></div><div><div className="sweep-status-title">Monitoring quietly</div><div className="sweep-status-copy">Last checked 8 min ago</div></div></div>
        <div className="app-sidebar-footer"><button className="sidebar-utility-button"><Moon size={16} /><span>Dark mode</span></button><button className="sidebar-utility-button"><Settings size={16} /><span>Settings</span></button></div>
      </aside>
      <section className="app-workspace">
        <header className="workspace-header"><div><h1>Decision queue</h1><p>3 decisions waiting for you</p></div><div className="workspace-actions"><span className="sweep-cost">$0.041 last sweep</span><button className="sweep-button"><Radar size={16} />Sweep now</button></div></header>
        <main className="workspace-main">
          <div className="inbox-view"><div className="decision-stage"><div className="decision-stage-heading"><span className="decision-position">Decision 1 of 3</span></div><div className="proposal-deck"><Card proposal={proposal} onDecision={() => {}} onNavigate={() => {}} onExpand={() => setExpanded(true)} /></div></div></div>
        </main>
      </section>
      {expanded && <CardExpanded proposal={proposal} onClose={() => setExpanded(false)} onRun={() => {}} onDismiss={() => {}} onDismissWithReason={() => {}} onTakeover={() => {}} />}
    </div>
  );
}
