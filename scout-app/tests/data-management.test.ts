import { beforeEach, describe, expect, it } from "vitest";
import { __setDbForTests, getDb } from "../src/lib/db";
import { clearScoutData } from "../src/lib/dataManagement";
import { makeTestDb } from "./helpers/testDb";

beforeEach(() => __setDbForTests(async () => makeTestDb() as never));

async function seedTestData() {
  const db = await getDb();
  await db.execute("INSERT INTO sweeps (id, started_at, status) VALUES ('s1','2026-07-25','done');");
  await db.execute(`INSERT INTO proposals (
    id, sweep_id, created_at, status, category, urgency, confidence, headline,
    observation, evidence, action_kind, action_plan, dedupe_key
  ) VALUES ('p1','s1','2026-07-25','proposed','follow_up','medium',0.9,'Test','Test','[]','fyi','[]','test');`);
  await db.execute(`INSERT INTO proposals (
    id, sweep_id, created_at, status, category, urgency, confidence, headline,
    observation, evidence, action_kind, action_plan, dedupe_key
  ) VALUES ('p2','s1','2026-07-25','dismissed','follow_up','medium',0.9,'Done','Done','[]','fyi','[]','done');`);
  await db.execute("INSERT INTO judgments (id, created_at, kind, lesson, source_proposal_id) VALUES ('j1','2026-07-25','denial','Test lesson','p2');");
  await db.execute("INSERT INTO activity (sweep_id, at, line) VALUES ('s1','2026-07-25','Test activity');");
  await db.execute("INSERT INTO llm_calls (id, sweep_id, proposal_id, at, purpose, request_json) VALUES ('l1','s1','p1','2026-07-25','judgment','{}');");
  await db.execute("INSERT INTO llm_calls (id, sweep_id, proposal_id, at, purpose, request_json) VALUES ('l3','s1','p2','2026-07-25','judgment','{}');");
  await db.execute("INSERT INTO llm_calls (id, sweep_id, proposal_id, at, purpose, request_json) VALUES ('l2','s1',NULL,'2026-07-25','sweep','{}');");
  await db.execute("INSERT INTO settings (key, value) VALUES ('test-setting','kept');");
  await db.execute("INSERT INTO connectors (id, name, url, enabled, status, created_at) VALUES ('c1','Test','https://example.com',1,'connected','2026-07-25');");
  return db;
}

async function count(table: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(`SELECT COUNT(*) AS count FROM ${table};`);
  return rows[0].count;
}

describe("clearScoutData", () => {
  it("deletes handled decisions while keeping the current queue", async () => {
    const db = await seedTestData();
    await clearScoutData("decisions");

    const proposals = await db.select<{ id: string }[]>("SELECT id FROM proposals ORDER BY id;");
    expect(proposals).toEqual([{ id: "p1" }]);
    expect(await count("judgments")).toBe(0);
    expect(await count("llm_calls")).toBe(2);
  });

  it("deletes proposals, decisions, and proposal-specific model calls", async () => {
    await seedTestData();
    await clearScoutData("proposals");

    expect(await count("proposals")).toBe(0);
    expect(await count("judgments")).toBe(0);
    expect(await count("llm_calls")).toBe(1);
    expect(await count("sweeps")).toBe(1);
    expect(await count("activity")).toBe(1);
  });

  it("deletes runs without deleting proposals", async () => {
    const db = await seedTestData();
    await clearScoutData("runs");

    expect(await count("sweeps")).toBe(0);
    expect(await count("activity")).toBe(0);
    expect(await count("llm_calls")).toBe(0);
    expect(await count("proposals")).toBe(2);
    const proposals = await db.select<{ sweep_id: string | null }[]>("SELECT sweep_id FROM proposals;");
    expect(proposals[0].sweep_id).toBeNull();
  });

  it("nukes test history while keeping configuration", async () => {
    await seedTestData();
    await clearScoutData("test_data");

    for (const table of ["proposals", "judgments", "sweeps", "activity", "llm_calls"]) {
      expect(await count(table)).toBe(0);
    }
    expect(await count("connectors")).toBe(1);
    expect(await count("settings")).toBe(1);
  });
});
