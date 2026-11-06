import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import {
  addLedgerEntry,
  ensureTasks,
  getConnection,
  getReservation,
  listLedger,
  logEvent,
  setReservationStatus,
  upsertReservation,
} from '../db/repositories.ts';
import type { AdapterRegistry } from '../connectivity/registry.ts';
import type { ChannelContext } from '../connectivity/adapter.ts';
import { assertTransition, releasesInventory, tasksForReservation } from '../domain/reservation.ts';
import type { Channel, Reservation, ReservationStatus } from '../domain/types.ts';
import { republishAvailability } from './ari.service.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

export interface IngestResult {
  reservation: Reservation;
  created: boolean;
  tasksCreated: number;
  republished: number;
}

/**
 * Ingestão de reserva vinda de um canal.
 *
 * Ordem: verifica assinatura → normaliza → resolve anúncio → upsert idempotente
 * → tarefas → financeiro → república disponibilidade nos demais canais.
 */
export function ingestReservation(
  db: Db,
  registry: AdapterRegistry,
  input: {
    channel: Channel;
    connectionId: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
    raw: unknown;
  },
): IngestResult {
  const connection = getConnection(db, input.connectionId);
  if (!connection) throw new NotFoundError(`conexão não encontrada: ${input.connectionId}`);
  if (connection.channel !== input.channel) {
    throw new ValidationError(`conexão ${connection.id} não pertence ao canal ${input.channel}`);
  }

  const adapter = registry.get(connection.channel);
  if (!adapter.verifyWebhook(input.headers, input.rawBody)) {
    throw new ValidationError('assinatura do webhook inválida');
  }

  const ctx: ChannelContext = {
    connectionId: connection.id,
    channel: connection.channel,
    externalAccount: connection.externalAccount,
  };
  const normalized = adapter.normalizeReservation(ctx, input.raw);

  const listing = findListingByExternalId(db, connection.id, normalized.externalListingId);
  if (!listing) throw new NotFoundError(`anúncio externo não mapeado: ${normalized.externalListingId}`);
  const unitId = listing.unitId;

  return transaction(db, () => {
    const { reservation, inserted } = upsertReservation(db, {
      orgId: connection.orgId,
      connectionId: connection.id,
      externalId: normalized.externalId,
      unitId,
      guestName: normalized.guestName,
      guestEmail: normalized.guestEmail,
      checkin: normalized.checkin,
      checkout: normalized.checkout,
      guests: normalized.guests,
      status: normalized.status,
      totalCents: normalized.totalCents,
      commissionCents: normalized.commissionCents,
      currency: normalized.currency,
      channel: connection.channel,
    });

    let tasksCreated = 0;
    if (!releasesInventory(reservation.status)) {
      tasksCreated = ensureTasks(db, reservation.id, unitId, tasksForReservation(reservation));
    }

    if (inserted) {
      addLedgerEntry(db, {
        reservationId: reservation.id,
        kind: 'reservation_total',
        amountCents: reservation.totalCents,
        currency: reservation.currency,
        occurredAt: new Date().toISOString(),
        metaJson: JSON.stringify({ channel: connection.channel }),
      });
      if (reservation.commissionCents > 0) {
        addLedgerEntry(db, {
          reservationId: reservation.id,
          kind: 'channel_commission',
          amountCents: -reservation.commissionCents,
          currency: reservation.currency,
          occurredAt: new Date().toISOString(),
          metaJson: JSON.stringify({ channel: connection.channel }),
        });
      }
    }

    // Qualquer mudança (inclusive cancelamento) recalcula e reenvia a disponibilidade
    // aos outros canais — é assim que se evita overbooking entre OTAs.
    const republished = republishAvailability(db, {
      unitId,
      from: reservation.checkin,
      to: reservation.checkout,
      excludeConnectionId: connection.id,
    });

    logEvent(db, 'reservation', reservation.id, inserted ? 'reservation.created' : 'reservation.modified', {
      channel: connection.channel,
      externalId: reservation.externalId,
      status: reservation.status,
      listingId: listing.id,
      republished,
    });

    return { reservation, created: inserted, tasksCreated, republished };
  });
}

function findListingByExternalId(
  db: Db,
  connectionId: string,
  externalListingId: string,
): { id: string; unitId: string } | null {
  const row = db
    .prepare('SELECT id, unit_id FROM listings WHERE connection_id = ? AND external_id = ?')
    .get(connectionId, externalListingId) as Record<string, unknown> | undefined;
  return row ? { id: String(row.id), unitId: String(row.unit_id) } : null;
}

/** Transição de status feita pelo operador (check-in, check-out, no-show, cancelamento). */
export function transitionReservation(
  db: Db,
  input: { reservationId: string; status: ReservationStatus },
): { reservation: Reservation; republished: number } {
  const reservation = getReservation(db, input.reservationId);
  if (!reservation) throw new NotFoundError(`reserva não encontrada: ${input.reservationId}`);
  assertTransition(reservation.status, input.status);

  return transaction(db, () => {
    setReservationStatus(db, reservation.id, input.status);
    const republished = republishAvailability(db, {
      unitId: reservation.unitId,
      from: reservation.checkin,
      to: reservation.checkout,
      excludeConnectionId: reservation.connectionId,
    });
    logEvent(db, 'reservation', reservation.id, 'reservation.status_changed', {
      from: reservation.status,
      to: input.status,
    });
    return { reservation: getReservation(db, reservation.id)!, republished };
  });
}

export function reservationDetail(db: Db, reservationId: string) {
  const reservation = getReservation(db, reservationId);
  if (!reservation) throw new NotFoundError(`reserva não encontrada: ${reservationId}`);
  const ledger = listLedger(db, reservation.id);
  const net = ledger.reduce((sum, entry) => sum + entry.amountCents, 0);
  return { reservation, ledger, netCents: net };
}
