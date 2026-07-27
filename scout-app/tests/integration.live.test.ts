/**
 * LIVE integration test — runs the REAL sweep pipeline (real K3 API calls,
 * real prompts) against the demo fixture connector. Only connector data is fake.
 * Skipped unless RUN_LIVE=1 and an API key is available via .env.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __setDbForTests, getDb, nowIso, uuid } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";
import { __setTransportForTests } from "../src/lib/llm";
import { runSweep } from "../src/lib/sweep";
import { listOpenProposals, getProposal, applyVerb } from "../src/lib/proposals";
import { executeProposal } from "../src/lib/executor";
import { reviseProposal, distillDenial } from "../src/lib/judgments";

const RUN = process.env.RUN_LIVE === "1";
const hasKey = Boolean(
  process.env.VITE_OPENROUTER_API_KEY || process.env.VITE_MOONSHOT_API_KEY,
);

describe.skipIf(!RUN || !hasKey)("LIVE sweep against real K3 (demo fixture)", () => {
  beforeEach(async () => {
    __setDbForTests(async () => makeTestDb() as never);
    // Use node's real fetch — bypasses the tauri plugin mock in setup.ts.
    __setTransportForTests((url, init) => fetch(url, init));
    const db = await getDb();
    await db.execute(
      "INSERT INTO connectors (id, name, url, enabled, created_at) VALUES ($1,'Acme Workspace (demo)','demo://acme',1,$2);",
      [uuid(), nowIso()],
    );
    await db.execute("INSERT INTO settings (key, value) VALUES ('user_name','Obose') ON CONFLICT(key) DO UPDATE SET value='Obose';", []);
  }, 120_000);

  it("runs a full sweep: planner → real reads → judgment → proposals", async () => {
    const out = await runSweep("manual");
    expect(out.error).toBeUndefined();
    expect(out.status).toBe("done");
    expect(out.proposalCount).toBeGreaterThanOrEqual(1);

    const open = await listOpenProposals();
    console.log(
      "\n===== LIVE PROPOSALS =====\n" +
        open.map((p) => `[${p.category}/${p.urgency}] ${p.headline}`).join("\n") +
        `\n(cost: $${out.costUsd.toFixed(4)})\n`,
    );
    for (const p of open) {
      expect(p.headline.length).toBeGreaterThan(5);
      expect(JSON.parse(p.evidence).length).toBeGreaterThanOrEqual(1);
    }

    // every K3 call persisted with a verbatim reasoning trace
    const db = await getDb();
    const calls = await db.select<{ purpose: string; reasoning_content: string | null }[]>(
      "SELECT * FROM llm_calls WHERE sweep_id=$1;",
      [out.sweepId],
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => (c.reasoning_content ?? "").length > 50)).toBe(true);

    // sweep row has real token usage + cost
    const sweeps = await db.select<{ input_tokens: number; cost_usd: number }[]>("SELECT * FROM sweeps;");
    expect(sweeps[0].input_tokens).toBeGreaterThan(100);
    expect(sweeps[0].cost_usd).toBeGreaterThan(0);
  }, 300_000);

  it("exercises revise-chat and denial distillation against real K3", async () => {
    const out = await runSweep("manual");
    expect(out.status).toBe("done");
    const open = await listOpenProposals();
    const withDraft = open.find((p) => p.draft);
    if (withDraft) {
      const res = await reviseProposal(withDraft, "Make it shorter and warmer.");
      console.log("\n===== REVISED DRAFT =====\n", res.draft, "\n");
      expect(res.draft === null || typeof res.draft === "string").toBe(true);
    }
    const target = open[0];
    if (target) {
      const lesson = await distillDenial(target, "I already handled this yesterday");
      console.log("\n===== DISTILLED LESSON =====\n", lesson, "\n");
      expect(lesson).toBeTruthy();
      await applyVerb(target.id, "dismiss", "I already handled this yesterday");
    }
  }, 300_000);

  it("executes a tool_call proposal end-to-end against the demo connector", async () => {
    const out = await runSweep("manual");
    expect(out.status).toBe("done");
    const open = await listOpenProposals();
    const toolCall = open.find((p) => p.action_kind === "tool_call" && JSON.parse(p.action_plan).length > 0);
    if (!toolCall) {
      console.log("\n(no tool_call proposals this sweep — acceptable)\n");
      return;
    }
    await applyVerb(toolCall.id, "run");
    const result = await executeProposal(toolCall.id);
    console.log("\n===== EXECUTION =====\n", JSON.stringify(result, null, 2).slice(0, 800), "\n");
    expect(result.ok).toBe(true);
    const p = await getProposal(toolCall.id);
    expect(p!.status).toBe("executed");
  }, 300_000);
});
