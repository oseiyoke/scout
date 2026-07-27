import { getDb } from "./db";
import { connectorManager } from "./connectors";
import { deleteApiKey, deleteConnectorAuth, deleteConnectorHeaders } from "./secrets";

export type ClearDataTarget = "decisions" | "proposals" | "runs" | "test_data" | "all";

export async function exportScoutData(): Promise<string> {
  const db = await getDb();
  const tables = ["connectors", "sweeps", "proposals", "judgments", "activity", "llm_calls", "settings"];
  const data: Record<string, unknown> = { exported_at: new Date().toISOString(), format: "scout-export-v1" };
  for (const table of tables) data[table] = await db.select(`SELECT * FROM ${table};`);
  return JSON.stringify(data, null, 2);
}

/** Delete testing history while keeping connector credentials and app settings. */
export async function clearScoutData(target: ClearDataTarget): Promise<void> {
  const db = await getDb();

  if (target === "all") {
    const connectors = await db.select<{ id: string }[]>("SELECT id FROM connectors;");
    for (const connector of connectors) {
      await connectorManager.disconnect(connector.id).catch(() => undefined);
      await deleteConnectorAuth(connector.id);
      await deleteConnectorHeaders(connector.id);
    }
    await deleteApiKey();
    await db.execute("DELETE FROM judgments;");
    await db.execute("DELETE FROM llm_calls;");
    await db.execute("DELETE FROM proposals;");
    await db.execute("DELETE FROM activity;");
    await db.execute("DELETE FROM sweeps;");
    await db.execute("DELETE FROM connectors;");
    await db.execute("DELETE FROM settings;");
    return;
  }

  if (target === "decisions") {
    const decided = "status NOT IN ('proposed','failed')";
    await db.execute(`DELETE FROM judgments WHERE source_proposal_id IN (SELECT id FROM proposals WHERE ${decided});`);
    await db.execute(`DELETE FROM llm_calls WHERE proposal_id IN (SELECT id FROM proposals WHERE ${decided});`);
    await db.execute(`DELETE FROM proposals WHERE ${decided};`);
    return;
  }

  if (target === "proposals") {
    await db.execute("DELETE FROM judgments;");
    await db.execute("DELETE FROM llm_calls WHERE proposal_id IS NOT NULL;");
    await db.execute("DELETE FROM proposals;");
    return;
  }

  if (target === "runs") {
    await db.execute("UPDATE proposals SET sweep_id=NULL;");
    await db.execute("DELETE FROM activity;");
    await db.execute("DELETE FROM llm_calls;");
    await db.execute("DELETE FROM sweeps;");
    return;
  }

  await db.execute("DELETE FROM judgments;");
  await db.execute("DELETE FROM llm_calls;");
  await db.execute("DELETE FROM proposals;");
  await db.execute("DELETE FROM activity;");
  await db.execute("DELETE FROM sweeps;");
}
