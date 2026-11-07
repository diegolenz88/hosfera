-- hosfera — esquema canônico (SQLite para desenvolvimento; migra para Postgres)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  city        TEXT,
  state       TEXT,
  country     TEXT NOT NULL DEFAULT 'BR',
  address     TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  inventory        INTEGER NOT NULL DEFAULT 1,
  currency         TEXT NOT NULL DEFAULT 'BRL',
  min_stay         INTEGER NOT NULL DEFAULT 1,
  max_stay         INTEGER NOT NULL DEFAULT 365,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_plans (
  id                   TEXT PRIMARY KEY,
  unit_id              TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  base_price_cents     INTEGER NOT NULL,
  weekend_uplift_pct   INTEGER NOT NULL DEFAULT 0,
  cleaning_fee_cents   INTEGER NOT NULL DEFAULT 0,
  min_stay             INTEGER NOT NULL DEFAULT 1,
  currency             TEXT NOT NULL DEFAULT 'BRL',
  cancellation_policy  TEXT NOT NULL DEFAULT 'flexible',
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL,
  label          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  external_account TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, channel, label)
);

CREATE TABLE IF NOT EXISTS listings (
  id            TEXT PRIMARY KEY,
  unit_id       TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  published_at  TEXT,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (connection_id, external_id)
);

CREATE TABLE IF NOT EXISTS calendar_days (
  unit_id      TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  available    INTEGER,
  rate_cents   INTEGER,
  min_stay     INTEGER,
  closed       INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (unit_id, date)
);

CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id    TEXT NOT NULL REFERENCES connections(id),
  external_id      TEXT NOT NULL,
  unit_id          TEXT NOT NULL REFERENCES units(id),
  guest_name       TEXT,
  guest_email      TEXT,
  checkin          TEXT NOT NULL,
  checkout         TEXT NOT NULL,
  guests           INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL,
  total_cents      INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'BRL',
  channel          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (connection_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_res_unit_dates ON reservations (unit_id, checkin, checkout);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  unit_id        TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  assignee       TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (reservation_id, type)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  meta_json      TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  listing_id      TEXT,
  unit_id         TEXT,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (connection_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS event_log (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  ref_id       TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL
);
