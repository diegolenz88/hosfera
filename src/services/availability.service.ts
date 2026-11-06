import type { Db } from '../db/database.ts';
import {
  getRatePlan,
  getUnit,
  listBlocks,
  listCalendarOverrides,
  listRatePlans,
  listReservationsByUnit,
} from '../db/repositories.ts';
import { computeAvailability, type AvailabilityInput } from '../domain/availability.ts';
import type { DateString, DayAvailability } from '../domain/types.ts';
import { quote, type Quote } from '../domain/pricing.ts';
import { assertDate } from '../domain/dates.ts';
import { NotFoundError } from '../errors.ts';

export interface AvailabilityQuery {
  unitId: string;
  from: DateString;
  to: DateString;
}

/** Disponibilidade derivada de uma unidade no período [from, to). */
export function getAvailability(db: Db, query: AvailabilityQuery): DayAvailability[] {
  const unit = getUnit(db, query.unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${query.unitId}`);
  assertDate(query.from);
  assertDate(query.to);

  const plan = listRatePlans(db, unit.id)[0] ?? null;
  const input: AvailabilityInput = {
    unitId: unit.id,
    inventory: unit.inventory,
    from: query.from,
    to: query.to,
    defaultMinStay: plan?.minStay ?? unit.minStay,
    reservations: listReservationsByUnit(db, unit.id, query.from, query.to),
    blocks: listBlocks(db, unit.id, query.from, query.to),
    overrides: listCalendarOverrides(db, unit.id, query.from, query.to),
    baseRateCents: plan?.basePriceCents ?? null,
  };
  return computeAvailability(input);
}

/** Cotação de estadia usando o rate plan informado (ou o primeiro da unidade). */
export function getQuote(
  db: Db,
  request: { unitId: string; ratePlanId?: string; checkin: DateString; checkout: DateString; guests?: number },
): Quote {
  const unit = getUnit(db, request.unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${request.unitId}`);
  const plan = request.ratePlanId ? getRatePlan(db, request.ratePlanId) : (listRatePlans(db, unit.id)[0] ?? null);
  if (!plan) throw new NotFoundError(`unidade sem rate plan: ${request.unitId}`);

  const overrides = listCalendarOverrides(db, unit.id, request.checkin, request.checkout);
  if (overrides.some((o) => o.closed)) {
    throw new Error('existem datas fechadas no período solicitado');
  }
  return quote(plan, {
    checkin: request.checkin,
    checkout: request.checkout,
    guests: request.guests,
    overrides,
  });
}
