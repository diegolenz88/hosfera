-- 002 — identidade, tokens e RBAC
--
-- Token é a credencial de API. Guardamos apenas o hash SHA-256: vazamento do
-- banco não vaza credencial. Um token pertence a uma organização e carrega um
-- papel — o escopo nunca vem de query string.

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_name    TEXT NOT NULL,
  role         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'default',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_org ON api_tokens (org_id, revoked_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT,
  token_id   TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
