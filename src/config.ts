import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Configuração por ambiente, com leitura opcional de `.env` (sem dependência). */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["\']|["\']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Segredo de bootstrap: cria a primeira organização e o primeiro token. */
const BOOTSTRAP_ENV = 'HOSFERA_BOOTSTRAP';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '127.0.0.1',
  databasePath: process.env.DATABASE_PATH ?? './data/hosfera.db',
  bootstrapKey: process.env[BOOTSTRAP_ENV] ?? 'dev-bootstrap',
  dispatcher: {
    intervalMs: num(process.env.DISPATCH_INTERVAL_MS, 2000),
    batchSize: num(process.env.DISPATCH_BATCH, 25),
    maxAttempts: num(process.env.MAX_ATTEMPTS, 6),
    baseBackoffMs: 1000,
    maxBackoffMs: 60_000,
  },
  enableMockChannel: (process.env.ENABLE_MOCK_CHANNEL ?? 'true') !== 'false',
} as const;

export type Config = typeof config;
