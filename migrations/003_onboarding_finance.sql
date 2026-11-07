-- 003 — onboarding (fotos, comodidades, políticas) e financeiro do proprietário

ALTER TABLE properties ADD COLUMN owner_name TEXT;
ALTER TABLE properties ADD COLUMN owner_email TEXT;
-- Percentual do líquido que cabe ao proprietário; o resto é taxa de administração.
ALTER TABLE properties ADD COLUMN owner_share_pct INTEGER NOT NULL DEFAULT 70;

ALTER TABLE units ADD COLUMN capacity INTEGER NOT NULL DEFAULT 2;
ALTER TABLE units ADD COLUMN checkin_from TEXT;
ALTER TABLE units ADD COLUMN checkout_until TEXT;
ALTER TABLE units ADD COLUMN house_rules TEXT;

CREATE TABLE IF NOT EXISTS unit_amenities (
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  code    TEXT NOT NULL,
  PRIMARY KEY (unit_id, code)
);

CREATE TABLE IF NOT EXISTS unit_photos (
  id           TEXT PRIMARY KEY,
  unit_id      TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_unit ON unit_photos (unit_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_hash ON unit_photos (unit_id, sha256);
