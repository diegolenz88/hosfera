import type { Role } from './tokens.ts';

/**
 * Ações que exigem autorização explícita.
 *
 * A matriz é a fonte da verdade: se a ação não está listada para o papel, a
 * requisição é recusada com 403 — não existe "admin implícito".
 */
export type Action =
  | 'org:read'
  | 'org:write'
  | 'property:write'
  | 'unit:write'
  | 'rate:write'
  | 'ari:write'
  | 'block:write'
  | 'connection:write'
  | 'listing:write'
  | 'listing:publish'
  | 'reservation:read'
  | 'reservation:write'
  | 'task:write'
  | 'finance:read'
  | 'outbox:read'
  | 'outbox:dispatch'
  | 'token:manage'
  | 'audit:read';

const MATRIX: Record<Role, readonly Action[]> = {
  owner: [
    'org:read', 'org:write', 'property:write', 'unit:write', 'rate:write', 'ari:write', 'block:write',
    'connection:write', 'listing:write', 'listing:publish', 'reservation:read', 'reservation:write',
    'task:write', 'finance:read', 'outbox:read', 'outbox:dispatch', 'token:manage', 'audit:read',
  ],
  manager: [
    'org:read', 'property:write', 'unit:write', 'rate:write', 'ari:write', 'block:write', 'connection:write',
    'listing:write', 'listing:publish', 'reservation:read', 'reservation:write', 'task:write',
    'finance:read', 'outbox:read', 'outbox:dispatch', 'audit:read',
  ],
  operations: ['org:read', 'reservation:read', 'reservation:write', 'task:write', 'ari:write', 'block:write'],
  finance: ['org:read', 'reservation:read', 'finance:read'],
  viewer: ['org:read', 'reservation:read'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role]?.includes(action) ?? false;
}

/** Permissões efetivas do papel — usado pela UI para esconder ações. */
export function permissionsFor(role: Role): readonly Action[] {
  return MATRIX[role] ?? [];
}
