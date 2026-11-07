import { nightsBetween } from './dates.ts';
import type { DateString, ReservationStatus } from './types.ts';

/** Reservas que entram no financeiro: cancelada e no-show não geram receita. */
const BILLABLE: readonly ReservationStatus[] = ['pending', 'confirmed', 'checked_in', 'checked_out'] as const;

export interface PayoutReservation {
  id: string;
  checkin: DateString;
  checkout: DateString;
  status: ReservationStatus;
  totalCents: number;
  commissionCents: number;
}

export interface PayoutResult {
  reservationCount: number;
  nights: number;
  grossCents: number;
  commissionCents: number;
  /** O que sobra para a administradora depois da comissão do canal. */
  netCents: number;
  ownerSharePct: number;
  /** Parte do líquido que vai para o proprietário. */
  ownerPayableCents: number;
  /** Taxa de administração retida (= líquido − repasse). */
  managementFeeCents: number;
}

/**
 * Repasse a proprietário.
 *
 * Regra: o percentual do proprietário incide sobre o **líquido** (bruto menos
 * comissão do canal), nunca sobre o bruto — repassar sobre o bruto paga comissão
 * de OTA ao proprietário e quebra a margem.
 */
export function computePayout(input: {
  reservations: PayoutReservation[];
  ownerSharePct: number;
}): PayoutResult {
  if (!Number.isInteger(input.ownerSharePct) || input.ownerSharePct < 0 || input.ownerSharePct > 100) {
    throw new Error('percentual do proprietário deve ser inteiro entre 0 e 100');
  }

  let grossCents = 0;
  let commissionCents = 0;
  let nights = 0;
  let count = 0;

  for (const reservation of input.reservations) {
    if (!BILLABLE.includes(reservation.status)) continue;
    count += 1;
    grossCents += reservation.totalCents;
    commissionCents += reservation.commissionCents;
    nights += Math.max(0, nightsBetween(reservation.checkin, reservation.checkout));
  }

  const netCents = grossCents - commissionCents;
  const ownerPayableCents = Math.round((netCents * input.ownerSharePct) / 100);
  return {
    reservationCount: count,
    nights,
    grossCents,
    commissionCents,
    netCents,
    ownerSharePct: input.ownerSharePct,
    ownerPayableCents,
    managementFeeCents: netCents - ownerPayableCents,
  };
}

/** Margem por canal: onde o mesmo volume deixa mais dinheiro. */
export function marginByChannel(
  rows: { channel: string; totalCents: number; commissionCents: number }[],
): { channel: string; grossCents: number; commissionCents: number; netCents: number; netMarginPct: number }[] {
  const byChannel = new Map<string, { gross: number; commission: number }>();
  for (const row of rows) {
    const current = byChannel.get(row.channel) ?? { gross: 0, commission: 0 };
    current.gross += row.totalCents;
    current.commission += row.commissionCents;
    byChannel.set(row.channel, current);
  }
  return [...byChannel.entries()]
    .map(([channel, totals]) => {
      const net = totals.gross - totals.commission;
      return {
        channel,
        grossCents: totals.gross,
        commissionCents: totals.commission,
        netCents: net,
        netMarginPct: totals.gross > 0 ? Math.round((net / totals.gross) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.netCents - a.netCents);
}
