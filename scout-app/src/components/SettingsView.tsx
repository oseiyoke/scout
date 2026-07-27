import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Chrome,
  CircleAlert,
  Copy,
  Link2,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Moon,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { connectorManager } from "../lib/connectors";
import {
  CONNECTOR_CATALOG,
  catalogConnector,
  type CatalogConnector,
} from "../lib/connectorCatalog";
import { getDb, nowIso, uuid } from "../lib/db";
import { clearOAuthSession, OAUTH_CALLBACK_URL } from "../lib/oauth";
import {
  deleteConnectorAuth,
  deleteConnectorHeaders,
  getApiKey,
  getConnectorAuth,
  redactSecrets,
  setApiKey,
  setConnectorAuth,
} from "../lib/secrets";
import { setSetting } from "../lib/settings";
import { startScheduler, stopScheduler } from "../lib/sweep";
import { listProviderModels, testConnection, type ProviderModel } from "../lib/llm";
import { PROVIDERS } from "../lib/constants";
import { useScout } from "../state/store";
import type { Connector, Settings } from "../lib/types";
import { ProviderLogo } from "./ProviderLogo";
import { isAllowedMcpUrl } from "../lib/mcpUrl";
import { useTheme } from "../lib/theme";
import { clearScoutData, exportScoutData, type ClearDataTarget } from "../lib/dataManagement";
import {
  CHROME_CONNECTOR_CATALOG_ID,
  CHROME_CONNECTOR_URL,
  normalizeAllowedDomains,
  openChromeSetup,
} from "../lib/browser";

type SettingsPage = "connections" | "model" | "automation" | "profile" | "desktop" | "data";

const NAV_ITEMS = [
  { id: "connections" as const, label: "Connections", icon: Link2 },
  { id: "model" as const, label: "Model", icon: Bot },
  { id: "automation" as const, label: "Automation", icon: Radar },
  { id: "profile" as const, label: "About you", icon: UserRound },
  { id: "desktop" as const, label: "Desktop", icon: Monitor },
  { id: "data" as const, label: "Data", icon: Trash2 },
];

export default function SettingsView({ onClose }: { onClose: () => void }) {
  const settings = useScout((state) => state.settings);
  const refreshSettings = useScout((state) => state.refreshSettings);
  const [page, setPage] = useState<SettingsPage>("connections");
  const { theme, toggleTheme } = useTheme();
  if (!settings) return null;

  return (
    <div className="settings-shell fixed inset-0 z-[60] h-full bg-[var(--canvas-raised)] text-[var(--text)]">
      <aside className="settings-sidebar">
        <div className="flex items-center gap-2.5 px-3 pb-7 pt-2">
          <div className="brand-radar h-8 w-8 flex-[0_0_32px] rounded-xl">
            <Radar size={16} strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-base font-semibold tracking-[-0.01em]">Scout</div>
            <div className="text-[13px] text-[#8792a5]">Settings</div>
          </div>
        </div>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setPage(item.id)}
                className={`settings-nav-item ${page === item.id ? "settings-nav-item-active" : ""}`}
                aria-label={item.label}
              >
                <Icon size={15} />
                <span>{item.label}</span>
                {item.id === "connections" && <ConnectionCount />}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-3 pb-2 text-[12px] font-medium tracking-[0.12em] text-[#a4adbb] uppercase">
          Scout 0.1.0
        </div>
      </aside>

      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--canvas-raised)_90%,transparent)] px-7 backdrop-blur-xl">
          <button onClick={onClose} className="settings-back-button" aria-label="Back to Scout">
            <ArrowLeft size={17} />
            <span>Back</span>
          </button>
          <button onClick={toggleTheme} className="icon-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <div className="mx-auto max-w-[980px] px-7 pb-20 pt-8">
          {page === "connections" && <ConnectionsPage />}
          {page === "model" && <ModelPage settings={settings} onSaved={refreshSettings} />}
          {page === "automation" && <AutomationPage settings={settings} onSaved={refreshSettings} />}
          {page === "profile" && <ProfilePage settings={settings} onSaved={refreshSettings} />}
          {page === "desktop" && <DesktopPage settings={settings} onSaved={refreshSettings} />}
          {page === "data" && <DataPage />}
        </div>
      </main>
    </div>
  );
}

const DATA_ACTIONS: { target: ClearDataTarget; title: string; description: string; button: string }[] = [
  {
    target: "decisions",
    title: "Delete decisions",
    description: "Clears handled decision history and its learned feedback. Keeps the current queue.",
    button: "Delete decisions",
  },
  {
    target: "proposals",
    title: "Delete proposals",
    description: "Clears the current queue, decision history, and learned dismissal feedback.",
    button: "Delete proposals",
  },
  {
    target: "runs",
    title: "Delete runs",
    description: "Clears sweep runs, activity, and model-call logs. Keeps proposals.",
    button: "Delete runs",
  },
  {
    target: "test_data",
    title: "Delete activity history",
    description: "Clears proposals, decisions, runs, activity, and learned feedback. Keeps connections and settings.",
    button: "Delete history",
  },
  {
    target: "all",
    title: "Delete all Scout data",
    description: "Deletes history, settings, connections, API keys, tokens, and connector headers from this device.",
    button: "Delete everything",
  },
];

function DataPage() {
  const refreshAll = useScout((state) => state.refreshAll);
  const activeSweepId = useScout((state) => state.activeSweepId);
  const [pending, setPending] = useState<ClearDataTarget | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const action = DATA_ACTIONS.find((item) => item.target === pending);

  const clear = async () => {
    if (!pending || working || activeSweepId) return;
    setWorking(true);
    setNotice(null);
    try {
      await clearScoutData(pending);
      await refreshAll();
      setNotice({ kind: "success", text: `${action?.title ?? "Data"} deleted.` });
      setPending(null);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <PageHeading eyebrow="Privacy" title="Data" description="Export or delete the information Scout keeps on this device." />
      <button className="secondary-button" onClick={async () => { await navigator.clipboard.writeText(await exportScoutData()); setNotice({ kind: "success", text: "Data export copied to the clipboard." }); }}><Copy size={14} /> Copy data export</button>
      {notice && (
        <div className={`notice-banner ${notice.kind === "error" ? "notice-banner-error" : ""}`}>
          {notice.kind === "error" ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{notice.text}</span>
        </div>
      )}
      {activeSweepId && (
        <div className="notice-banner notice-banner-error">
          <CircleAlert size={15} /> Wait for the current sweep to finish before deleting test data.
        </div>
      )}
      <div className="data-action-list">
        {DATA_ACTIONS.map((item) => (
          <div key={item.target} className={`data-action-row ${item.target === "all" ? "data-action-row-nuke" : ""}`}>
            <div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
            </div>
            <button
              onClick={() => setPending(item.target)}
              disabled={!!activeSweepId || working}
              className="danger-outline-button"
            >
              {item.button}
            </button>
          </div>
        ))}
      </div>

      {action && (
        <div className="modal-backdrop" onClick={() => !working && setPending(null)}>
          <div className="data-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="data-confirm-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="data-confirm-title">{action.title}?</h2>
            <p>This cannot be undone.</p>
            <div>
              <button onClick={() => setPending(null)} disabled={working} className="secondary-button">Cancel</button>
              <button onClick={() => void clear()} disabled={working} className="danger-solid-button">
                {working ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {working ? "Deleting…" : action.button}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ConnectionCount() {
  const connectors = useScout((state) => state.connectors);
  const count = connectors.filter((connector) => connector.status === "connected").length;
  return count ? <span className="ml-auto rounded-full bg-[var(--brand-soft)] px-1.5 text-[12px] text-[var(--brand)]">{count}</span> : null;
}

// ── Connections ─────────────────────────────────────────────────────────────

interface ConnectorDraft {
  id?: string;
  catalogId?: string;
  name: string;
  url: string;
  authType: Connector["auth_type"];
  clientId: string;
  clientSecret: string;
  bearerToken: string;
  headerName: string;
  headerValue: string;
  setupUrl?: string;
  setupNote?: string;
  authOptions?: CatalogConnector["authOptions"];
}

function ConnectionsPage() {
  const connectors = useScout((state) => state.connectors);
  const refresh = useScout((state) => state.refreshConnectors);
  const settings = useScout((state) => state.settings);
  const refreshSettings = useScout((state) => state.refreshSettings);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [draft, setDraft] = useState<ConnectorDraft | null>(null);
  const [showChromeSettings, setShowChromeSettings] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const chromeConnector = connectors.find((connector) => connector.catalog_id === CHROME_CONNECTOR_CATALOG_ID);
  const serviceConnectors = connectors.filter((connector) => connector.catalog_id !== CHROME_CONNECTOR_CATALOG_ID);
  const connected = serviceConnectors.filter((connector) => connector.status === "connected");

  const catalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CONNECTOR_CATALOG.filter((item) => {
      const matchesCategory = category === "All" || item.category === category;
      const matchesQuery = !needle || `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(needle);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  const connectorForCatalog = (item: CatalogConnector) => connectors.find((connector) => connector.catalog_id === item.id);

  const connect = async (connector: Connector) => {
    const catalogItem = catalogConnector(connector.catalog_id);
    const supportedAuth = catalogItem?.authOptions ?? (catalogItem ? [catalogItem.authType] : undefined);
    if (supportedAuth && !supportedAuth.includes(connector.auth_type as CatalogConnector["authType"])) {
      setDraft(await draftFromConnector(connector, catalogItem));
      return;
    }
    setWorking(connector.id);
    setNotice(null);
    const db = await getDb();
    try {
      await connectorManager.disconnect(connector.id);
      const tools = await connectorManager.connect(connector, true);
      const connectedAt = nowIso();
      await db.execute(
        "UPDATE connectors SET enabled=1,status='connected',last_error=NULL,tool_count=$1,last_connected_at=$2 WHERE id=$3;",
        [tools.length, connectedAt, connector.id],
      );
      setNotice({ kind: "success", text: `${connector.name} connected · ${tools.length} tools ready` });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      if (message === "Sign-in cancelled.") {
        await db.execute("UPDATE connectors SET status='disconnected',last_error=NULL WHERE id=$1;", [connector.id]);
      } else {
        await db.execute("UPDATE connectors SET status='error',last_error=$1 WHERE id=$2;", [message, connector.id]);
        setNotice({ kind: "error", text: message });
      }
    } finally {
      setWorking(null);
      await refresh();
    }
  };

  const cancelConnect = async (connector: Connector) => {
    await invoke("cancel_oauth_callback", { connectorId: connector.id }).catch(() => {});
  };

  const addCatalog = async (item: CatalogConnector) => {
    const existing = connectorForCatalog(item);
    if (existing) {
      if (existing.status === "connected" || item.authType !== "oauth") {
        setDraft(await draftFromConnector(existing, item));
      } else {
        await connect(existing);
      }
      return;
    }
    if (item.preview && item.setupNote) {
      setDraft(draftFromCatalog(item));
      return;
    }
    if (item.authType !== "oauth") {
      setDraft(draftFromCatalog(item));
      return;
    }
    const connector = await insertConnector({
      catalogId: item.id,
      name: item.name,
      url: item.url,
      authType: item.authType,
    });
    await refresh();
    await connect(connector);
  };

  const toggle = async (connector: Connector) => {
    if (!connector.enabled || connector.status !== "connected") {
      await connect(connector);
      return;
    }
    const db = await getDb();
    await connectorManager.disconnect(connector.id);
    await db.execute("UPDATE connectors SET enabled=0,status='disconnected' WHERE id=$1;", [connector.id]);
    await refresh();
  };

  const remove = async (connector: Connector) => {
    const db = await getDb();
    await connectorManager.disconnect(connector.id);
    await Promise.all([deleteConnectorAuth(connector.id), deleteConnectorHeaders(connector.id)]);
    await db.execute("DELETE FROM connectors WHERE id=$1;", [connector.id]);
    setDraft(null);
    await refresh();
  };

  const disconnect = async (connector: Connector) => {
    const db = await getDb();
    await connectorManager.disconnect(connector.id);
    await clearOAuthSession(connector.id);
    await db.execute("UPDATE connectors SET enabled=0,status='disconnected',tool_count=0 WHERE id=$1;", [connector.id]);
    setDraft(null);
    await refresh();
    setNotice({ kind: "success", text: `${connector.name} disconnected` });
  };

  const saveDraft = async () => {
    if (!draft || !draft.name.trim() || !isAllowedMcpUrl(draft.url)) return;
    setWorking(draft.id ?? "new");
    let connector: Connector;
    if (draft.id) {
      const db = await getDb();
      await db.execute("UPDATE connectors SET name=$1,url=$2,auth_type=$3 WHERE id=$4;", [
        draft.name.trim(), draft.url.trim(), draft.authType, draft.id,
      ]);
      connector = { ...connectors.find((item) => item.id === draft.id)!, name: draft.name, url: draft.url, auth_type: draft.authType };
    } else {
      connector = await insertConnector({
        catalogId: draft.catalogId,
        name: draft.name.trim(),
        url: draft.url.trim(),
        authType: draft.authType,
      });
    }
    await setConnectorAuth(connector.id, {
      clientId: draft.clientId.trim() || undefined,
      clientSecret: draft.clientSecret.trim() || undefined,
      bearerToken: draft.bearerToken.trim() || undefined,
      headers: draft.headerName.trim() ? { [draft.headerName.trim()]: draft.headerValue } : undefined,
    });
    setDraft(null);
    await refresh();
    await connect(connector);
  };

  const connectChrome = async () => {
    let connector = chromeConnector;
    if (!connector) {
      connector = await insertConnector({
        catalogId: CHROME_CONNECTOR_CATALOG_ID,
        name: "Chrome browser",
        url: CHROME_CONNECTOR_URL,
        authType: "local",
      });
      await refresh();
    }
    await connect(connector);
  };

  const disconnectChrome = async () => {
    if (!chromeConnector) return;
    await connectorManager.disconnect(chromeConnector.id);
    const db = await getDb();
    await db.execute(
      "UPDATE connectors SET enabled=0,status='disconnected',tool_count=0,last_error=NULL WHERE id=$1;",
      [chromeConnector.id],
    );
    await refresh();
    setNotice({ kind: "success", text: "Chrome disconnected" });
  };

  const saveBrowserSetting = async (key: string, value: unknown) => {
    await setSetting(key, value);
    await refreshSettings();
    if (chromeConnector && connectorManager.isConnected(chromeConnector.id)) {
      const tools = await connectorManager.refreshTools(chromeConnector.id);
      const db = await getDb();
      await db.execute("UPDATE connectors SET tool_count=$1 WHERE id=$2;", [tools.length, chromeConnector.id]);
      await refresh();
    }
  };

  return (
    <>
      <PageHeading
        eyebrow="Workspace access"
        title="Connections"
        description=""
        action={
          <button onClick={() => setDraft(blankDraft())} disabled={working !== null} className="primary-button">
            <Plus size={15} /> Add custom
          </button>
        }
      />

      {notice && (
        <div className={`notice-banner ${notice.kind === "error" ? "notice-banner-error" : ""}`}>
          {notice.kind === "error" ? <CircleAlert size={15} /> : <Check size={15} />}
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="ml-auto"><X size={14} /></button>
        </div>
      )}

      <section className="mb-9">
        <div className="section-heading-row">
          <div>
            <h2 className="section-title">Your connections</h2>
            <p className="section-subtitle">{connected.length + (chromeConnector?.status === "connected" ? 1 : 0)} active</p>
          </div>
        </div>
        <div className="connection-list">
          {settings && (
            <ChromeConnectionRow
              connector={chromeConnector}
              settings={settings}
              working={working === chromeConnector?.id || working === "chrome-new"}
              busy={working !== null && working !== chromeConnector?.id && working !== "chrome-new"}
              onConnect={() => void connectChrome()}
              onManage={() => setShowChromeSettings(true)}
            />
          )}
          {serviceConnectors.map((connector) => (
            <ConnectedRow
              key={connector.id}
              connector={connector}
              working={working === connector.id}
              busy={working !== null && working !== connector.id}
              onConnect={() => void connect(connector)}
              onCancel={() => void cancelConnect(connector)}
              onToggle={() => void toggle(connector)}
              onManage={() => void openConnectorDraft(connector, setDraft)}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="section-heading-row items-end">
          <div>
            <h2 className="section-title">Connector library</h2>
          </div>
          <div className="search-field">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
          </div>
        </div>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {["All", "Communication", "Knowledge", "Projects", "Developer", "Business"].map((item) => (
            <button key={item} onClick={() => setCategory(item)} aria-pressed={category === item} className={`filter-chip ${category === item ? "filter-chip-active" : ""}`}>
              {item}
            </button>
          ))}
        </div>
        <div className="connector-grid">
          {catalog.map((item) => {
            const installed = connectorForCatalog(item);
            return (
              <CatalogCard
                key={item.id}
                item={item}
                connector={installed}
                working={working === installed?.id}
                busy={working !== null}
                onConnect={() => void addCatalog(item)}
                onCancel={() => installed && void cancelConnect(installed)}
              />
            );
          })}
        </div>
        {!catalog.length && (
          <div className="empty-library-state">
            <Search size={17} />
            <div><strong>No connectors found</strong><span>Try another name or category.</span></div>
          </div>
        )}
      </section>

      {draft && (
        <ConnectorSheet
          draft={draft}
          connector={draft.id ? connectors.find((connector) => connector.id === draft.id) : undefined}
          working={working === (draft.id ?? "new")}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void saveDraft()}
          onDisconnect={disconnect}
          onRemove={remove}
        />
      )}

      {showChromeSettings && settings && (
        <ChromeAccessSheet
          connector={chromeConnector}
          settings={settings}
          working={working === chromeConnector?.id || working === "chrome-new"}
          busy={working !== null && working !== chromeConnector?.id && working !== "chrome-new"}
          onClose={() => setShowChromeSettings(false)}
          onConnect={() => void connectChrome()}
          onDisconnect={() => void disconnectChrome()}
          onSettingChange={(key, value) => void saveBrowserSetting(key, value)}
        />
      )}
    </>
  );
}

function ChromeConnectionRow({ connector, settings, working, busy, onConnect, onManage }: {
  connector?: Connector;
  settings: Settings;
  working: boolean;
  busy: boolean;
  onConnect: () => void;
  onManage: () => void;
}) {
  const connected = connector?.status === "connected";
  return (
    <div className="connection-row connection-row-chrome">
      <div className="chrome-mark"><Chrome size={19} strokeWidth={1.9} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold">Chrome</span>
          <StatusPill status={connector?.status ?? "disconnected"} />
          {connected && settings.browser_sweep_enabled && <span className="connection-inline-meta">Included in sweeps</span>}
        </div>
      </div>
      {!connected && (
        <button onClick={onConnect} disabled={working || busy} className="secondary-button">
          {working && <LoaderCircle className="animate-spin" size={14} />}
          {working ? "Connecting…" : "Connect"}
        </button>
      )}
      <button onClick={onManage} className="secondary-button">Manage <ChevronRight size={14} /></button>
    </div>
  );
}

function ChromeAccessSheet({ connector, settings, working, busy, onClose, onConnect, onDisconnect, onSettingChange }: {
  connector?: Connector;
  settings: Settings;
  working: boolean;
  busy: boolean;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSettingChange: (key: string, value: unknown) => void;
}) {
  const [domains, setDomains] = useState(settings.browser_allowed_domains.join("\n"));
  const [setupNotice, setSetupNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const connected = connector?.status === "connected";
  useEffect(() => setDomains(settings.browser_allowed_domains.join("\n")), [settings.browser_allowed_domains]);

  const launchSetup = async () => {
    setSetupNotice(null);
    try {
      await openChromeSetup();
      setSetupNotice({ kind: "success", text: "Chrome opened. Turn on Remote Debugging, then return here and connect." });
    } catch (error) {
      setSetupNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="connector-sheet chrome-access-sheet" role="dialog" aria-modal="true" aria-labelledby="chrome-access-title">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-5">
          <div className="chrome-mark"><Chrome size={20} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="chrome-access-title" className="text-lg font-semibold">Chrome</h2>
              <StatusPill status={connector?.status ?? "disconnected"} />
            </div>
          </div>
          <button onClick={onClose} className="icon-button" aria-label="Close Chrome settings"><X size={17} /></button>
        </div>

        <div className="scroll-thin max-h-[calc(100vh-190px)] overflow-y-auto px-6 py-5">
          <div className="chrome-sheet-actions">
            <button onClick={() => void launchSetup()} className="secondary-button">Open Chrome setup <ArrowUpRight size={13} /></button>
            {connected ? (
              <button onClick={onDisconnect} disabled={working} className="secondary-button">Disconnect</button>
            ) : (
              <button onClick={onConnect} disabled={working || busy} className="primary-button">
                {working && <LoaderCircle className="animate-spin" size={14} />}
                {working ? "Waiting for Chrome…" : "Connect Chrome"}
              </button>
            )}
          </div>

          {setupNotice && <div className={`notice-banner chrome-setup-notice ${setupNotice.kind === "error" ? "notice-banner-error" : ""}`}>{setupNotice.kind === "error" ? <CircleAlert size={15} /> : <Check size={15} />}<span>{setupNotice.text}</span></div>}
          {connector?.last_error && <div className="error-detail mt-3"><CircleAlert size={15} /><span>{connector.last_error}</span></div>}

          <div className="chrome-sheet-grid">
            <label>
              <FieldLabel>Tabs Scout may use</FieldLabel>
              <select value={settings.browser_access_mode} onChange={(event) => onSettingChange("browser_access_mode", event.target.value)} className="form-input w-full">
                <option value="allowed_sites">Only allowed sites</option>
                <option value="current_tab">Current tab only</option>
                <option value="full_profile">All open tabs</option>
              </select>
            </label>
            {settings.browser_access_mode === "allowed_sites" && (
              <label>
                <FieldLabel>Allowed domains</FieldLabel>
                <textarea value={domains} onChange={(event) => setDomains(event.target.value)} onBlur={() => onSettingChange("browser_allowed_domains", normalizeAllowedDomains([domains]))} className="form-input min-h-24 w-full resize-y font-mono text-sm leading-5" placeholder={"mail.google.com\ncalendar.google.com\napp.slack.com"} />
              </label>
            )}
          </div>

          {settings.browser_access_mode === "full_profile" && <div className="chrome-scope-warning">All open tabs will be visible to Scout.</div>}

          <div className="chrome-sweep-setting">
            <div><strong>Use Chrome during sweeps</strong><span>{connected ? "Ready" : "Connect Chrome first, then opt in here"}</span></div>
            <Toggle on={settings.browser_sweep_enabled} onChange={() => onSettingChange("browser_sweep_enabled", !settings.browser_sweep_enabled)} label="Use Chrome during sweeps" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectedRow({ connector, working, busy, onConnect, onCancel, onToggle, onManage }: {
  connector: Connector;
  working: boolean;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onToggle: () => void;
  onManage: () => void;
}) {
  const item = catalogConnector(connector.catalog_id);
  const healthy = connector.status === "connected";
  const cancellable = working && (connector.auth_type === "oauth" || connector.auth_type === "oauth_credentials");
  return (
    <div className="connection-row">
      <ProviderMark item={item} fallback={connector.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold">{connector.name}</span>
          <StatusPill status={connector.status} />
          {healthy && <span className="connection-inline-meta">{connector.tool_count} tools</span>}
        </div>
      </div>
      {!healthy && (
        <button onClick={cancellable ? onCancel : onConnect} disabled={(working && !cancellable) || busy} className="secondary-button hidden sm:flex">
          {working ? (cancellable ? <X size={14} /> : <LoaderCircle className="animate-spin" size={14} />) : null}
          {working ? (cancellable ? "Cancel sign-in" : "Connecting…") : "Connect"}
        </button>
      )}
      <Toggle on={!!connector.enabled && healthy} onChange={onToggle} label={`${connector.name} connection`} disabled={working || busy} />
      <button onClick={onManage} className="icon-button-small" aria-label={`Manage ${connector.name}`}><MoreHorizontal size={17} /></button>
    </div>
  );
}

function CatalogCard({ item, connector, working, busy, onConnect, onCancel }: {
  item: CatalogConnector;
  connector?: Connector;
  working: boolean;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
}) {
  const connected = connector?.status === "connected";
  const cancellable = working && (connector?.auth_type === "oauth" || connector?.auth_type === "oauth_credentials");
  return (
    <article className="connector-card">
      <div className="flex items-center gap-3">
        <ProviderMark item={item} fallback={item.name} large />
        <h3 className="text-base font-semibold tracking-[-0.01em]">{item.name}</h3>
      </div>
      <button onClick={cancellable ? onCancel : onConnect} disabled={(working && !cancellable) || (busy && !working)} className={`catalog-action ${connected ? "catalog-action-connected" : ""}`}>
        {working ? (cancellable ? <X size={14} /> : <LoaderCircle className="animate-spin" size={14} />) : connected ? <Check size={14} /> : null}
        {working ? (cancellable ? "Cancel sign-in" : "Connecting…") : connected ? "Manage connection" : item.preview && item.setupNote ? "Review access" : item.authType === "bearer" ? "Add token" : item.authType === "oauth_credentials" ? "Set up OAuth" : "Connect"}
        {!working && !connected && <ChevronRight className="ml-auto" size={14} />}
      </button>
    </article>
  );
}

function ConnectorSheet({ draft, connector, working, onChange, onClose, onSave, onDisconnect, onRemove }: {
  draft: ConnectorDraft;
  connector?: Connector;
  working: boolean;
  onChange: (draft: ConnectorDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onDisconnect: (connector: Connector) => Promise<void>;
  onRemove: (connector: Connector) => Promise<void>;
}) {
  const needsCredentials = draft.authType === "oauth_credentials";
  const [validationRequested, setValidationRequested] = useState(false);
  const requiresClientSecret = needsCredentials && !!draft.catalogId && catalogConnector(draft.catalogId)?.requiresClientSecret;
  const missingClientId = needsCredentials && !draft.clientId.trim();
  const missingClientSecret = requiresClientSecret && !draft.clientSecret.trim();
  const missingBearerToken = draft.authType === "bearer" && !draft.bearerToken.trim();
  const missingHeaderName = draft.authType === "headers" && !draft.headerName.trim();
  const missingHeaderValue = draft.authType === "headers" && !draft.headerValue.trim();
  const missingName = !draft.name.trim();
  const missingUrl = !draft.url.trim();
  const invalidUrl = !!draft.url.trim() && !isAllowedMcpUrl(draft.url);
  const valid = !missingName
    && !invalidUrl
    && !missingUrl
    && !missingClientId
    && !missingClientSecret
    && !missingBearerToken
    && !missingHeaderName
    && !missingHeaderValue;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="connector-sheet" role="dialog" aria-modal="true" aria-labelledby="connector-sheet-title">
        <div className="flex items-start gap-3 border-b border-[#e4e9f1] px-6 py-5 dark:border-white/8">
          <ProviderMark item={catalogConnector(draft.catalogId ?? null)} fallback={draft.name || "MCP"} large />
          <div className="min-w-0 flex-1">
            <h2 id="connector-sheet-title" className="text-lg font-semibold tracking-[-0.02em]">{connector ? `Manage ${draft.name}` : draft.catalogId ? `Connect ${draft.name}` : "Add an MCP server"}</h2>
            {draft.setupUrl && !connector && (
              <button onClick={() => void openUrl(draft.setupUrl!)} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-[var(--brand)]">
                Open setup guide <ArrowUpRight size={13} />
              </button>
            )}
          </div>
          <button onClick={onClose} className="icon-button"><X size={17} /></button>
        </div>

        <div className="scroll-thin max-h-[calc(100vh-190px)] space-y-5 overflow-y-auto px-6 py-5">
          {needsCredentials && (
            <div>
              <FieldLabel>Register this callback URL with the provider</FieldLabel>
              <div className="copy-field">
                <code>{OAUTH_CALLBACK_URL}</code>
                <button onClick={() => void navigator.clipboard.writeText(OAUTH_CALLBACK_URL)} aria-label="Copy callback URL"><Copy size={14} /></button>
              </div>
            </div>
          )}

          {(!draft.catalogId || draft.authOptions?.length) && (
            <div className={draft.catalogId ? "" : "grid grid-cols-2 gap-3"}>
              {!draft.catalogId && <label><FieldLabel>Name</FieldLabel><TextInput value={draft.name} onChange={(name) => onChange({ ...draft, name })} placeholder="My workspace" />{validationRequested && missingName && <span className="field-error">Give this connection a name.</span>}</label>}
              <label>
                <FieldLabel>Authentication</FieldLabel>
                <select value={draft.authType} onChange={(event) => onChange({ ...draft, authType: event.target.value as Connector["auth_type"] })} className="form-input">
                  {(!draft.authOptions || draft.authOptions.includes("oauth")) && <option value="oauth">Automatic OAuth</option>}
                  {(!draft.authOptions || draft.authOptions.includes("oauth_credentials")) && <option value="oauth_credentials">OAuth app credentials</option>}
                  {(!draft.authOptions || draft.authOptions.includes("bearer")) && <option value="bearer">Personal access token</option>}
                  {!draft.authOptions && <option value="headers">Custom header</option>}
                </select>
              </label>
            </div>
          )}

          <label>
            <FieldLabel>Remote MCP URL</FieldLabel>
            <TextInput value={draft.url} onChange={(url) => onChange({ ...draft, url })} placeholder="https://example.com/mcp or http://localhost:4700/mcp" mono />
            {validationRequested && missingUrl && <span className="field-error">Enter the MCP server URL.</span>}
            {validationRequested && invalidUrl && <span className="field-error">Use HTTPS, or plain HTTP only for a localhost or loopback server.</span>}
          </label>

          {needsCredentials && (
            <div className="grid grid-cols-2 gap-3">
              <label><FieldLabel>OAuth client ID</FieldLabel><TextInput value={draft.clientId} onChange={(clientId) => onChange({ ...draft, clientId })} placeholder="Client ID" />{validationRequested && missingClientId && <span className="field-error">Enter the client ID from the provider.</span>}</label>
              <label><FieldLabel>OAuth client secret</FieldLabel><TextInput value={draft.clientSecret} onChange={(clientSecret) => onChange({ ...draft, clientSecret })} placeholder={requiresClientSecret ? "Required" : "Stored securely"} password />{validationRequested && missingClientSecret && <span className="field-error">This provider requires a client secret.</span>}</label>
            </div>
          )}
          {draft.authType === "bearer" && <label><FieldLabel>Bearer token</FieldLabel><TextInput value={draft.bearerToken} onChange={(bearerToken) => onChange({ ...draft, bearerToken })} placeholder="Stored securely" password />{validationRequested && missingBearerToken && <span className="field-error">Enter an access token to connect.</span>}</label>}
          {draft.authType === "headers" && (
            <div className="grid grid-cols-2 gap-3">
              <label><FieldLabel>Header name</FieldLabel><TextInput value={draft.headerName} onChange={(headerName) => onChange({ ...draft, headerName })} placeholder="X-API-Key" />{validationRequested && missingHeaderName && <span className="field-error">Enter the header name.</span>}</label>
              <label><FieldLabel>Header value</FieldLabel><TextInput value={draft.headerValue} onChange={(headerValue) => onChange({ ...draft, headerValue })} placeholder="Stored securely" password />{validationRequested && missingHeaderValue && <span className="field-error">Enter the header value.</span>}</label>
            </div>
          )}

          {connector?.last_error && <div className="error-detail"><CircleAlert size={15} /><span>{connector.last_error}</span></div>}
        </div>

        <div className="flex items-center gap-2 border-t border-[#e4e9f1] px-6 py-4 dark:border-white/8">
          {connector && (
            <button onClick={() => void onRemove(connector)} className="danger-ghost-button"><Trash2 size={14} /> Remove</button>
          )}
          <div className="ml-auto flex gap-2">
            {connector?.status === "connected" && <button onClick={() => void onDisconnect(connector)} className="secondary-button">Disconnect</button>}
            <button onClick={onClose} className="secondary-button">Cancel</button>
            <button onClick={() => { setValidationRequested(true); if (valid) onSave(); }} disabled={working} className="primary-button">
              {working && <LoaderCircle size={14} className="animate-spin" />}
              {working ? (draft.authType === "bearer" ? "Connecting…" : "Waiting for browser") : connector ? "Save & reconnect" : "Save & connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Remaining settings pages ────────────────────────────────────────────────

function ModelPage({ settings, onSaved }: PageProps) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  useEffect(() => { void getApiKey().then((value) => setKey(value ? `••••••••${value.slice(-4)}` : "")); }, []);
  const loadModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try { setModels(await listProviderModels(settings.provider)); }
    catch (error) { setModels([]); setModelsError(error instanceof Error ? error.message : String(error)); }
    finally { setModelsLoading(false); }
  };
  useEffect(() => { void loadModels(); }, [settings.provider]); // provider changes require a fresh catalog
  const runTest = async () => {
    setTesting(true); setMessage(null);
    try { setMessage(`Connected · ${await testConnection()}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setTesting(false); }
  };
  return (
    <>
      <PageHeading eyebrow="Intelligence" title="Model" description="Choose the model Scout uses for planning and judgment calls." />
      <SettingsCard title="Provider" description="Your key stays in your operating system's credential vault.">
        <div className="segmented-control">
          {(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((provider) => (
            <button key={provider} className={settings.provider === provider ? "active" : ""} onClick={async () => {
              await setSetting("provider", provider); await setSetting("model", PROVIDERS[provider].defaultModel); await onSaved();
            }}>{PROVIDERS[provider].label}</button>
          ))}
        </div>
        <SettingRow label="API key" description="Protected by Keychain or your platform's credential manager; never written to Scout's database.">
          <input value={key} onChange={(event) => setKey(event.target.value)} onBlur={async () => {
            if (key && !key.startsWith("••••")) { await setApiKey(key); setKey(`••••••••${key.slice(-4)}`); await loadModels(); }
          }} className="form-input w-72" placeholder="Paste API key" type="password" />
        </SettingRow>
        <SettingRow label="Model" description={modelsLoading ? "Loading available models…" : `${models.length || 1} available`}>
          <div className="model-picker">
            <select value={settings.model} onChange={async (event) => { await setSetting("model", event.target.value); await onSaved(); }} className="form-input model-select">
              {(!models.some((model) => model.id === settings.model) ? [{ id: settings.model, name: settings.model }, ...models] : models).map((model) => (
                <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} — ${model.id}`}</option>
              ))}
            </select>
            <button onClick={() => void loadModels()} className="icon-button" disabled={modelsLoading} aria-label="Refresh models"><RefreshCw size={15} className={modelsLoading ? "animate-spin" : ""} /></button>
            <button onClick={() => void runTest()} className="secondary-button" disabled={testing}>{testing ? "Testing…" : "Test model"}</button>
          </div>
        </SettingRow>
        {modelsError && <div className="model-load-error">{modelsError}</div>}
        {message && <div className="border-t border-[#e6ebf2] pt-4 text-sm text-[#667286] dark:border-white/8">{message}</div>}
        <SettingRow label="Judgment effort" description="Higher effort spends more time comparing evidence before proposing work.">
          <select value={settings.judgment_effort} onChange={async (event) => { await setSetting("judgment_effort", event.target.value); await onSaved(); }} className="form-input w-40"><option value="low">Low</option><option value="high">High</option><option value="max">Maximum</option></select>
        </SettingRow>
      </SettingsCard>
    </>
  );
}

function AutomationPage({ settings, onSaved }: PageProps) {
  return (
    <>
      <PageHeading eyebrow="Cadence & control" title="Automation" description="Decide when Scout checks your workspace and how far it can go." />
      <SettingsCard title="Sweep cadence" description="Scout reads connected tools on this schedule.">
        <div className="rounded-xl bg-[var(--surface-soft)] p-4"><div className="flex items-baseline justify-between"><span className="text-base font-medium">Every {settings.sweep_interval_minutes} minutes</span><span className="text-sm text-[#8490a3]">5 min — 2 hours</span></div><input type="range" min={5} max={120} step={5} value={settings.sweep_interval_minutes} onChange={async (event) => { await setSetting("sweep_interval_minutes", Number(event.target.value)); await onSaved(); stopScheduler(); await startScheduler(); }} className="mt-4 w-full accent-[var(--brand)]" /></div>
        <SettingRow label="Quiet hours" description="Scout stays silent but keeps your connections intact."><input defaultValue={settings.quiet_hours} onBlur={async (event) => { await setSetting("quiet_hours", event.target.value); await onSaved(); }} placeholder="22:00–07:00" className="form-input w-44" /></SettingRow>
      </SettingsCard>
      <SettingsCard title="Approval mode" description="Scout reads freely. Choose what happens after it proposes an action.">
        <div className="grid grid-cols-2 gap-2">{(["off", "manual"] as const).map((mode) => <button key={mode} onClick={async () => { await setSetting("autonomy", mode); await onSaved(); }} className={`choice-card ${settings.autonomy === mode ? "choice-card-active" : ""}`}><span className="text-base font-semibold">{mode === "off" ? "Paused" : "Ask every time"}</span><span>{mode === "off" ? "Automatic sweeps are off; Sweep now still runs" : "Every external action requires your explicit approval"}</span></button>)}</div>
        <SettingRow label="Store model diagnostics" description="Off by default. When enabled, prompts, model output, and reasoning are stored locally for troubleshooting."><Toggle on={settings.retain_diagnostics} label="Store diagnostics" onChange={async () => { await setSetting("retain_diagnostics", !settings.retain_diagnostics); await onSaved(); }} /></SettingRow>
      </SettingsCard>
    </>
  );
}

function ProfilePage({ settings, onSaved }: PageProps) {
  return (
    <>
      <PageHeading eyebrow="Working context" title="About you" description="Help Scout distinguish useful initiative from noise." />
      <SettingsCard title="Personal context" description="This context is included in judgment calls.">
        <label><FieldLabel>Your name</FieldLabel><input defaultValue={settings.user_name} onBlur={async (event) => { await setSetting("user_name", event.target.value); await onSaved(); }} className="form-input mt-1.5 w-full" placeholder="What should Scout call you?" /></label>
        <label><FieldLabel>Role, priorities, and preferences</FieldLabel><textarea defaultValue={settings.user_context} onBlur={async (event) => { await setSetting("user_context", event.target.value); await onSaved(); }} className="form-input mt-1.5 min-h-36 w-full resize-y leading-6" placeholder="I lead… This quarter, I care most about… Avoid proposing…" /></label>
      </SettingsCard>
    </>
  );
}

function DesktopPage({ settings, onSaved }: PageProps) {
  const [autostart, setAutostart] = useState(false);
  useEffect(() => { void isAutostartEnabled().then(setAutostart).catch(() => {}); }, []);
  return (
    <>
      <PageHeading eyebrow="App behavior" title="Desktop" description="Choose how Scout fits into your day." />
      <SettingsCard title="Presence" description="Scout can stay ambient in the menu bar.">
        <SettingRow label="Launch at login" description="Start Scout automatically when you sign in."><Toggle on={autostart} label="Launch at login" onChange={async () => { if (autostart) await disableAutostart(); else await enableAutostart(); setAutostart(!autostart); await setSetting("launch_at_login", !autostart); await onSaved(); }} /></SettingRow>
        <SettingRow label="Menu bar only" description="Hide the Dock icon and keep Scout in the menu bar."><Toggle on={settings.menu_bar_only} label="Menu bar only" onChange={async () => { const next = !settings.menu_bar_only; await setSetting("menu_bar_only", next); try { await invoke("set_menu_bar_only", { enabled: next }); } catch { /* platform fallback */ } await onSaved(); }} /></SettingRow>
      </SettingsCard>
    </>
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

interface PageProps { settings: Settings; onSaved: () => Promise<void> }

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="mb-8 flex items-end gap-6"><div className="min-w-0 flex-1"><div className="mb-2 text-[12px] font-semibold tracking-[0.16em] text-[var(--brand)] uppercase">{eyebrow}</div><h1 className="text-[30px] font-semibold tracking-[-0.035em]">{title}</h1>{description && <p className="mt-2 max-w-2xl text-base leading-6 text-[#748094] dark:text-[#939dad]">{description}</p>}</div>{action}</div>;
}

function SettingsCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="settings-card mb-5"><div className="mb-5"><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-sm text-[#7f8a9d]">{description}</p></div><div className="space-y-4">{children}</div></section>;
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return <div className="flex items-center gap-6 border-t border-[#e6ebf2] pt-4 first:border-0 first:pt-0 dark:border-white/8"><div className="min-w-0 flex-1"><div className="text-base font-medium">{label}</div><div className="mt-1 text-sm leading-5 text-[#8490a3]">{description}</div></div><div className="shrink-0">{children}</div></div>;
}

function FieldLabel({ children }: { children: React.ReactNode }) { return <span className="mb-1.5 block text-[13px] font-semibold text-[#586379]">{children}</span>; }

function TextInput({ value, onChange, placeholder, password, mono }: { value: string; onChange: (value: string) => void; placeholder?: string; password?: boolean; mono?: boolean }) {
  return <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={password ? "password" : "text"} className={`form-input w-full ${mono ? "font-mono text-sm" : ""}`} />;
}

function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: () => void | Promise<void>; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => void onChange()} className={`toggle-switch ${on ? "toggle-switch-on" : ""}`}><span aria-hidden="true" /></button>;
}

function ProviderMark({ item, fallback, large = false }: { item?: CatalogConnector; fallback: string; large?: boolean }) {
  return <ProviderLogo providerId={item?.id} fallback={fallback} large={large} />;
}

function StatusPill({ status }: { status: Connector["status"] }) {
  return <span className={`status-pill status-${status}`}><i />{status === "connected" ? "Live" : status === "error" ? "Needs attention" : "Off"}</span>;
}

function blankDraft(): ConnectorDraft { return { name: "", url: "", authType: "oauth", clientId: "", clientSecret: "", bearerToken: "", headerName: "", headerValue: "" }; }

function draftFromCatalog(item: CatalogConnector): ConnectorDraft { return { ...blankDraft(), catalogId: item.id, name: item.name, url: item.url, authType: item.authType, setupUrl: item.setupUrl, setupNote: item.setupNote, authOptions: item.authOptions }; }

async function draftFromConnector(connector: Connector, item?: CatalogConnector): Promise<ConnectorDraft> {
  const auth = await getConnectorAuth(connector.id);
  const headers = Object.entries(auth.headers ?? {})[0] ?? ["", ""];
  const supportedAuth = item?.authOptions ?? (item ? [item.authType] : undefined);
  const authType = supportedAuth?.includes(connector.auth_type as CatalogConnector["authType"])
    ? connector.auth_type
    : item?.authType ?? connector.auth_type;
  return { id: connector.id, catalogId: connector.catalog_id ?? undefined, name: connector.name, url: connector.url, authType, clientId: auth.clientId ?? "", clientSecret: auth.clientSecret ?? "", bearerToken: auth.bearerToken ?? "", headerName: headers[0], headerValue: headers[1], setupUrl: item?.setupUrl, setupNote: item?.setupNote, authOptions: item?.authOptions };
}

async function openConnectorDraft(connector: Connector, setDraft: (draft: ConnectorDraft) => void) { setDraft(await draftFromConnector(connector, catalogConnector(connector.catalog_id))); }

async function insertConnector(input: { catalogId?: string; name: string; url: string; authType: Connector["auth_type"] }): Promise<Connector> {
  const db = await getDb();
  const connector: Connector = { id: uuid(), catalog_id: input.catalogId ?? null, name: input.name, url: input.url, auth_type: input.authType, enabled: 1, status: "disconnected", last_error: null, tool_count: 0, last_connected_at: null, created_at: nowIso() };
  await db.execute("INSERT INTO connectors (id,name,url,catalog_id,auth_type,enabled,status,created_at) VALUES ($1,$2,$3,$4,$5,1,'disconnected',$6);", [connector.id, connector.name, connector.url, connector.catalog_id, connector.auth_type, connector.created_at]);
  return connector;
}
