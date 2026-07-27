import { vi } from "vitest";

// Tauri APIs don't exist in node — stub them before any app module loads.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: vi.fn() } }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private m = new Map<string, unknown>();
    async get<T>(k: string): Promise<T | undefined> {
      return this.m.get(k) as T | undefined;
    }
    async set(k: string, v: unknown) {
      this.m.set(k, v);
    }
    async delete(k: string) {
      this.m.delete(k);
    }
    async save() {}
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: vi.fn(async () => false),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ label: "main" })) }));
