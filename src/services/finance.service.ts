import type { Db } from '../db/database.ts';
import { getProperty, listProperties, listReservationsByRange, listUnitsByOrg } from '../db/repositories.ts';
import { computePayout, marginByChannel, type PayoutResult } from '../domain/finance.ts';
import { assertDate } from '../domain/dates.ts';
import type { DateString } from '../domain/types.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

export interface PropertyPayout {
  propertyId: string;
  propertyName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerSharePct: number;
  payout: PayoutResult;
  channels: ReturnType<typeof marginByChannel>;
}

export interface PayoutReport {
  from: DateString;
  to: DateString;
  totals: PayoutResult;
  properties: PropertyPayout[];
  channels: ReturnType<typeof marginByChannel>;
  /** Reservas do período que ainda não têm lançamento financeiro. */
  withoutLedger: number;
}

/**
 * Relatório de repasse por proprietário no período.
 *
 * O recorte é por **data de check-in** (não por data de pagamento): é o que o
 * proprietário reconhece como "as estadias do mês". Reservas canceladas ficam
 * fora por definição do cálculo em `computePayout`.
 */
export function payoutReport(
  db: Db,
  orgId: string,
  input: { from: DateString; to: DateString; propertyId?: string },
): PayoutReport {
  assertDate(input.from);
  assertDate(input.to);
  if (input.to <= input.from) throw new ValidationError('período inválido: `to` deve ser posterior a `from`');

  const properties = input.propertyId
    ? [getProperty(db, input.propertyId)].filter((property): property is NonNullable<typeof property> => property !== null)
    : listProperties(db, orgId);
  if (properties.length === 0) throw new NotFoundError('nenhum imóvel encontrado para o período');
  for (const property of properties) {
    if (property.orgId !== orgId) throw new NotFoundError(`imóvel não encontrado: ${property.id}`);
  }

  const units = listUnitsByOrg(db, orgId);
  const unitToProperty = new Map(units.map((unit) => [unit.id, unit.propertyId]));
  const reservations = listReservationsByRange(db, orgId, input.from, input.to);
  const ledgerIds = new Set(
    (db.prepare('SELECT DISTINCT reservation_id FROM ledger_entries').all() as { reservation_id: string }[]).map(
      (row) => row.reservation_id,
    ),
  );

  const scoped = reservations.filter((reservation) => {
    const propertyId = unitToProperty.get(reservation.unitId);
    return propertyId !== undefined && properties.some((property) => property.id === propertyId);
  });

  const perProperty: PropertyPayout[] = properties.map((property) => {
    const propertyReservations = scoped.filter((reservation) => unitToProperty.get(reservation.unitId) === property.id);
    const payout = computePayout({
      reservations: propertyReservations.map((reservation) => ({
        id: reservation.id,
        checkin: reservation.checkin,
        checkout: reservation.checkout,
        status: reservation.status,
        totalCents: reservation.totalCents,
        commissionCents: reservation.commissionCents,
      })),
      ownerSharePct: property.ownerSharePct,
    });
    return {
      propertyId: property.id,
      propertyName: property.name,
      ownerName: property.ownerName,
      ownerEmail: property.ownerEmail,
      ownerSharePct: property.ownerSharePct,
      payout,
      channels: marginByChannel(propertyReservations),
    };
  });

  const totals = computePayout({
    reservations: scoped.map((reservation) => ({
      id: reservation.id,
      checkin: reservation.checkin,
      checkout: reservation.checkout,
      status: reservation.status,
      totalCents: reservation.totalCents,
      commissionCents: reservation.commissionCents,
    })),
    // Média ponderada pelo líquido: o total do portfólio não pertence a um só dono.
    ownerSharePct: (() => {
      const net = perProperty.reduce((sum, entry) => sum + entry.payout.netCents, 0);
      if (net === 0) return 70;
      const weighted = perProperty.reduce((sum, entry) => sum + entry.payout.netCents * entry.ownerSharePct, 0);
      return Math.round(weighted / net);
    })(),
  });

  return {
    from: input.from,
    to: input.to,
    totals,
    properties: perProperty,
    channels: marginByChannel(scoped),
    withoutLedger: scoped.filter((reservation) => reservation.status !== 'pending' && !ledgerIds.has(reservation.id)).length,
  };
}
