import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { nowIso } from '../db/repositories.ts';

/** Papéis do produto. `viewer` é somente leitura; `owner` administra a conta. */
export type Role = 'owner' | 'manager' | 'operations' | 'finance' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'manager', 'operations', 'finance', 'viewer'] as const;

export interface AuthContext {
  tokenId: string;
  orgId: string;
  userName: string;
  role: Role;
}

export interface TokenRecord {
  id: string;
  orgId: string;
  userName: string;
  role: Role;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Token opaco com prefixo legível. O prefixo `hsk_` existe para que um vazamento
 * em log seja detectável por varredura de segredo, e não para guardar semântica.
 */
export function generateToken(): { token: string; tokenHash: string } {
  const token = `hsk_${randomBytes(24).toString('base64url')}`;
  return { token, tokenHash: hash(token) };
}

export function createToken(
  db: Db,
  input: { orgId: string; userName: string; role: Role; label?: string },
): { token: string; record: TokenRecord } {
  if (!ROLES.includes(input.role)) throw new Error(`papel inválido: ${input.role}`);
  const { token, tokenHash } = generateToken();
  const id = randomBytes(16).toString('hex');
  const createdAt = nowIso();
  db.prepare(
    'INSERT INTO api_tokens (id, org_id, user_name, role, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.orgId, input.userName, input.role, input.label ?? 'default', tokenHash, createdAt);
  logAuth(db, input.orgId, id, 'token.created', `${input.userName}:${input.role}`);
  return {
    token,
    record: {
      id,
      orgId: input.orgId,
      userName: input.userName,
      role: input.role,
      label: input.label ?? 'default',
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

/** Resolve um token de apresentação para o contexto de autorização. */
export function resolveToken(db: Db, token: string): AuthContext | null {
  if (!token || token.length < 16) return null;
  const row = db
    .prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hash(token)) as Record<string, unknown> | undefined;
  if (!row) return null;

  const tokenId = String(row.id);
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), tokenId);
  return {
    tokenId,
    orgId: String(row.org_id),
    userName: String(row.user_name),
    role: String(row.role) as Role,
  };
}

export function listTokens(db: Db, orgId: string): TokenRecord[] {
  return (db.prepare('SELECT * FROM api_tokens WHERE org_id = ? ORDER BY created_at DESC').all(orgId) as Record<string, unknown>[]).map(
    (row) => ({
      id: String(row.id),
      orgId: String(row.org_id),
      userName: String(row.user_name),
      role: String(row.role) as Role,
      label: String(row.label),
      createdAt: String(row.created_at),
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    }),
  );
}

/** Revoga um token da própria organização. Não existe "delete": auditoria fica. */
export function revokeToken(db: Db, orgId: string, tokenId: string): boolean {
  const result = db
    .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL')
    .run(nowIso(), tokenId, orgId);
  if (Number(result.changes ?? 0) > 0) {
    logAuth(db, orgId, tokenId, 'token.revoked', null);
    return true;
  }
  return false;
}

export function logAuth(db: Db, orgId: string | null, tokenId: string | null, action: string, detail: string | null): void {
  db.prepare('INSERT INTO auth_events (id, org_id, token_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomBytes(16).toString('hex'),
    orgId,
    tokenId,
    action,
    detail,
    nowIso(),
  );
}
