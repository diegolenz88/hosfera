/**
 * Modelo canônico da hosfera.
 *
 * Regra do projeto: nenhum tipo deste arquivo pode depender do payload de uma OTA.
 * Adaptadores traduzem o formato do canal para estes tipos e vice-versa.
 */

export type Id = string;

/** Canais suportados pelo channel manager. */
export type Channel =
  | 'mock'
  | 'booking'
  | 'airbnb'
  | 'decolar'
  | 'expedia'
  | 'vrbo'
  | 'google';

export const CHANNELS: readonly Channel[] = [
  'mock',
  'booking',
  'airbnb',
  'decolar',
  'expedia',
  'vrbo',
  'google',
] as const;

/** Data de calendário no formato YYYY-MM-DD (sem hora, sem timezone). */
export type DateString = string;
/** Instante ISO-8601 em UTC. */
export type Timestamp = string;

export type Currency = 'BRL' | 'USD' | 'EUR';

export interface Organization {
  id: Id;
  name: string;
  createdAt: Timestamp;
}

export interface Property {
  id: Id;
  orgId: Id;
  name: string;
  city: string | null;
  state: string | null;
  country: string;
  address: string | null;
  timezone: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Percentual do líquido que cabe ao proprietário. */
  ownerSharePct: number;
  createdAt: Timestamp;
}

export interface Unit {
  id: Id;
  propertyId: Id;
  name: string;
  /** Quantidade de unidades vendáveis deste tipo (inventário). */
  inventory: number;
  currency: Currency;
  minStay: number;
  maxStay: number;
  /** Capacidade máxima de hóspedes. */
  capacity: number;
  checkinFrom: string | null;
  checkoutUntil: string | null;
  houseRules: string | null;
  createdAt: Timestamp;
}

export interface UnitPhoto {
  id: Id;
  unitId: Id;
  position: number;
  contentType: string;
  bytes: number;
  sha256: string;
  createdAt: Timestamp;
}

export interface RatePlan {
  id: Id;
  unitId: Id;
  name: string;
  basePriceCents: number;
  /** Acréscimo percentual em sexta/sábado. */
  weekendUpliftPct: number;
  cleaningFeeCents: number;
  minStay: number;
  currency: Currency;
  cancellationPolicy: 'flexible' | 'moderate' | 'strict' | 'non_refundable';
  createdAt: Timestamp;
}

export type ConnectionStatus = 'pending' | 'active' | 'error' | 'disabled';

export interface Connection {
  id: Id;
  orgId: Id;
  channel: Channel;
  label: string;
  status: ConnectionStatus;
  externalAccount: string | null;
  createdAt: Timestamp;
}

export type ListingStatus = 'draft' | 'published' | 'paused' | 'error';

/** Vínculo entre uma unidade interna e um anúncio no canal. */
export interface Listing {
  id: Id;
  unitId: Id;
  connectionId: Id;
  externalId: string | null;
  status: ListingStatus;
  publishedAt: Timestamp | null;
  lastSyncAt: Timestamp | null;
  createdAt: Timestamp;
}

/** Exceção de preço/disponibilidade para um dia específico. */
export interface CalendarDayOverride {
  unitId: Id;
  date: DateString;
  available: number | null;
  rateCents: number | null;
  minStay: number | null;
  closed: boolean;
  updatedAt: Timestamp;
}

export interface Block {
  id: Id;
  unitId: Id;
  startDate: DateString;
  endDate: DateString;
  reason: string | null;
  /** 'manual' ou `ical:<sourceId>` — quem criou o bloqueio. */
  source: string;
  /** UID do evento no feed de origem; null em bloqueio manual. */
  externalUid: string | null;
  createdAt: Timestamp;
}

export interface ICalSource {
  id: Id;
  orgId: Id;
  unitId: Id;
  url: string;
  label: string | null;
  lastSyncedAt: Timestamp | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: Timestamp;
}

export type ReservationStatus =
  | 'pending'
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled'
  | 'no_show';

/** Status que ainda ocupam o inventário. */
export const OCCUPYING_STATUSES: readonly ReservationStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
] as const;

export interface Reservation {
  id: Id;
  orgId: Id;
  connectionId: Id;
  externalId: string;
  unitId: Id;
  guestName: string | null;
  guestEmail: string | null;
  /** Primeira noite ocupada (inclusive). */
  checkin: DateString;
  /** Data de saída (exclusiva). */
  checkout: DateString;
  guests: number;
  status: ReservationStatus;
  totalCents: number;
  commissionCents: number;
  currency: Currency;
  channel: Channel;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type TaskType = 'cleaning' | 'checkin' | 'checkout' | 'maintenance';
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface Task {
  id: Id;
  reservationId: Id;
  unitId: Id;
  type: TaskType;
  dueDate: DateString;
  status: TaskStatus;
  assignee: string | null;
  createdAt: Timestamp;
}

export type LedgerKind = 'reservation_total' | 'channel_commission' | 'cleaning_fee' | 'tax' | 'payout';

export interface LedgerEntry {
  id: Id;
  reservationId: Id;
  kind: LedgerKind;
  amountCents: number;
  currency: Currency;
  occurredAt: Timestamp;
  metaJson: string | null;
}

/** Eventos canônicos que circulam entre PMS e canais. */
export type CanonicalEventType =
  | 'listing.published'
  | 'rates.updated'
  | 'availability.updated'
  | 'reservation.created'
  | 'reservation.modified'
  | 'reservation.cancelled';

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'dead';

export interface OutboxEvent {
  id: Id;
  connectionId: Id;
  listingId: Id | null;
  unitId: Id | null;
  type: CanonicalEventType;
  payloadJson: string;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Timestamp;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DayAvailability {
  date: DateString;
  inventory: number;
  reserved: number;
  blocked: boolean;
  available: number;
  rateCents: number | null;
  minStay: number;
  closed: boolean;
}
