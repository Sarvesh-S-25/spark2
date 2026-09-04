import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';

// Re-exported so callers can keep importing everything they need from one
// place; the implementations live in ../util.ts so the contract layer never
// has to pull SQLite in behind them.
export { uid, now, sha256, j, stable } from '../util.js';

const here = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

/**
 * Opens (and on first call, migrates) the SQLite file.
 *
 * Migrations are plain numbered .sql files in ./migrations. Applied names are
 * recorded in `_migration`, so adding 002_x.sql and restarting is the whole
 * upgrade story — no migration framework, nothing to learn.
 */
export function db(): Database.Database {
  if (_db) return _db;

  const path = resolve(process.cwd(), env.dbPath);
  mkdirSync(dirname(path), { recursive: true });

  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');

  conn.exec(`CREATE TABLE IF NOT EXISTS _migration (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    conn.prepare('SELECT name FROM _migration').all().map((r: any) => r.name as string),
  );

  const dir = join(here, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    })();
    console.log(`[db] applied migration ${file}`);
  }

  _db = conn;
  return conn;
}

/** Wipes and recreates the database. Used by `npm run seed`. */
export function resetDb(): void {
  const conn = db();
  const tables = conn.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).all().map((r: any) => r.name as string);
  conn.pragma('foreign_keys = OFF');
  conn.transaction(() => {
    for (const t of tables) conn.exec(`DROP TABLE IF EXISTS "${t}"`);
  })();
  conn.pragma('foreign_keys = ON');
  _db = null;
  db();
}
