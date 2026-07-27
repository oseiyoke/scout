import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  ArrowRight,
  CheckCircle2,
  History,
  InboxIcon,
  LoaderCircle,
  Moon,
  Radar,
  Settings,
  Sun,
} from "lucide-react";
import { useScout, bindStoreEvents, bindThinkingEvents } from "./state/store";
import { startScheduler, sweepNow, isSweepRunning } from "./lib/sweep";
import { connectEnabled } from "./lib/connectors";
import { getDb } from "./lib/db";
import Inbox from "./components/Inbox";
import ActivityFeed from "./components/ActivityFeed";
import DoneList from "./components/DoneList";
import SettingsView from "./components/SettingsView";
import type { ActivityLine } from "./lib/types";
import { useTheme } from "./lib/theme";

type Tab = "inbox" | "activity" | "done";

export default function App() {
  const [tab, setTab] = useState<Tab>("inbox");
  const [showSettings, setShowSettings] = useState(false);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [liveLine, setLiveLine] = useState<string | null>(null);
  const proposals = useScout((s) => s.proposals);
  const lastSweep = useScout((s) => s.lastSweep);
  const activeSweepId = useScout((s) => s.activeSweepId);
  const refreshAll = useScout((s) => s.refreshAll);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    let unbind: (() => void) | undefined;
    let unbindThinking: (() => void) | undefined;
    (async () => {
      // Breadcrumb so a boot failure names the step that died, not just the error.
      let step = "getDb";
      try {
        await getDb();
        if (cancelled) return;
        step = "refreshAll";
        await refreshAll();
        if (cancelled) return;
        step = "bindStoreEvents";
        const stopStoreEvents = await bindStoreEvents();
        if (cancelled) {
          stopStoreEvents();
          return;
        }
        unbind = stopStoreEvents;
        step = "bindThinkingEvents";
        const stopThinkingEvents = await bindThinkingEvents();
        if (cancelled) {
          stopThinkingEvents();
          return;
        }
        unbindThinking = stopThinkingEvents;
        step = "connectEnabled";
        await connectEnabled();
        if (cancelled) return;
        step = "refreshConnectors";
        await useScout.getState().refreshConnectors();
        if (cancelled) return;
        // The scheduler runs in the main window only.
        if (getCurrentWindow().label === "main") {
          step = "startScheduler";
          await startScheduler();
        }
        const open = useScout.getState().proposals.filter((p) => p.status === "proposed").length;
        try {
          await invoke("set_tray_badge", { count: open });
        } catch {
          /* no tray in dev browser */
        }
        setBooted(true);
      } catch (e) {
        const msg = `${step}: ${e instanceof Error ? e.message : String(e)}`;
        console.error("Scout boot failed —", msg, e);
        setBootError(msg);
      }
    })();
    return () => {
      cancelled = true;
      unbind?.();
      unbindThinking?.();
    };
  }, [refreshAll]);

  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    let unMenu: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<ActivityLine>("scout:activity", (e) => {
        setLiveLine(e.payload.line);
        setTimeout(() => setLiveLine(null), 4000);
      }).then((u) => {
        if (cancelled) u();
        else un = u;
      });
      listen<string>("scout:menu", (e) => {
        if (e.payload === "sweep_now") void onSweepNowRef.current();
        if (e.payload === "pause_1h") {
          import("./lib/sweep").then((m) => m.pauseScheduler(60));
          setLiveLine("Paused for 1 hour");
          setTimeout(() => setLiveLine(null), 3000);
        }
      }).then((u) => {
        if (cancelled) u();
        else unMenu = u;
      });
    });
    return () => {
      cancelled = true;
      un?.();
      unMenu?.();
    };
  }, []);

  const openCount = proposals.filter((p) => p.status === "proposed").length;

  const onSweepNow = async () => {
    setTab("activity");
    setShowSettings(false);
    if (activeSweepId || isSweepRunning()) return;
    setSweeping(true);
    try {
      await sweepNow();
    } finally {
      setSweeping(false);
    }
  };
  const onSweepNowRef = useRef(onSweepNow);
  onSweepNowRef.current = onSweepNow;

  const sweepActive = sweeping || !!activeSweepId || isSweepRunning();

  if (!booted) {
    return (
      <div className="boot-screen">
        <div className="brand-radar brand-radar-large" aria-hidden="true"><Radar size={23} /></div>
        {bootError ? (
          <>
            <div className="text-base font-semibold text-[var(--danger)]">Scout couldn’t start</div>
            <div className="max-w-lg text-center text-sm text-[var(--text-muted)]">{bootError}</div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-base text-[var(--text-muted)]">
            <LoaderCircle size={15} className="animate-spin" /> Preparing your signal desk…
          </div>
        )}
      </div>
    );
  }

  const page = showSettings
    ? { title: "Settings", description: "Connections, judgment, and automation" }
    : tab === "inbox"
      ? { title: "Decision queue", description: openCount ? `${openCount} decision${openCount === 1 ? "" : "s"} waiting for you` : "Nothing needs your attention" }
      : tab === "activity"
        ? { title: "Sweep activity", description: "See what Scout checked and why" }
        : { title: "Decision history", description: "What you decided, and what happened next" };

  const navItems: { id: Tab; label: string; icon: typeof InboxIcon }[] = [
    { id: "inbox", label: "Decision queue", icon: InboxIcon },
    { id: "activity", label: "Activity", icon: History },
    { id: "done", label: "History", icon: Archive },
  ];

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="brand-radar" aria-hidden="true"><Radar size={18} /></div>
          <div className="min-w-0">
            <div className="app-brand-name">Scout</div>
            <div className="app-brand-tagline">Your signal desk</div>
          </div>
        </div>

        <nav className="app-nav" aria-label="Primary navigation">
          <div className="app-nav-label">Workspace</div>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { setTab(id); setShowSettings(false); }}
              className={`app-nav-item ${tab === id && !showSettings ? "app-nav-item-active" : ""}`}
              aria-label={id === "inbox" && openCount > 0 ? `${label}, ${openCount} waiting` : label}
            >
              <Icon size={17} strokeWidth={1.9} />
              <span>{label}</span>
              {id === "inbox" && openCount > 0 && <span className="nav-count">{openCount}</span>}
            </button>
          ))}
        </nav>

        <button
          type="button"
          onClick={() => { setTab("activity"); setShowSettings(false); }}
          className={`sweep-status-card ${sweepActive ? "sweep-status-card-live" : ""}`}
          aria-label={sweepActive ? "View live sweep" : "View sweep activity"}
        >
          <div className="sweep-status-icon">
            {sweepActive ? <LoaderCircle size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
          </div>
          <div className="min-w-0">
            <div className="sweep-status-title">{sweepActive ? "Sweep in progress" : "Monitoring quietly"}</div>
            <div className="sweep-status-copy">
              {sweepActive
                ? (liveLine ?? "Checking your sources…")
                : lastSweep
                  ? `Last checked ${timeAgo(lastSweep.started_at)}`
                  : "Ready for a first sweep"}
            </div>
          </div>
        </button>

        <div className="app-sidebar-footer">
          <button
            onClick={toggleTheme}
            className="sidebar-utility-button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className={`sidebar-utility-button ${showSettings ? "sidebar-utility-button-active" : ""}`}
            aria-label="Settings"
          >
            <Settings size={16} /><span>Settings</span>
          </button>
        </div>
      </aside>

      <section className="app-workspace">
        <header className="workspace-header">
          <div>
            <h1>{page.title}</h1>
            <p>{page.description}</p>
          </div>
          <div className="workspace-actions">
            {lastSweep && !sweepActive && (
              <span className="sweep-cost">${lastSweep.cost_usd.toFixed(3)} last sweep</span>
            )}
            <button onClick={onSweepNow} className="sweep-button">
              {sweepActive ? <LoaderCircle size={16} className="animate-spin" /> : <Radar size={16} />}
              {sweepActive ? "View live sweep" : "Sweep now"}
              <ArrowRight size={14} />
            </button>
          </div>
        </header>
        <main className="workspace-main">
        {showSettings ? (
          <SettingsView onClose={() => setShowSettings(false)} />
        ) : tab === "inbox" ? (
          <Inbox onSweepNow={onSweepNow} sweeping={sweeping} />
        ) : tab === "activity" ? (
          <ActivityFeed activeSweepId={activeSweepId} starting={sweeping} />
        ) : (
          <DoneList />
        )}
        </main>
      </section>
      {liveLine && (
        <div className="live-toast">
          <span className="live-toast-dot" /> {liveLine}
        </div>
      )}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
