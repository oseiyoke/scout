import { getDb, nowIso } from "./db";
import { emit } from "@tauri-apps/api/event";

export async function logActivity(line: string, sweepId: string | null = null): Promise<void> {
  const at = nowIso();
  try {
    const db = await getDb();
    await db.execute("INSERT INTO activity (sweep_id, at, line) VALUES ($1,$2,$3);", [sweepId, at, line]);
  } catch {
    // activity logging must never break a sweep
  }
  try {
    await emit("scout:activity", { sweepId, at, line });
  } catch {
    // non-tauri env (tests)
  }
}
