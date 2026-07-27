import Database from "@tauri-apps/plugin-sql";

const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'disconnected',
    last_error TEXT,
    tool_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sweeps (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    sources_summary TEXT,
    input_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    proposal_count INTEGER DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    sweep_id TEXT REFERENCES sweeps(id),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    category TEXT NOT NULL,
    urgency TEXT NOT NULL,
    confidence REAL NOT NULL,
    headline TEXT NOT NULL,
    observation TEXT NOT NULL,
    evidence TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    action_plan TEXT NOT NULL,
    draft TEXT,
    dedupe_key TEXT NOT NULL,
    decided_at TEXT,
    denial_reason TEXT,
    execution_result TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
  CREATE INDEX IF NOT EXISTS idx_proposals_dedupe ON proposals(dedupe_key);
  CREATE TABLE IF NOT EXISTS judgments (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT,
    lesson TEXT NOT NULL,
    source_proposal_id TEXT
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sweep_id TEXT,
    at TEXT NOT NULL,
    line TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_sweep ON activity(sweep_id);
  CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    sweep_id TEXT,
    proposal_id TEXT,
    at TEXT NOT NULL,
    purpose TEXT NOT NULL,
    request_json TEXT NOT NULL,
    reasoning_content TEXT,
    content TEXT,
    tool_calls_json TEXT,
    usage_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_llm_calls_sweep ON llm_calls(sweep_id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2 — remote MCP catalog + OAuth connection metadata (credentials stay outside SQLite)
  `ALTER TABLE connectors ADD COLUMN catalog_id TEXT;
  ALTER TABLE connectors ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth';
  ALTER TABLE connectors ADD COLUMN last_connected_at TEXT;
  UPDATE connectors SET auth_type='headers' WHERE catalog_id IS NULL;`,
  // v3 — GitHub's generic MCP endpoint has OAuth discovery but no DCR for Scout.
  `UPDATE connectors
   SET auth_type='bearer', status='disconnected', last_error=NULL
   WHERE catalog_id='github' AND auth_type='oauth';`,
  // v4 — keep the user-facing recommendation separate from executable tool plumbing.
  `ALTER TABLE proposals ADD COLUMN recommended_action TEXT;`,
  // v5 — approval binds execution to the exact plan that the user reviewed.
  `ALTER TABLE proposals ADD COLUMN approved_action_plan TEXT;`,
];

let dbPromise: Promise<Database> | null = null;

async function runMigrations(db: Database): Promise<Database> {
  await db.execute("PRAGMA journal_mode=WAL;");
  const versionRows = await db.select<{ user_version: number }[]>("PRAGMA user_version;");
  let version = versionRows[0]?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await db.execute(MIGRATIONS[version]);
    version += 1;
    await db.execute(`PRAGMA user_version=${version};`);
  }
  return db;
}

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:scout.db")
      .then(runMigrations)
      .catch((e) => {
        // Don't cache a rejected promise — let the next caller retry the init.
        dbPromise = null;
        throw e;
      });
  }
  return dbPromise;
}

/** Test hook: substitute an in-memory implementation; migrations run on it too. */
export function __setDbForTests(mock: () => Promise<Database>) {
  dbPromise = mock().then(runMigrations);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
