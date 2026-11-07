import { intervalsOverlap } from './dates.ts';
import type { DateString, ReservationStatus } from './types.ts';

/**
 * Reconciliação: o que a operação precisa descobrir antes do hóspede descobrir.
 *
 * Todas as checagens são puras e recebem o que já existe no banco — servem tanto
 * para o painel quanto para um cron futuro.
 */

export type IssueKind =
  | 'overlap'
  | 'missing_ledger'
  | 'zero_total'
  | 'commission_above_total'
  | 'listing_without_external_id'
  | 'reservation_outside_listing';

export type IssueSeverity = 'critical' | 'warning';

export interface ReconcileIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  reservationIds?: string[];
  unitId?: string;
  listingId?: string;
}

export interface ReconcileReservation {
  id: string;
  unitId: string;
  checkin: DateString;
  checkout: DateString;
  status: ReservationStatus;
  totalCents: number;
  commissionCents: number;
}

export interface ReconcileListing {
  id: string;
  unitId: string;
  externalId: string | null;
  status: string;
}

const OCCUPYING: readonly ReservationStatus[] = ['pending', 'confirmed', 'checked_in'] as const;

export function findOverlaps(reservations: ReconcileReservation[]): ReconcileIssue[] {
  const byUnit = new Map<string, ReconcileReservation[]>();
  for (const reservation of reservations) {
    if (!OCCUPYING.includes(reservation.status)) continue;
    const list = byUnit.get(reservation.unitId) ?? [];
    list.push(reservation);
    byUnit.set(reservation.unitId, list);
  }

  const issues: ReconcileIssue[] = [];
  for (const [unitId, list] of byUnit) {
    const sorted = [...list].sort((a, b) => a.checkin.localeCompare(b.checkin));
    // Comparação par a par é O(n²) dentro da unidade, mas o inventário é 1 na
    // maioria dos casos: n é o número de estadias do período, não do portfólio.
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (!a || !b) continue;
        if (b.checkin >= a.checkout) break;
        if (intervalsOverlap(a.checkin, a.checkout, b.checkin, b.checkout)) {
          issues.push({
            kind: 'overlap',
            severity: 'critical',
            message: `duas reservas ocupam a mesma unidade entre ${a.checkin} e ${b.checkout}`,
            reservationIds: [a.id, b.id],
            unitId,
          });
        }
      }
    }
  }
  return issues;
}

export function reconcile(input: {
  reservations: ReconcileReservation[];
  listings: ReconcileListing[];
  reservationsWithLedger: Set<string>;
}): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [...findOverlaps(input.reservations)];

  for (const reservation of input.reservations) {
    if (reservation.status === 'cancelled') continue;
    if (!input.reservationsWithLedger.has(reservation.id)) {
      issues.push({
        kind: 'missing_ledger',
        severity: 'warning',
        message: 'reserva sem lançamento financeiro',
        reservationIds: [reservation.id],
        unitId: reservation.unitId,
      });
    }
    if (reservation.totalCents === 0 && reservation.status !== 'pending') {
      issues.push({
        kind: 'zero_total',
        severity: 'warning',
        message: 'reserva confirmada com total zero (webhook parcial?)',
        reservationIds: [reservation.id],
        unitId: reservation.unitId,
      });
    }
    if (reservation.commissionCents > reservation.totalCents) {
      issues.push({
        kind: 'commission_above_total',
        severity: 'critical',
        message: 'comissão do canal maior que o valor da reserva',
        reservationIds: [reservation.id],
        unitId: reservation.unitId,
      });
    }
  }

  for (const listing of input.listings) {
    if (listing.status === 'published' && !listing.externalId) {
      issues.push({
        kind: 'listing_without_external_id',
        severity: 'critical',
        message: 'anúncio publicado sem id externo: canal não sabe o que vender',
        listingId: listing.id,
        unitId: listing.unitId,
      });
    }
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}
