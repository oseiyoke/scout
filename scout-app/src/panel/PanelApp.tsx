import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { ArrowUpRight, LoaderCircle, Radar } from "lucide-react";
import { useScout, bindStoreEvents } from "../state/store";
import { getDb } from "../lib/db";
import { timeAgo } from "../App";
import type { ActivityLine } from "../lib/types";
import { useTheme } from "../lib/theme";

const URGENCY_COLOR: Record<string, string> = {
  high: "urgency-high",
  medium: "urgency-medium",
  low: "urgency-low",
};

export default function PanelApp() {
  useTheme();
  const proposals = useScout((s) => s.proposals);
  const lastSweep = useScout((s) => s.lastSweep);
  const refreshAll = useScout((s) => s.refreshAll);
  const [sweeping, setSweeping] = useState(false);
  const [liveLine, setLiveLine] = useState<string | null>(null);

  useEffect(() => {
    let unbind: (() => void) | undefined;
    let unAct: (() => void) | undefined;
    (async () => {
      await getDb();
      await refreshAll();
      unbind = await bindStoreEvents();
      unAct = await listen<ActivityLine>("scout:activity", (e) => {
        setLiveLine(e.payload.line);
        setTimeout(() => setLiveLine(null), 3000);
      });
    })();
    return () => {
      unbind?.();
      unAct?.();
    };
  }, [refreshAll]);

  const top = proposals.filter((p) => p.status === "proposed").slice(0, 3);

  const sweep = async () => {
    setSweeping(true);
    try {
      await invoke("show_main_window");
      await emit("scout:menu", "sweep_now");
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div className="panel-shell">
      <div className="panel-header">
        <div className="brand-radar"><Radar size={16} /></div>
        <div>
          <strong>Scout</strong>
          <span>{top.length ? `${top.length} signal${top.length === 1 ? "" : "s"} waiting` : "All clear"}</span>
        </div>
        <button onClick={() => void invoke("show_main_window")} aria-label="Open Scout"><ArrowUpRight size={15} /></button>
      </div>
      <div className={`panel-status ${sweeping ? "panel-status-live" : ""}`}>
        {sweeping ? <LoaderCircle size={13} className="animate-spin" /> : <span />}
        {sweeping
          ? (liveLine ?? "Checking your sources…")
          : lastSweep
            ? `Checked ${timeAgo(lastSweep.started_at)} · $${lastSweep.cost_usd.toFixed(3)}`
            : "Ready for a first sweep"}
      </div>

      <div className="panel-list scroll-thin">
        {top.length === 0 ? (
          <div className="panel-empty"><Radar size={23} /><strong>Nothing needs you</strong><span>Scout is monitoring quietly.</span></div>
        ) : (
          <ul>
            {top.map((p) => (
              <li key={p.id}>
                <span className={`panel-urgency ${URGENCY_COLOR[p.urgency]}`} />
                <span className="panel-item-title">{p.headline}</span>
                <button onClick={() => void invoke("show_main_window")} className="panel-run-button">Review</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-footer">
        <button
          onClick={() => void invoke("show_main_window")}
        >
          Open decision queue <ArrowUpRight size={12} />
        </button>
        <button
          onClick={() => void sweep()}
          disabled={sweeping}
        >
          {sweeping ? <LoaderCircle size={13} className="animate-spin" /> : <Radar size={13} />}
          {sweeping ? "Sweeping" : "Sweep now"}
        </button>
      </div>
    </div>
  );
}
