import { DEFAULTS } from "./constants";
import type { Settings } from "./types";
import { getDb } from "./db";

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  const rows = await db.select<{ key: string; value: string }[]>("SELECT key, value FROM settings;");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k);
  return {
    sweep_interval_minutes: Number(get("sweep_interval_minutes") ?? DEFAULTS.sweepIntervalMinutes),
    provider: (get("provider") as Settings["provider"]) ?? DEFAULTS.provider,
    model: get("model") ?? DEFAULTS.model,
    autonomy: get("autonomy") === "off" ? "off" : "manual",
    quiet_hours: get("quiet_hours") ?? DEFAULTS.quietHours,
    user_name: get("user_name") ?? DEFAULTS.userName,
    user_context: get("user_context") ?? DEFAULTS.userContext,
    judgment_effort: (get("judgment_effort") as Settings["judgment_effort"]) ?? DEFAULTS.judgmentEffort,
    safe_tools: JSON.parse(get("safe_tools") ?? "[]"),
    demo_mode: get("demo_mode") === "true",
    menu_bar_only: get("menu_bar_only") === "true",
    launch_at_login: get("launch_at_login") === "true",
    browser_sweep_enabled: get("browser_sweep_enabled") == null
      ? DEFAULTS.browserSweepEnabled
      : get("browser_sweep_enabled") === "true",
    browser_access_mode: (get("browser_access_mode") as Settings["browser_access_mode"]) ?? DEFAULTS.browserAccessMode,
    browser_allowed_domains: JSON.parse(get("browser_allowed_domains") ?? JSON.stringify(DEFAULTS.browserAllowedDomains)),
    retain_diagnostics: get("retain_diagnostics") === "true",
  };
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  const v = typeof value === "string" ? value : JSON.stringify(value);
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=$2;",
    [key, v],
  );
}

/** "22:00-07:00" style window. Empty = never quiet. */
export function isQuietHours(quietHours: string, at: Date = new Date()): boolean {
  if (!quietHours.trim()) return false;
  const m = quietHours.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const now = at.getHours() * 60 + at.getMinutes();
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // overnight window
}
