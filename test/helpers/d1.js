// A D1-compatible wrapper over node:sqlite, so tests can run real SQL and the real migrations.
// Plain JS (with d1.d.ts) because the app's TypeScript setup has Workers types, not Node's.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  args() { return this.params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p)); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args()), success: true }; }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args());
    return row === undefined ? null : col ? row[col] : row;
  }
  async run() { const r = this.db.prepare(this.sql).run(...this.args()); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; }
}

export function testD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql) => db.exec(sql),
  };
}
