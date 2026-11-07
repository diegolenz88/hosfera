import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

export type Db = DatabaseSync;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica migrations versionadas de `migrations/` em ordem lexicográfica.
 *
 * Substitui o `schema.sql` idempotente: a partir do primeiro dado real, mudar
 * esquema exige arquivo novo — nunca editar o anterior. O registro fica em
 * `schema_migrations` e cada arquivo roda dentro de uma transação.
 */
export function migrate(db: Db, dir = MIGRATIONS_DIR): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[];
  const already = new Set(appliedRows.map((row) => row.version));
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (already.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
      result.applied.push(file);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`falha ao aplicar migration ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}

/** Abre o banco e garante o esquema na versão mais recente. */
export function openDatabase(path = ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Executa uma função dentro de uma transação. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
