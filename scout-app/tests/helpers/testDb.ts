import BetterSqlite3 from "better-sqlite3";

/**
 * Minimal adapter implementing the subset of @tauri-apps/plugin-sql's
 * Database API that Scout uses, backed by a real in-memory SQLite —
 * so migrations and queries run against actual SQL in tests.
 */
export interface TestDb {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(): Promise<void>;
}

export function makeTestDb(): TestDb {
  const sqlite = new BetterSqlite3(":memory:");
  const convert = (q: string) => q.replace(/\$(\d+)/g, "?");
  return {
    async execute(query, bindValues = []) {
      const q = convert(query);
      if (bindValues.length === 0 && q.split(";").filter((s) => s.trim()).length > 1) {
        sqlite.exec(q); // multi-statement migrations
        return { rowsAffected: 0 };
      }
      const info = sqlite.prepare(q).run(...(bindValues as never[]));
      return { rowsAffected: info.changes };
    },
    async select<T>(query: string, bindValues = []): Promise<T> {
      return sqlite.prepare(convert(query)).all(...(bindValues as never[])) as T;
    },
    async close() {
      sqlite.close();
    },
  };
}
