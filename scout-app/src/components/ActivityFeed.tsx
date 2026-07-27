import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowDown, BrainCircuit, ChevronDown, Radio, Radar } from "lucide-react";
import { useScout, useThinking, llmCallsForSweep } from "../state/store";
import { timeAgo } from "../App";
import type { LlmCall, Sweep } from "../lib/types";

export default function ActivityFeed({ activeSweepId, starting = false }: { activeSweepId?: string | null; starting?: boolean }) {
  const sweeps = useScout((s) => s.sweeps);
  const activity = useScout((s) => s.activity);
  const [focus, setFocus] = useState<{ sweepId: string; dedupeKey?: string } | null>(null);
  const [expandedSweepId, setExpandedSweepId] = useState<string | null>(() => activeSweepId ?? sweeps.find((sweep) => sweep.status === "running")?.id ?? sweeps[0]?.id ?? null);

  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    listen<{ tab: string; sweepId: string; dedupeKey?: string }>("scout:navigate", (e) => {
      if (e.payload.tab === "activity") {
        setFocus({ sweepId: e.payload.sweepId, dedupeKey: e.payload.dedupeKey });
        setExpandedSweepId(e.payload.sweepId);
      }
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  useEffect(() => {
    const running = activeSweepId ?? sweeps.find((sweep) => sweep.status === "running")?.id;
    if (running) setExpandedSweepId(running);
  }, [activeSweepId, sweeps]);

  if (sweeps.length === 0 && !starting && !activeSweepId) {
    return (
      <div className="empty-page-state">
        <div><Radar size={25} /></div>
        <h2>No sweep activity yet</h2>
        <p>Run a sweep to see what Scout checked, considered, and proposed.</p>
      </div>
    );
  }

  return (
    <div className="activity-page scroll-thin">
      {(starting || (activeSweepId && !sweeps.some((sweep) => sweep.id === activeSweepId))) && (
        <div className="live-sweep-opening">
          <Radio size={16} />
          <div><strong>Opening live sweep</strong><span>Waiting for the first activity…</span></div>
        </div>
      )}
      <div className="activity-list-heading"><strong>{activeSweepId ? "Current stream" : "Recent sweeps"}</strong><span>{sweeps.length}</span></div>
      {sweeps.map((s) => (
        <SweepGroup
          key={s.id}
          sweep={s}
          lines={activity.filter((a) => a.sweep_id === s.id).reverse()}
          expanded={activeSweepId === s.id || expandedSweepId === s.id}
          active={activeSweepId === s.id}
          onToggle={() => {
            if (activeSweepId === s.id) return;
            setExpandedSweepId((current) => current === s.id ? null : s.id);
          }}
          highlight={focus?.sweepId === s.id ? focus?.dedupeKey : undefined}
        />
      ))}
    </div>
  );
}

function SweepGroup({
  sweep,
  lines,
  expanded,
  active,
  onToggle,
  highlight,
}: {
  sweep: Sweep;
  lines: { id: number; at: string; line: string }[];
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  highlight?: string;
}) {
  return (
    <div className={`sweep-group ${expanded ? "sweep-group-expanded" : ""} ${active ? "sweep-group-live" : ""}`}>
      <button className="sweep-group-header" onClick={onToggle} aria-expanded={expanded}>
        <StatusDot status={sweep.status} />
        <span className="sweep-time">{timeAgo(sweep.started_at)}</span>
        <span className="sweep-result">
          {sweep.status === "running"
            ? "sweeping now…"
            : sweep.status === "error"
              ? `failed — ${sweep.error ?? ""}`
              : `${sweep.proposal_count} proposal${sweep.proposal_count === 1 ? "" : "s"}`}
        </span>
        <span className="sweep-metrics">
          ${sweep.cost_usd.toFixed(3)} · {fmtTokens(sweep.input_tokens)} in ({fmtTokens(sweep.cached_tokens)} cached) ·{" "}
          {fmtTokens(sweep.output_tokens)} out
        </span>
        <ChevronDown className="sweep-expand-icon" size={16} />
      </button>
      {expanded && (
        <div className="sweep-expanded-content">
          <ThinkingPane sweep={sweep} highlight={highlight} />
          {lines.length > 0 && (
            <div className="tool-activity">
              <div className="tool-activity-heading">
                <span>Tool activity</span>
                <small>{lines.length} event{lines.length === 1 ? "" : "s"}</small>
              </div>
              <ul className="sweep-lines">
                {lines.map((line) => <li key={line.id}>{line.line}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingPane({ sweep, highlight }: { sweep: Sweep; highlight?: string }) {
  const live = useThinking((s) => s.live[sweep.id]);
  const [calls, setCalls] = useState<LlmCall[]>([]);
  const [following, setFollowing] = useState(true);
  const paneRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useEffect(() => {
    void llmCallsForSweep(sweep.id).then(setCalls);
  }, [sweep.id, live === undefined]);

  const persisted = calls
    .filter((c) => c.reasoning_content)
    .map((c) => [
      `── ${purposeLabel(c.purpose)} ──`,
      c.reasoning_content || null,
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  const text = live !== undefined ? live : persisted;

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [text]);

  const jumpToLatest = () => {
    followingRef.current = true;
    setFollowing(true);
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  };

  return (
    <section className="thinking-stream">
      <div className="reasoning-stream-heading">
        {sweep.status === "running" ? <Radio size={14} /> : <BrainCircuit size={14} />}
        <span>{sweep.status === "running" ? "Thinking live" : "Thinking"}</span>
        {!following && (
          <button type="button" onClick={jumpToLatest} className="jump-to-latest">
            <ArrowDown size={12} /> Jump to latest
          </button>
        )}
        {sweep.status === "running" && following && <i>Following</i>}
      </div>
      <div
        ref={paneRef}
        className="thinking-pane mono scroll-thin"
        aria-label="Scout thinking stream"
        onScroll={() => {
          const pane = paneRef.current;
          if (!pane) return;
          const next = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
          followingRef.current = next;
          setFollowing(next);
        }}
      >
        {text ? (
          highlight ? <Highlight text={text} needle={highlight} /> : text
        ) : (
          <span className="italic">{sweep.status === "running" ? "Waiting for the first thinking tokens…" : "This run did not record a thinking stream."}</span>
        )}
      </div>
    </section>
  );
}

function purposeLabel(purpose: LlmCall["purpose"]): string {
  if (purpose === "sweep_planner") return "Planning the sweep";
  if (purpose === "sweep_judgment") return "Judging the evidence";
  return purpose.replace(/_/g, " ");
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const i = text.indexOf(needle);
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{needle}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`sweep-status-dot sweep-status-${status}`} />;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
