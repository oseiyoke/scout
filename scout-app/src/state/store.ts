import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { getDb } from "../lib/db";
import type { ActivityLine, Connector, LlmCall, Proposal, Sweep } from "../lib/types";
import { listDoneProposals, listOpenProposals } from "../lib/proposals";
import { getSettings } from "../lib/settings";
import type { Settings } from "../lib/types";

interface ScoutState {
  proposals: Proposal[];
  done: Proposal[];
  connectors: Connector[];
  sweeps: Sweep[];
  activity: ActivityLine[];
  settings: Settings | null;
  lastSweep: Sweep | null;
  activeSweepId: string | null;
  refreshProposals: () => Promise<void>;
  refreshDone: () => Promise<void>;
  refreshConnectors: () => Promise<void>;
  refreshSweeps: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useScout = create<ScoutState>((set, get) => ({
  proposals: [],
  done: [],
  connectors: [],
  sweeps: [],
  activity: [],
  settings: null,
  lastSweep: null,
  activeSweepId: null,
  refreshProposals: async () => set({ proposals: await listOpenProposals() }),
  refreshDone: async () => set({ done: await listDoneProposals() }),
  refreshConnectors: async () => {
    const db = await getDb();
    set({ connectors: await db.select<Connector[]>("SELECT * FROM connectors ORDER BY created_at;") });
  },
  refreshSweeps: async () => {
    const db = await getDb();
    const sweeps = await db.select<Sweep[]>("SELECT * FROM sweeps ORDER BY started_at DESC LIMIT 100;");
    set({
      sweeps,
      lastSweep: sweeps[0] ?? null,
      activeSweepId: sweeps.find((sweep) => sweep.status === "running")?.id ?? null,
    });
  },
  refreshActivity: async () => {
    const db = await getDb();
    set({
      activity: await db.select<ActivityLine[]>("SELECT * FROM activity ORDER BY id DESC LIMIT 500;"),
    });
  },
  refreshSettings: async () => set({ settings: await getSettings() }),
  refreshAll: async () => {
    await Promise.all([
      get().refreshProposals(),
      get().refreshDone(),
      get().refreshConnectors(),
      get().refreshSweeps(),
      get().refreshActivity(),
      get().refreshSettings(),
    ]);
  },
}));

/** Wire DB-change events into the store. Call once per window. */
export async function bindStoreEvents(): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen("scout:proposals", () => {
      void useScout.getState().refreshProposals();
      void useScout.getState().refreshDone();
    }),
    listen("scout:activity", () => void useScout.getState().refreshActivity()),
    listen<{ status: string; sweepId: string }>("scout:sweep", (event) => {
      const { status, sweepId } = event.payload;
      useScout.setState((state) => ({
        activeSweepId: status === "running"
          ? sweepId
          : state.activeSweepId === sweepId
            ? null
            : state.activeSweepId,
      }));
      void useScout.getState().refreshSweeps();
      void useScout.getState().refreshProposals();
      void useScout.getState().refreshDone();
      void useScout.getState().refreshActivity();
      void useScout.getState().refreshConnectors();
    }),
  ]);
  return () => unlisteners.forEach((u) => u());
}

// ── Live thinking stream (Activity tab "watch Scout think") ──────────────────

interface ThinkingState {
  live: Record<string, string>; // sweepId -> accumulated reasoning (live stream)
  append: (sweepId: string, delta: string) => void;
  clear: (sweepId: string) => void;
}

interface ThinkingEvent {
  kind: "start" | "reasoning" | "end";
  purpose?: string;
  sweepId: string | null;
  callId?: string;
  sequence?: number;
  delta?: string;
}

const seenThinkingEvents = new Map<string, Set<string>>();

export const useThinking = create<ThinkingState>((set) => ({
  live: {},
  append: (sweepId, delta) =>
    set((s) => ({ live: { ...s.live, [sweepId]: (s.live[sweepId] ?? "") + delta } })),
  clear: (sweepId) =>
    set((s) => {
      const live = { ...s.live };
      delete live[sweepId];
      return { live };
    }),
}));

export async function bindThinkingEvents(): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<ThinkingEvent>("scout:thinking", (e) => {
      const { kind, purpose, sweepId, callId, sequence, delta } = e.payload;
      if (!sweepId) return;
      if (callId && sequence !== undefined) {
        const seenForSweep = seenThinkingEvents.get(sweepId) ?? new Set<string>();
        const eventKey = `${callId}:${sequence}`;
        if (seenForSweep.has(eventKey)) return;
        seenForSweep.add(eventKey);
        seenThinkingEvents.set(sweepId, seenForSweep);
      }
      if (kind === "start") {
        const label = purpose === "sweep_planner" ? "Planning the sweep" : purpose === "sweep_judgment" ? "Judging the evidence" : "Reasoning";
        const existing = useThinking.getState().live[sweepId];
        useThinking.getState().append(sweepId, `${existing ? "\n\n" : ""}── ${label} ──\n`);
      }
      if (kind === "reasoning" && delta) useThinking.getState().append(sweepId, delta);
    }),
    listen<{ status: string; sweepId: string }>("scout:sweep", (e) => {
      const { status, sweepId } = e.payload;
      if (status === "running") {
        seenThinkingEvents.delete(sweepId);
        useThinking.getState().clear(sweepId);
      }
      if (status === "done" || status === "error") {
        // Keep the final live frame visible while the persisted trace catches up.
        setTimeout(() => {
          seenThinkingEvents.delete(sweepId);
          useThinking.getState().clear(sweepId);
        }, 1200);
      }
    }),
  ]);
  return () => unlisteners.forEach((unlisten) => unlisten());
}

export async function llmCallsForSweep(sweepId: string): Promise<LlmCall[]> {
  const db = await getDb();
  return db.select<LlmCall[]>("SELECT * FROM llm_calls WHERE sweep_id=$1 ORDER BY at;", [sweepId]);
}
