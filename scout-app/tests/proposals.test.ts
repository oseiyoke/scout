import { describe, it, expect, beforeEach } from "vitest";
import { __setDbForTests, getDb } from "../src/lib/db";
import { makeTestDb } from "./helpers/testDb";
import {
  canTransition,
  transition,
  applyVerb,
  undoDecision,
  insertProposal,
  listOpenProposals,
  expireStaleProposals,
  getProposal,
} from "../src/lib/proposals";

const base = {
  sweep_id: null,
  category: "follow_up" as const,
  urgency: "medium" as const,
  confidence: 0.8,
  headline: "Test headline",
  observation: "Test observation",
  recommended_action: "Send the prepared follow-up after reviewing the evidence.",
  evidence: "[]",
  action_kind: "draft_only" as const,
  action_plan: "[]",
  draft: "hi",
  dedupe_key: "test-key",
};

beforeEach(() => __setDbForTests(async () => makeTestDb() as never));

describe("proposal state machine", () => {
  it("allows every legal verb path", () => {
    expect(canTransition("proposed", "approved")).toBe(true);
    expect(canTransition("proposed", "dismissed")).toBe(true);
    expect(canTransition("proposed", "handled_by_human")).toBe(true);
    expect(canTransition("proposed", "expired")).toBe(true);
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("executing", "executed")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
    expect(canTransition("failed", "proposed")).toBe(true); // re-queue
    expect(canTransition("dismissed", "proposed")).toBe(true); // undo
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("proposed", "executing")).toBe(false);
    expect(canTransition("proposed", "executed")).toBe(false);
    expect(canTransition("executed", "proposed")).toBe(false);
    expect(canTransition("dismissed", "executing")).toBe(false);
  });

  it("runs the full lifecycle through the DB", async () => {
    const id = (await insertProposal(base))!;
    await applyVerb(id, "run");
    expect((await getProposal(id))!.status).toBe("approved");
    await transition(id, "executing");
    await transition(id, "executed");
    const p = (await getProposal(id))!;
    expect(p.status).toBe("executed");
    expect(p.decided_at).toBeTruthy();
    await expect(transition(id, "proposed")).rejects.toThrow(/Illegal/);
  });

  it("dismiss captures a denial reason; undo returns to inbox", async () => {
    const id = (await insertProposal(base))!;
    await applyVerb(id, "dismiss", "not relevant");
    let p = (await getProposal(id))!;
    expect(p.status).toBe("dismissed");
    expect(p.denial_reason).toBe("not relevant");
    await undoDecision(id);
    p = (await getProposal(id))!;
    expect(p.status).toBe("proposed");
    expect(p.denial_reason).toBe("not relevant"); // preserved for context
  });
});

describe("dedupe", () => {
  it("does not re-insert an open dedupe_key", async () => {
    const id1 = await insertProposal(base);
    const id2 = await insertProposal(base);
    expect(id1).toBeTruthy();
    expect(id2).toBeNull();
    expect(await listOpenProposals()).toHaveLength(1);
  });

  it("does not re-propose a recently decided key", async () => {
    const id1 = (await insertProposal(base))!;
    await applyVerb(id1, "dismiss");
    expect(await insertProposal(base)).toBeNull();
  });

  it("allows a different key", async () => {
    await insertProposal(base);
    expect(await insertProposal({ ...base, dedupe_key: "other" })).toBeTruthy();
  });
});

describe("expiry", () => {
  it("expires proposals older than 48h, keeps fresh ones", async () => {
    const oldId = (await insertProposal(base))!;
    await insertProposal({ ...base, dedupe_key: "fresh" });
    const db = await getDb();
    await db.execute("UPDATE proposals SET created_at=$1 WHERE id=$2;", [
      new Date(Date.now() - 49 * 3600 * 1000).toISOString(),
      oldId,
    ]);
    const n = await expireStaleProposals(48);
    expect(n).toBe(1);
    const open = await listOpenProposals();
    expect(open).toHaveLength(1);
    expect(open[0].dedupe_key).toBe("fresh");
  });
});
