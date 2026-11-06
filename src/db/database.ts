import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/**
 * Abre o banco e aplica o esquema (idempotente).
 *
 * SQLite no desenvolvimento; Postgres em produção (ver docs/adr/0002).
 * Toda escrita da aplicação passa por prepared statements — nada de SQL concatenado.
 */
export function openDatabase(path = ':memory:'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
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
