-- 004: sincronização de calendário por iCal
--
-- iCal é a única integração que funciona hoje sem programa de parceiro: Airbnb,
-- Booking, Vrbo e Google exportam um feed .ics por anúncio. Importar reservas
-- alheias como bloqueio evita overbooking; exportar a agenda da hosfera evita
-- que o anúncio continue vendendo noites já reservadas.

ALTER TABLE blocks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE blocks ADD COLUMN external_uid TEXT;

-- Reimportar o mesmo feed não pode duplicar bloqueio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_external
  ON blocks (unit_id, source, external_uid)
  WHERE external_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS ical_sources (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id        TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  label          TEXT,
  last_synced_at TEXT,
  last_status    TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ical_sources_unit ON ical_sources (unit_id);

-- Token de exportação por unidade: o canal assina o feed, não precisa de login.
CREATE TABLE IF NOT EXISTS unit_feeds (
  unit_id    TEXT PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
