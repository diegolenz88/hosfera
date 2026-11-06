import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import {
  createBlock,
  enqueue,
  getListing,
  listCalendarOverrides,
  listPublishedListingsByUnit,
  logEvent,
  touchListingSync,
  upsertCalendarDays,
  type CalendarUpsert,
} from '../db/repositories.ts';
import { assertDate, eachDate } from '../domain/dates.ts';
import type { DateString } from '../domain/types.ts';

export interface AriDayInput {
  date: DateString;
  rateCents?: number | null;
  available?: number | null;
  minStay?: number | null;
  closed?: boolean;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * Publica ARI (availability, rates, inventory/restrictions) de uma unidade.
 *
 * Grava o estado canônico e enfileira um evento por anúncio publicado.
 * Nada é enviado ao canal dentro da requisição HTTP: quem fala com a OTA é o
 * dispatcher, o que dá retry, auditoria e desacoplamento de latência.
 */
export function setAri(
  db: Db,
  input: { unitId: string; days: AriDayInput[] },
): { daysWritten: number; events: number } {
  if (input.days.length === 0) return { daysWritten: 0, events: 0 };
  for (const day of input.days) assertDate(day.date);

  const listings = listPublishedListingsByUnit(db, input.unitId);

  return transaction(db, () => {
    const writes: CalendarUpsert[] = input.days.map((d) => ({
      unitId: input.unitId,
      date: d.date,
      available: d.available ?? null,
      rateCents: d.rateCents ?? null,
      minStay: d.minStay ?? null,
      closed: d.closed ?? false,
    }));
    const daysWritten = upsertCalendarDays(db, writes);

    const rateDays = input.days.filter((d) => d.rateCents !== undefined && d.rateCents !== null);
    const availabilityDays = input.days.filter((d) => d.available !== undefined || d.closed !== undefined || d.minStay !== undefined);

    let events = 0;
    for (const listing of listings) {
      if (!listing.externalId) continue;
      if (rateDays.length) {
        const payload = {
          unitId: listing.unitId,
          listingId: listing.id,
          externalListingId: listing.externalId,
          days: rateDays.map((d) => ({ date: d.date, rateCents: Number(d.rateCents) })),
        };
        const result = enqueue(db, {
          connectionId: listing.connectionId,
          listingId: listing.id,
          unitId: listing.unitId,
          type: 'rates.updated',
          payload,
          idempotencyKey: `rates:${listing.id}:${hash(payload.days)}`,
        });
        if (result.created) events += 1;
        touchListingSync(db, listing.id);
      }
      if (availabilityDays.length) {
        const payload = {
          unitId: listing.unitId,
          listingId: listing.id,
          externalListingId: listing.externalId,
          days: availabilityDays.map((d) => ({
            date: d.date,
            available: d.available ?? null,
            closed: d.closed ?? false,
            minStay: d.minStay ?? null,
          })),
        };
        const result = enqueue(db, {
          connectionId: listing.connectionId,
          listingId: listing.id,
          unitId: listing.unitId,
          type: 'availability.updated',
          payload,
          idempotencyKey: `avail:${listing.id}:${hash(payload.days)}`,
        });
        if (result.created) events += 1;
        touchListingSync(db, listing.id);
      }
    }

    logEvent(db, 'unit', input.unitId, 'ari.updated', { days: input.days.length, events });
    return { daysWritten, events };
  });
}

/** Bloqueio manual (manutenção, uso do proprietário). Libera com `cancelBlock`. */
export function blockDates(
  db: Db,
  input: { unitId: string; startDate: DateString; endDate: DateString; reason?: string },
): { blockId: string; events: number } {
  assertDate(input.startDate);
  assertDate(input.endDate);
  const block = createBlock(db, {
    unitId: input.unitId,
    startDate: input.startDate,
    endDate: input.endDate,
    reason: input.reason ?? null,
  });
  const days = eachDate(input.startDate, input.endDate);
  const result = setAri(db, { unitId: input.unitId, days: days.map((date) => ({ date, closed: true, available: 0 })) });
  logEvent(db, 'unit', input.unitId, 'block.created', { blockId: block.id, days: days.length });
  return { blockId: block.id, events: result.events };
}

/**
 * Reenvia a disponibilidade calculada das datas afetadas para os anúncios
 * publicados — usado depois de cada reserva criada/alterada/cancelada.
 */
export function republishAvailability(
  db: Db,
  input: { unitId: string; from: DateString; to: DateString; excludeConnectionId?: string },
): number {
  const days = eachDate(input.from, input.to);
  if (days.length === 0) return 0;
  const overrides = listCalendarOverrides(db, input.unitId, input.from, input.to);
  const byDate = new Map(overrides.map((o) => [o.date, o]));
  const listings = listPublishedListingsByUnit(db, input.unitId).filter(
    (l) => l.connectionId !== input.excludeConnectionId && l.externalId,
  );

  let events = 0;
  for (const listing of listings) {
    const payload = {
      unitId: input.unitId,
      listingId: listing.id,
      externalListingId: listing.externalId,
      days: days.map((date) => {
        const override = byDate.get(date);
        return {
          date,
          available: override?.available ?? null,
          closed: override?.closed ?? false,
          minStay: override?.minStay ?? null,
        };
      }),
    };
    const result = enqueue(db, {
      connectionId: listing.connectionId,
      listingId: listing.id,
      unitId: input.unitId,
      type: 'availability.updated',
      payload,
      idempotencyKey: `avail:${listing.id}:${hash(payload.days)}`,
    });
    if (result.created) events += 1;
  }
  return events;
}

export function enqueueListingPublish(db: Db, listingId: string): void {
  const listing = getListing(db, listingId);
  if (!listing) return;
  enqueue(db, {
    connectionId: listing.connectionId,
    listingId: listing.id,
    unitId: listing.unitId,
    type: 'listing.published',
    payload: { listingId: listing.id, unitId: listing.unitId },
    idempotencyKey: `listing:${listing.id}`,
  });
}
