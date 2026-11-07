import { randomUUID } from 'node:crypto';
import type { Db } from './database.ts';
import type {
  Block,
  CalendarDayOverride,
  Channel,
  Connection,
  ConnectionStatus,
  Currency,
  DateString,
  LedgerEntry,
  Listing,
  Organization,
  OutboxEvent,
  Property,
  RatePlan,
  Reservation,
  ReservationStatus,
  Task,
  TaskType,
  UnitPhoto,
} from '../domain/types.ts';

export const nowIso = (): string => new Date().toISOString();
const id = (): string => randomUUID();

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? '');
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const bool = (v: unknown): boolean => Number(v ?? 0) === 1;

// ───────────────────────────── organizações e inventário ─────────────────────────────

export function createOrganization(db: Db, name: string): Organization {
  const org = { id: id(), name, createdAt: nowIso() };
  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(org.id, org.name, org.createdAt);
  return org;
}

export function getOrganization(db: Db, orgId: string): Organization | null {
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId) as Row | undefined;
  return row ? { id: str(row.id), name: str(row.name), createdAt: str(row.created_at) } : null;
}

export interface PropertyInput {
  orgId: string;
  name: string;
  city?: string | null;
  state?: string | null;
  country?: string;
  address?: string | null;
  timezone?: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** Percentual do líquido que cabe ao proprietário (0–100). */
  ownerSharePct?: number;
}

export function mapProperty(row: Row): Property {
  return {
    id: str(row.id),
    orgId: str(row.org_id),
    name: str(row.name),
    city: strOrNull(row.city),
    state: strOrNull(row.state),
    country: str(row.country),
    address: strOrNull(row.address),
    timezone: str(row.timezone),
    ownerName: strOrNull(row.owner_name),
    ownerEmail: strOrNull(row.owner_email),
    ownerSharePct: num(row.owner_share_pct ?? 70),
    createdAt: str(row.created_at),
  };
}

export function createProperty(db: Db, input: PropertyInput): Property {
  const p: Property = {
    id: id(),
    orgId: input.orgId,
    name: input.name,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country ?? 'BR',
    address: input.address ?? null,
    timezone: input.timezone ?? 'America/Sao_Paulo',
    ownerName: input.ownerName ?? null,
    ownerEmail: input.ownerEmail ?? null,
    ownerSharePct: input.ownerSharePct ?? 70,
    createdAt: nowIso(),
  };
  if (p.ownerSharePct < 0 || p.ownerSharePct > 100) throw new Error('ownerSharePct deve estar entre 0 e 100');
  db.prepare(
    `INSERT INTO properties (id, org_id, name, city, state, country, address, timezone, owner_name, owner_email, owner_share_pct, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id, p.orgId, p.name, p.city, p.state, p.country, p.address, p.timezone,
    p.ownerName, p.ownerEmail, p.ownerSharePct, p.createdAt,
  );
  return p;
}

export function listProperties(db: Db, orgId: string): Property[] {
  return (db.prepare('SELECT * FROM properties WHERE org_id = ? ORDER BY name').all(orgId) as Row[]).map(mapProperty);
}

export function getProperty(db: Db, propertyId: string): Property | null {
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId) as Row | undefined;
  return row ? mapProperty(row) : null;
}

export interface UnitInput {
  propertyId: string;
  name: string;
  inventory?: number;
  currency?: Currency;
  minStay?: number;
  maxStay?: number;
  capacity?: number;
  checkinFrom?: string | null;
  checkoutUntil?: string | null;
  houseRules?: string | null;
}

export function createUnit(db: Db, input: UnitInput): UnitRow {
  const unit: UnitRow = {
    id: id(),
    propertyId: input.propertyId,
    name: input.name,
    inventory: input.inventory ?? 1,
    currency: input.currency ?? 'BRL',
    minStay: input.minStay ?? 1,
    maxStay: input.maxStay ?? 365,
    capacity: input.capacity ?? 2,
    checkinFrom: input.checkinFrom ?? null,
    checkoutUntil: input.checkoutUntil ?? null,
    houseRules: input.houseRules ?? null,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO units (id, property_id, name, inventory, currency, min_stay, max_stay, capacity, checkin_from, checkout_until, house_rules, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    unit.id, unit.propertyId, unit.name, unit.inventory, unit.currency, unit.minStay, unit.maxStay,
    unit.capacity, unit.checkinFrom, unit.checkoutUntil, unit.houseRules, unit.createdAt,
  );
  return unit;
}

export type UnitRow = {
  id: string;
  propertyId: string;
  name: string;
  inventory: number;
  currency: Currency;
  minStay: number;
  maxStay: number;
  capacity: number;
  checkinFrom: string | null;
  checkoutUntil: string | null;
  houseRules: string | null;
  createdAt: string;
};

export function mapUnit(row: Row): UnitRow {
  return {
    id: str(row.id),
    propertyId: str(row.property_id),
    name: str(row.name),
    inventory: num(row.inventory),
    currency: str(row.currency) as Currency,
    minStay: num(row.min_stay),
    maxStay: num(row.max_stay),
    capacity: num(row.capacity ?? 2),
    checkinFrom: strOrNull(row.checkin_from),
    checkoutUntil: strOrNull(row.checkout_until),
    houseRules: strOrNull(row.house_rules),
    createdAt: str(row.created_at),
  };
}

export function getUnit(db: Db, unitId: string): UnitRow | null {
  const row = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId) as Row | undefined;
  return row ? mapUnit(row) : null;
}

export function listUnits(db: Db, propertyId: string): UnitRow[] {
  return (db.prepare('SELECT * FROM units WHERE property_id = ? ORDER BY name').all(propertyId) as Row[]).map(mapUnit);
}

export interface RatePlanInput {
  unitId: string;
  name: string;
  basePriceCents: number;
  weekendUpliftPct?: number;
  cleaningFeeCents?: number;
  minStay?: number;
  currency?: Currency;
  cancellationPolicy?: RatePlan['cancellationPolicy'];
}

export function createRatePlan(db: Db, input: RatePlanInput): RatePlan {
  const plan: RatePlan = {
    id: id(),
    unitId: input.unitId,
    name: input.name,
    basePriceCents: input.basePriceCents,
    weekendUpliftPct: input.weekendUpliftPct ?? 0,
    cleaningFeeCents: input.cleaningFeeCents ?? 0,
    minStay: input.minStay ?? 1,
    currency: input.currency ?? 'BRL',
    cancellationPolicy: input.cancellationPolicy ?? 'flexible',
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO rate_plans (id, unit_id, name, base_price_cents, weekend_uplift_pct, cleaning_fee_cents, min_stay, currency, cancellation_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id, plan.unitId, plan.name, plan.basePriceCents, plan.weekendUpliftPct,
    plan.cleaningFeeCents, plan.minStay, plan.currency, plan.cancellationPolicy, plan.createdAt,
  );
  return plan;
}

export function getRatePlan(db: Db, ratePlanId: string): RatePlan | null {
  const row = db.prepare('SELECT * FROM rate_plans WHERE id = ?').get(ratePlanId) as Row | undefined;
  if (!row) return null;
  return {
    id: str(row.id),
    unitId: str(row.unit_id),
    name: str(row.name),
    basePriceCents: num(row.base_price_cents),
    weekendUpliftPct: num(row.weekend_uplift_pct),
    cleaningFeeCents: num(row.cleaning_fee_cents),
    minStay: num(row.min_stay),
    currency: str(row.currency) as Currency,
    cancellationPolicy: str(row.cancellation_policy) as RatePlan['cancellationPolicy'],
    createdAt: str(row.created_at),
  };
}

export function listRatePlans(db: Db, unitId: string): RatePlan[] {
  return (db.prepare('SELECT * FROM rate_plans WHERE unit_id = ? ORDER BY name').all(unitId) as Row[]).map((row) => ({
    id: str(row.id),
    unitId: str(row.unit_id),
    name: str(row.name),
    basePriceCents: num(row.base_price_cents),
    weekendUpliftPct: num(row.weekend_uplift_pct),
    cleaningFeeCents: num(row.cleaning_fee_cents),
    minStay: num(row.min_stay),
    currency: str(row.currency) as Currency,
    cancellationPolicy: str(row.cancellation_policy) as RatePlan['cancellationPolicy'],
    createdAt: str(row.created_at),
  }));
}

// ───────────────────────────── conexões e anúncios ─────────────────────────────

export function createConnection(
  db: Db,
  input: { orgId: string; channel: Channel; label: string; status?: ConnectionStatus; externalAccount?: string | null },
): Connection {
  const conn: Connection = {
    id: id(),
    orgId: input.orgId,
    channel: input.channel,
    label: input.label,
    status: input.status ?? 'pending',
    externalAccount: input.externalAccount ?? null,
    createdAt: nowIso(),
  };
  db.prepare(
    'INSERT INTO connections (id, org_id, channel, label, status, external_account, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(conn.id, conn.orgId, conn.channel, conn.label, conn.status, conn.externalAccount, conn.createdAt);
  return conn;
}

const mapConnection = (row: Row): Connection => ({
  id: str(row.id),
  orgId: str(row.org_id),
  channel: str(row.channel) as Channel,
  label: str(row.label),
  status: str(row.status) as ConnectionStatus,
  externalAccount: strOrNull(row.external_account),
  createdAt: str(row.created_at),
});

export function getConnection(db: Db, connectionId: string): Connection | null {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as Row | undefined;
  return row ? mapConnection(row) : null;
}

export function listConnections(db: Db, orgId: string): Connection[] {
  return (db.prepare('SELECT * FROM connections WHERE org_id = ? ORDER BY channel').all(orgId) as Row[]).map(mapConnection);
}

export function setConnectionStatus(db: Db, connectionId: string, status: ConnectionStatus): void {
  db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(status, connectionId);
}

export function createListing(
  db: Db,
  input: { unitId: string; connectionId: string; externalId?: string | null },
): Listing {
  const listing: Listing = {
    id: id(),
    unitId: input.unitId,
    connectionId: input.connectionId,
    externalId: input.externalId ?? null,
    status: 'draft',
    publishedAt: null,
    lastSyncAt: null,
    createdAt: nowIso(),
  };
  db.prepare(
    'INSERT INTO listings (id, unit_id, connection_id, external_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(listing.id, listing.unitId, listing.connectionId, listing.externalId, listing.status, listing.createdAt);
  return listing;
}

const mapListing = (row: Row): Listing => ({
  id: str(row.id),
  unitId: str(row.unit_id),
  connectionId: str(row.connection_id),
  externalId: strOrNull(row.external_id),
  status: str(row.status) as Listing['status'],
  publishedAt: strOrNull(row.published_at),
  lastSyncAt: strOrNull(row.last_sync_at),
  createdAt: str(row.created_at),
});

export function getListing(db: Db, listingId: string): Listing | null {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId) as Row | undefined;
  return row ? mapListing(row) : null;
}

export function listListingsByUnit(db: Db, unitId: string): Listing[] {
  return (db.prepare('SELECT * FROM listings WHERE unit_id = ? ORDER BY created_at').all(unitId) as Row[]).map(mapListing);
}

export function listPublishedListingsByUnit(db: Db, unitId: string): Listing[] {
  return (
    db.prepare("SELECT * FROM listings WHERE unit_id = ? AND status = 'published'").all(unitId) as Row[]
  ).map(mapListing);
}

export function listAllListings(db: Db, orgId: string): Listing[] {
  return (
    db
      .prepare(
        `SELECT l.* FROM listings l
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE p.org_id = ? ORDER BY l.created_at`,
      )
      .all(orgId) as Row[]
  ).map(mapListing);
}

export function markListingPublished(db: Db, listingId: string, externalId: string): void {
  db.prepare("UPDATE listings SET status = 'published', external_id = ?, published_at = ?, last_sync_at = ? WHERE id = ?")
    .run(externalId, nowIso(), nowIso(), listingId);
}

export function touchListingSync(db: Db, listingId: string): void {
  db.prepare('UPDATE listings SET last_sync_at = ? WHERE id = ?').run(nowIso(), listingId);
}

// ───────────────────────────── calendário ─────────────────────────────

export interface CalendarUpsert {
  unitId: string;
  date: DateString;
  available?: number | null;
  rateCents?: number | null;
  minStay?: number | null;
  closed?: boolean;
}

/**
 * Upsert parcial: campos ausentes preservam o valor atual (COALESCE).
 * É o que permite enviar só preço sem apagar disponibilidade e vice-versa.
 */
export function upsertCalendarDays(db: Db, days: CalendarUpsert[]): number {
  const stmt = db.prepare(
    `INSERT INTO calendar_days (unit_id, date, available, rate_cents, min_stay, closed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (unit_id, date) DO UPDATE SET
       available  = COALESCE(excluded.available, calendar_days.available),
       rate_cents = COALESCE(excluded.rate_cents, calendar_days.rate_cents),
       min_stay   = COALESCE(excluded.min_stay, calendar_days.min_stay),
       closed     = excluded.closed,
       updated_at = excluded.updated_at`,
  );
  const now = nowIso();
  for (const d of days) {
    stmt.run(d.unitId, d.date, d.available ?? null, d.rateCents ?? null, d.minStay ?? null, d.closed ? 1 : 0, now);
  }
  return days.length;
}

export function listCalendarOverrides(db: Db, unitId: string, from: DateString, to: DateString): CalendarDayOverride[] {
  return (
    db
      .prepare('SELECT * FROM calendar_days WHERE unit_id = ? AND date >= ? AND date < ? ORDER BY date')
      .all(unitId, from, to) as Row[]
  ).map((row) => ({
    unitId: str(row.unit_id),
    date: str(row.date),
    available: row.available === null ? null : num(row.available),
    rateCents: row.rate_cents === null ? null : num(row.rate_cents),
    minStay: row.min_stay === null ? null : num(row.min_stay),
    closed: bool(row.closed),
    updatedAt: str(row.updated_at),
  }));
}

export function createBlock(db: Db, input: Omit<Block, 'id' | 'createdAt'>): Block {
  const block: Block = { ...input, id: id(), createdAt: nowIso() };
  db.prepare('INSERT INTO blocks (id, unit_id, start_date, end_date, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(block.id, block.unitId, block.startDate, block.endDate, block.reason, block.createdAt);
  return block;
}

export function listBlocks(db: Db, unitId: string, from: DateString, to: DateString): Block[] {
  return (
    db
      .prepare('SELECT * FROM blocks WHERE unit_id = ? AND end_date > ? AND start_date < ? ORDER BY start_date')
      .all(unitId, from, to) as Row[]
  ).map((row) => ({
    id: str(row.id),
    unitId: str(row.unit_id),
    startDate: str(row.start_date),
    endDate: str(row.end_date),
    reason: strOrNull(row.reason),
    createdAt: str(row.created_at),
  }));
}

// ───────────────────────────── reservas ─────────────────────────────

export interface ReservationUpsert {
  orgId: string;
  connectionId: string;
  externalId: string;
  unitId: string;
  guestName: string | null;
  guestEmail: string | null;
  checkin: DateString;
  checkout: DateString;
  guests: number;
  status: ReservationStatus;
  /** `null` preserva o valor já gravado (webhook parcial). */
  totalCents: number | null;
  commissionCents: number | null;
  currency: Currency;
  channel: Channel;
}

/** Upsert idempotente por (connection_id, external_id): reprocessar webhook não duplica. */
export function upsertReservation(db: Db, input: ReservationUpsert): { reservation: Reservation; inserted: boolean } {
  const existing = db
    .prepare('SELECT * FROM reservations WHERE connection_id = ? AND external_id = ?')
    .get(input.connectionId, input.externalId) as Row | undefined;

  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE reservations SET unit_id = ?, guest_name = ?, guest_email = ?, checkin = ?, checkout = ?,
        guests = ?, status = ?, total_cents = ?, commission_cents = ?, currency = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.unitId, input.guestName, input.guestEmail, input.checkin, input.checkout, input.guests,
      input.status,
      input.totalCents ?? num(existing.total_cents),
      input.commissionCents ?? num(existing.commission_cents),
      input.currency, now, str(existing.id),
    );
    return { reservation: getReservation(db, str(existing.id))!, inserted: false };
  }

  const reservation: Reservation = {
    id: id(),
    ...input,
    totalCents: input.totalCents ?? 0,
    commissionCents: input.commissionCents ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO reservations (id, org_id, connection_id, external_id, unit_id, guest_name, guest_email, checkin,
      checkout, guests, status, total_cents, commission_cents, currency, channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reservation.id, reservation.orgId, reservation.connectionId, reservation.externalId, reservation.unitId,
    reservation.guestName, reservation.guestEmail, reservation.checkin, reservation.checkout, reservation.guests,
    reservation.status, reservation.totalCents, reservation.commissionCents, reservation.currency,
    reservation.channel, reservation.createdAt, reservation.updatedAt,
  );
  return { reservation, inserted: true };
}

const mapReservation = (row: Row): Reservation => ({
  id: str(row.id),
  orgId: str(row.org_id),
  connectionId: str(row.connection_id),
  externalId: str(row.external_id),
  unitId: str(row.unit_id),
  guestName: strOrNull(row.guest_name),
  guestEmail: strOrNull(row.guest_email),
  checkin: str(row.checkin),
  checkout: str(row.checkout),
  guests: num(row.guests),
  status: str(row.status) as ReservationStatus,
  totalCents: num(row.total_cents),
  commissionCents: num(row.commission_cents),
  currency: str(row.currency) as Currency,
  channel: str(row.channel) as Channel,
  createdAt: str(row.created_at),
  updatedAt: str(row.updated_at),
});

export function getReservation(db: Db, reservationId: string): Reservation | null {
  const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as Row | undefined;
  return row ? mapReservation(row) : null;
}

export function listReservationsByUnit(
  db: Db,
  unitId: string,
  from: DateString,
  to: DateString,
): Reservation[] {
  return (
    db
      .prepare('SELECT * FROM reservations WHERE unit_id = ? AND checkout > ? AND checkin < ? ORDER BY checkin')
      .all(unitId, from, to) as Row[]
  ).map(mapReservation);
}

export function listReservations(db: Db, orgId: string, limit = 50): Reservation[] {
  return (
    db.prepare('SELECT * FROM reservations WHERE org_id = ? ORDER BY checkin DESC LIMIT ?').all(orgId, limit) as Row[]
  ).map(mapReservation);
}

export function setReservationStatus(db: Db, reservationId: string, status: ReservationStatus): void {
  db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), reservationId);
}

// ───────────────────────────── tarefas e financeiro ─────────────────────────────

export function ensureTasks(db: Db, reservationId: string, unitId: string, tasks: Pick<Task, 'type' | 'dueDate'>[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tasks (id, reservation_id, unit_id, type, due_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const now = nowIso();
  let inserted = 0;
  for (const task of tasks) {
    const result = stmt.run(id(), reservationId, unitId, task.type satisfies TaskType, task.dueDate, now);
    inserted += Number(result.changes ?? 0);
  }
  return inserted;
}

export function listTasks(db: Db, opts: { reservationId?: string; orgId?: string; status?: string }): Task[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.reservationId) {
    clauses.push('t.reservation_id = ?');
    params.push(opts.reservationId);
  }
  if (opts.orgId) {
    clauses.push('r.org_id = ?');
    params.push(opts.orgId);
  }
  if (opts.status) {
    clauses.push('t.status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT t.* FROM tasks t JOIN reservations r ON r.id = t.reservation_id ${where} ORDER BY t.due_date`)
    .all(...params) as Row[];
  return rows.map((row) => ({
    id: str(row.id),
    reservationId: str(row.reservation_id),
    unitId: str(row.unit_id),
    type: str(row.type) as TaskType,
    dueDate: str(row.due_date),
    status: str(row.status) as Task['status'],
    assignee: strOrNull(row.assignee),
    createdAt: str(row.created_at),
  }));
}

export function addLedgerEntry(
  db: Db,
  input: Omit<LedgerEntry, 'id'>,
): LedgerEntry {
  const entry: LedgerEntry = { ...input, id: id() };
  db.prepare(
    'INSERT INTO ledger_entries (id, reservation_id, kind, amount_cents, currency, occurred_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(entry.id, entry.reservationId, entry.kind, entry.amountCents, entry.currency, entry.occurredAt, entry.metaJson);
  return entry;
}

export function listLedger(db: Db, reservationId: string): LedgerEntry[] {
  return (db.prepare('SELECT * FROM ledger_entries WHERE reservation_id = ? ORDER BY kind').all(reservationId) as Row[]).map(
    (row) => ({
      id: str(row.id),
      reservationId: str(row.reservation_id),
      kind: str(row.kind) as LedgerEntry['kind'],
      amountCents: num(row.amount_cents),
      currency: str(row.currency) as Currency,
      occurredAt: str(row.occurred_at),
      metaJson: strOrNull(row.meta_json),
    }),
  );
}

// ───────────────────────────── outbox ─────────────────────────────

export interface OutboxInput {
  connectionId: string;
  listingId?: string | null;
  unitId?: string | null;
  type: OutboxEvent['type'];
  payload: unknown;
  idempotencyKey: string;
  /** ISO de quando pode ser tentado pela primeira vez. */
  nextAttemptAt?: string;
}

/** Enfileira respeitando (connection_id, idempotency_key): repetir não duplica trabalho. */
export function enqueue(db: Db, input: OutboxInput): { event: OutboxEvent; created: boolean } {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, connection_id, listing_id, unit_id, type, payload_json, idempotency_key,
        status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(
      id(), input.connectionId, input.listingId ?? null, input.unitId ?? null, input.type,
      JSON.stringify(input.payload), input.idempotencyKey, input.nextAttemptAt ?? now, now, now,
    );
  const row = db
    .prepare('SELECT * FROM outbox WHERE connection_id = ? AND idempotency_key = ?')
    .get(input.connectionId, input.idempotencyKey) as Row;
  return { event: mapOutbox(row), created: Number(result.changes ?? 0) > 0 };
}

const mapOutbox = (row: Row): OutboxEvent => ({
  id: str(row.id),
  connectionId: str(row.connection_id),
  listingId: strOrNull(row.listing_id),
  unitId: strOrNull(row.unit_id),
  type: str(row.type) as OutboxEvent['type'],
  payloadJson: str(row.payload_json),
  idempotencyKey: str(row.idempotency_key),
  status: str(row.status) as OutboxEvent['status'],
  attempts: num(row.attempts),
  nextAttemptAt: str(row.next_attempt_at),
  lastError: strOrNull(row.last_error),
  createdAt: str(row.created_at),
  updatedAt: str(row.updated_at),
});

export function dueEvents(db: Db, limit: number, now = nowIso()): OutboxEvent[] {
  return (
    db
      .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
      .all(now, limit) as Row[]
  ).map(mapOutbox);
}

export function markEventSent(db: Db, eventId: string): void {
  db.prepare("UPDATE outbox SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), eventId);
}

/**
 * Registra uma tentativa que falhou.
 *
 * Retry volta para 'pending' com `next_attempt_at` no futuro — só assim o
 * dispatcher volta a pegá-lo. 'dead' é terminal e exige ação humana.
 */
export function markEventRetry(
  db: Db,
  eventId: string,
  error: string,
  attempts: number,
  nextAttemptAt: string,
  dead: boolean,
): void {
  db.prepare("UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
    .run(dead ? 'dead' : 'pending', attempts, error.slice(0, 500), nextAttemptAt, nowIso(), eventId);
}

export function requeueEvent(db: Db, eventId: string): void {
  db.prepare("UPDATE outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), eventId);
}

export function listOutbox(db: Db, opts: { connectionId?: string; status?: string; limit?: number }): OutboxEvent[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.connectionId) {
    clauses.push('connection_id = ?');
    params.push(opts.connectionId);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(opts.limit ?? 100);
  return (
    db.prepare(`SELECT * FROM outbox ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as Row[]
  ).map(mapOutbox);
}

export function outboxStats(db: Db): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS total FROM outbox GROUP BY status').all() as Row[];
  const out: Record<string, number> = { pending: 0, sent: 0, failed: 0, dead: 0 };
  for (const row of rows) out[str(row.status)] = num(row.total);
  return out;
}

// ───────────────────────────── auditoria ─────────────────────────────

export function logEvent(db: Db, scope: string, refId: string | null, type: string, payload: unknown): void {
  db.prepare('INSERT INTO event_log (id, scope, ref_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id(), scope, refId, type, JSON.stringify(payload), nowIso());
}

export function listEventLog(db: Db, scope: string, refId: string | null, limit = 100): unknown[] {
  const rows = refId
    ? (db.prepare('SELECT * FROM event_log WHERE scope = ? AND ref_id = ? ORDER BY created_at DESC LIMIT ?').all(scope, refId, limit) as Row[])
    : (db.prepare('SELECT * FROM event_log WHERE scope = ? ORDER BY created_at DESC LIMIT ?').all(scope, limit) as Row[]);
  return rows.map((row) => ({
    id: str(row.id),
    scope: str(row.scope),
    refId: strOrNull(row.ref_id),
    type: str(row.type),
    payload: JSON.parse(str(row.payload_json || 'null')),
    createdAt: str(row.created_at),
  }));
}

// ───────────────────────────── comodidades e fotos ─────────────────────────────

export function setAmenities(db: Db, unitId: string, codes: string[]): string[] {
  const insert = db.prepare('INSERT OR IGNORE INTO unit_amenities (unit_id, code) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM unit_amenities WHERE unit_id = ? AND code = ?');
  const current = new Set(listAmenities(db, unitId));
  const next = new Set(codes);
  for (const code of next) if (!current.has(code)) insert.run(unitId, code);
  for (const code of current) if (!next.has(code)) remove.run(unitId, code);
  return [...next].sort();
}

export function listAmenities(db: Db, unitId: string): string[] {
  return (db.prepare('SELECT code FROM unit_amenities WHERE unit_id = ? ORDER BY code').all(unitId) as Row[]).map((row) =>
    str(row.code),
  );
}

export function copyAmenities(db: Db, fromUnitId: string, toUnitId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO unit_amenities (unit_id, code) SELECT ?, code FROM unit_amenities WHERE unit_id = ?',
  ).run(toUnitId, fromUnitId);
}

const mapPhoto = (row: Row): UnitPhoto => ({
  id: str(row.id),
  unitId: str(row.unit_id),
  position: num(row.position),
  contentType: str(row.content_type),
  bytes: num(row.bytes),
  sha256: str(row.sha256),
  createdAt: str(row.created_at),
});

export function insertPhoto(db: Db, input: Omit<UnitPhoto, 'id' | 'createdAt'>): { photo: UnitPhoto; created: boolean } {
  const existing = db
    .prepare('SELECT * FROM unit_photos WHERE unit_id = ? AND sha256 = ?')
    .get(input.unitId, input.sha256) as Row | undefined;
  if (existing) return { photo: mapPhoto(existing), created: false };

  const photo: UnitPhoto = { ...input, id: id(), createdAt: nowIso() };
  db.prepare(
    'INSERT INTO unit_photos (id, unit_id, position, content_type, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(photo.id, photo.unitId, photo.position, photo.contentType, photo.bytes, photo.sha256, photo.createdAt);
  return { photo, created: true };
}

export function nextPhotoPosition(db: Db, unitId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM unit_photos WHERE unit_id = ?').get(unitId) as Row;
  return num(row.next);
}

export function listPhotos(db: Db, unitId: string): UnitPhoto[] {
  return (db.prepare('SELECT * FROM unit_photos WHERE unit_id = ? ORDER BY position, created_at').all(unitId) as Row[]).map(
    mapPhoto,
  );
}

export function getPhoto(db: Db, photoId: string): UnitPhoto | null {
  const row = db.prepare('SELECT * FROM unit_photos WHERE id = ?').get(photoId) as Row | undefined;
  return row ? mapPhoto(row) : null;
}

export function deletePhoto(db: Db, photoId: string): boolean {
  const result = db.prepare('DELETE FROM unit_photos WHERE id = ?').run(photoId);
  return Number(result.changes ?? 0) > 0;
}

// ───────────────────────────── consultas financeiras ─────────────────────────────

export function listReservationsByRange(db: Db, orgId: string, from: DateString, to: DateString): Reservation[] {
  return (
    db
      .prepare(
        `SELECT * FROM reservations
         WHERE org_id = ? AND status != 'cancelled' AND checkin < ? AND checkout > ?
         ORDER BY checkin`,
      )
      .all(orgId, to, from) as Row[]
  ).map(mapReservation);
}

export function listUnitsByOrg(db: Db, orgId: string): (UnitRow & { propertyName: string })[] {
  return (
    db
      .prepare(
        `SELECT u.*, p.name AS property_name FROM units u
         JOIN properties p ON p.id = u.property_id
         WHERE p.org_id = ? ORDER BY p.name, u.name`,
      )
      .all(orgId) as Row[]
  ).map((row) => ({ ...mapUnit(row), propertyName: str(row.property_name) }));
}

export function reservationsWithLedger(db: Db, orgId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT l.reservation_id FROM ledger_entries l
       JOIN reservations r ON r.id = l.reservation_id
       WHERE r.org_id = ?`,
    )
    .all(orgId) as Row[];
  return new Set(rows.map((row) => str(row.reservation_id)));
}
