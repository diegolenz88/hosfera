import type { Db } from '../db/database.ts';
import {
  getConnection,
  getListing,
  getUnit,
  listCalendarOverrides,
  listRatePlans,
  logEvent,
  markListingPublished,
} from '../db/repositories.ts';
import type { AdapterRegistry } from '../connectivity/registry.ts';
import type { ChannelContext } from '../connectivity/adapter.ts';
import { addDays, isWeekendNight, todayUtc } from '../domain/dates.ts';
import { applyPct } from '../domain/money.ts';
import type { Listing } from '../domain/types.ts';
import { NotFoundError, StateError } from '../errors.ts';
import { getAvailability } from './availability.service.ts';

/** Janela de sincronização inicial de um anúncio recém-publicado. */
const INITIAL_SYNC_DAYS = 365;

/**
 * Publica um anúncio no canal e faz a primeira carga de calendário.
 *
 * Publicar sem calendário é o erro que produz overbooking nos primeiros dias:
 * o anúncio fica visível e vendável com disponibilidade que o PMS não controla.
 */
export async function publishListing(
  db: Db,
  registry: AdapterRegistry,
  listingId: string,
): Promise<{ listing: Listing; externalId: string; daysSynced: number }> {
  const listing = getListing(db, listingId);
  if (!listing) throw new NotFoundError(`anúncio não encontrado: ${listingId}`);

  const connection = getConnection(db, listing.connectionId);
  if (!connection) throw new NotFoundError('conexão do anúncio não encontrada');
  if (connection.status !== 'active') {
    throw new StateError(`conexão ${connection.label} está ${connection.status}; ative antes de publicar`);
  }

  const adapter = registry.get(connection.channel);
  const ctx: ChannelContext = {
    connectionId: connection.id,
    channel: connection.channel,
    externalAccount: connection.externalAccount,
  };

  const result = await adapter.publishListing(ctx, listing);
  if (!result.ok || !result.externalId) {
    throw new Error(`falha ao publicar no canal ${connection.channel}: ${result.error ?? 'sem id externo'}`);
  }

  markListingPublished(db, listing.id, result.externalId);
  logEvent(db, 'listing', listing.id, 'listing.published', {
    channel: connection.channel,
    externalId: result.externalId,
  });

  const daysSynced = await syncListingCalendar(db, registry, listing.id);
  return {
    listing: { ...listing, externalId: result.externalId, status: 'published', publishedAt: new Date().toISOString() },
    externalId: result.externalId,
    daysSynced,
  };
}

/** Empurra o calendário canônico atual para o canal. Retorna quantos dias foram enviados. */
export async function syncListingCalendar(db: Db, registry: AdapterRegistry, listingId: string): Promise<number> {
  const listing = getListing(db, listingId);
  if (!listing?.externalId) return 0;
  const connection = getConnection(db, listing.connectionId);
  const unit = getUnit(db, listing.unitId);
  if (!connection || !unit) return 0;

  const from = todayUtc();
  const to = addDays(from, INITIAL_SYNC_DAYS);
  const overrides = new Map(listCalendarOverrides(db, unit.id, from, to).map((d) => [d.date, d]));

  // Publica a janela inteira com disponibilidade DERIVADA: se a unidade já tem
  // reservas, o anúncio novo nasce com essas noites bloqueadas (sem overbooking
  // entre canais). Preço vem do override do dia ou da tarifa base.
  const days = getAvailability(db, { unitId: unit.id, from, to }).map((day) => ({
    date: day.date,
    available: day.available,
    closed: day.closed,
    minStay: day.minStay,
    rateCents: overrides.get(day.date)?.rateCents ?? null,
  }));

  const adapter = registry.get(connection.channel);
  const ctx = { connectionId: connection.id, channel: connection.channel, externalAccount: connection.externalAccount };

  const availability = await adapter.pushAvailability(ctx, {
    unitId: unit.id,
    externalListingId: listing.externalId,
    days: days.map((d) => ({ date: d.date, available: d.available, closed: d.closed, minStay: d.minStay })),
  });
  if (!availability.ok) throw new Error(`falha ao sincronizar disponibilidade: ${availability.error ?? 'erro desconhecido'}`);

  const plan = listRatePlans(db, unit.id)[0];
  if (plan) {
    const rates = await adapter.pushRates(ctx, {
      unitId: unit.id,
      externalListingId: listing.externalId,
      currency: plan.currency,
      days: days.map((d) => ({
        date: d.date,
        // Preço do dia: override do calendário > tarifa base com acréscimo de fim de semana.
        rateCents: d.rateCents ?? applyPct(plan.basePriceCents, isWeekendNight(d.date) ? plan.weekendUpliftPct : 0),
      })),
    });
    if (!rates.ok) throw new Error(`falha ao sincronizar tarifas: ${rates.error ?? 'erro desconhecido'}`);
  }

  return days.length;
}
