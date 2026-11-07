import type { Db } from '../db/database.ts';
import { listAllListings, listReservationsByRange, reservationsWithLedger } from '../db/repositories.ts';
import { reconcile, type ReconcileIssue } from '../domain/reconciliation.ts';
import { assertDate } from '../domain/dates.ts';
import type { DateString } from '../domain/types.ts';

export interface ReconciliationReport {
  from: DateString;
  to: DateString;
  counts: { critical: number; warning: number; reservations: number; listings: number };
  issues: ReconcileIssue[];
}

/**
 * Reconciliação da organização no período.
 *
 * Não substitui conciliação bancária: responde "o que está inconsistente dentro
 * da hosfera" — reserva sobreposta na mesma unidade, reserva sem lançamento,
 * anúncio publicado sem id externo. É o check que roda antes de fechar o mês.
 */
export function reconcileOrg(db: Db, orgId: string, input: { from: DateString; to: DateString }): ReconciliationReport {
  assertDate(input.from);
  assertDate(input.to);

  const reservations = listReservationsByRange(db, orgId, input.from, input.to);
  const listings = listAllListings(db, orgId);
  const withLedger = reservationsWithLedger(db, orgId);

  const issues = reconcile({
    reservations: reservations.map((reservation) => ({
      id: reservation.id,
      unitId: reservation.unitId,
      checkin: reservation.checkin,
      checkout: reservation.checkout,
      status: reservation.status,
      totalCents: reservation.totalCents,
      commissionCents: reservation.commissionCents,
    })),
    listings: listings.map((listing) => ({
      id: listing.id,
      unitId: listing.unitId,
      externalId: listing.externalId,
      status: listing.status,
    })),
    reservationsWithLedger: withLedger,
  });

  return {
    from: input.from,
    to: input.to,
    counts: {
      critical: issues.filter((issue) => issue.severity === 'critical').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
      reservations: reservations.length,
      listings: listings.length,
    },
    issues,
  };
}
