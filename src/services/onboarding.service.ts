import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import {
  copyAmenities,
  createProperty,
  createRatePlan,
  createUnit,
  getProperty,
  getUnit,
  listAmenities,
  listRatePlans,
  logEvent,
  setAmenities,
} from '../db/repositories.ts';
import { normalizeAmenities } from '../domain/amenities.ts';
import { applyPct } from '../domain/money.ts';
import { isWeekendNight } from '../domain/dates.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

export interface OnboardingUnitInput {
  name: string;
  inventory?: number;
  capacity?: number;
  basePriceCents: number;
  cleaningFeeCents?: number;
  weekendUpliftPct?: number;
  minStay?: number;
  amenities?: unknown;
  checkinFrom?: string;
  checkoutUntil?: string;
  houseRules?: string;
}

export interface OnboardingInput {
  orgId: string;
  property: {
    name: string;
    city?: string;
    state?: string;
    address?: string;
    ownerName?: string;
    ownerEmail?: string;
    ownerSharePct?: number;
  };
  units: OnboardingUnitInput[];
}

export interface OnboardingResult {
  propertyId: string;
  units: { id: string; name: string; basePriceCents: number; amenities: string[] }[];
}

/**
 * Onboarding de imóvel: imóvel + unidades + tarifa + comodidades numa transação.
 *
 * Se qualquer unidade for inválida, nada é criado — onboarding pela metade gera
 * imóvel sem tarifa, que é o anúncio que não vende.
 */
export function onboardProperty(db: Db, input: OnboardingInput): OnboardingResult {
  const units = input.units ?? [];
  if (units.length === 0) throw new ValidationError('informe ao menos uma unidade');
  for (const unit of units) {
    if (!unit.name?.trim()) throw new ValidationError('toda unidade precisa de nome');
    if (!Number.isInteger(unit.basePriceCents) || unit.basePriceCents <= 0) {
      throw new ValidationError(`preço base inválido em ${unit.name}`);
    }
    // valida comodidades antes de abrir transação
    normalizeAmenities(unit.amenities);
  }
  if (input.property.ownerSharePct !== undefined && (input.property.ownerSharePct < 0 || input.property.ownerSharePct > 100)) {
    throw new ValidationError('percentual do proprietário deve estar entre 0 e 100');
  }

  return transaction(db, () => {
    const property = createProperty(db, {
      orgId: input.orgId,
      name: input.property.name,
      city: input.property.city ?? null,
      state: input.property.state ?? null,
      address: input.property.address ?? null,
      ownerName: input.property.ownerName ?? null,
      ownerEmail: input.property.ownerEmail ?? null,
      ownerSharePct: input.property.ownerSharePct ?? 70,
    });

    const created = units.map((unit) => {
      const row = createUnit(db, {
        propertyId: property.id,
        name: unit.name.trim(),
        inventory: unit.inventory ?? 1,
        minStay: unit.minStay ?? 2,
        capacity: unit.capacity ?? 2,
        checkinFrom: unit.checkinFrom ?? '15:00',
        checkoutUntil: unit.checkoutUntil ?? '11:00',
        houseRules: unit.houseRules ?? null,
      });
      createRatePlan(db, {
        unitId: row.id,
        name: 'Tarifa padrão',
        basePriceCents: unit.basePriceCents,
        weekendUpliftPct: unit.weekendUpliftPct ?? 0,
        cleaningFeeCents: unit.cleaningFeeCents ?? 0,
        minStay: unit.minStay ?? 2,
      });
      const amenities = normalizeAmenities(unit.amenities);
      if (amenities.length) setAmenities(db, row.id, amenities);
      return { id: row.id, name: row.name, basePriceCents: unit.basePriceCents, amenities };
    });

    logEvent(db, 'property', property.id, 'property.onboarded', {
      units: created.map((unit) => unit.id),
      ownerSharePct: property.ownerSharePct,
    });
    return { propertyId: property.id, units: created };
  });
}

/** Atualiza dados operacionais da unidade (capacidade, horários, regras). */
export function updateUnitDetails(
  db: Db,
  input: {
    orgId: string;
    unitId: string;
    capacity?: number;
    checkinFrom?: string | null;
    checkoutUntil?: string | null;
    houseRules?: string | null;
  },
): ReturnType<typeof getUnit> {
  const unit = getUnit(db, input.unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);
  const property = getProperty(db, unit.propertyId);
  if (!property || property.orgId !== input.orgId) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);

  if (input.capacity !== undefined && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new ValidationError('capacidade deve ser um inteiro positivo');
  }
  if (input.checkinFrom && !/^\d{2}:\d{2}$/.test(input.checkinFrom)) throw new ValidationError('check-in deve ser HH:MM');
  if (input.checkoutUntil && !/^\d{2}:\d{2}$/.test(input.checkoutUntil)) throw new ValidationError('check-out deve ser HH:MM');

  db.prepare(
    `UPDATE units SET capacity = ?, checkin_from = ?, checkout_until = ?, house_rules = ? WHERE id = ?`,
  ).run(
    input.capacity ?? unit.capacity,
    input.checkinFrom === undefined ? unit.checkinFrom : input.checkinFrom,
    input.checkoutUntil === undefined ? unit.checkoutUntil : input.checkoutUntil,
    input.houseRules === undefined ? unit.houseRules : input.houseRules,
    unit.id,
  );
  logEvent(db, 'unit', unit.id, 'unit.details_updated', {
    capacity: input.capacity ?? unit.capacity,
  });
  return getUnit(db, unit.id);
}

/**
 * Duplica uma unidade com tarifas e comodidades.
 *
 * Copia também a **tarifa**: duplicar sem preço produz unidade que não vende, e
 * é o erro mais comum ao cadastrar a segunda unidade de um mesmo imóvel.
 */
export function duplicateUnit(
  db: Db,
  input: { orgId: string; unitId: string; name?: string },
): { unitId: string; copiedRatePlans: number; copiedAmenities: number } {
  const source = getUnit(db, input.unitId);
  if (!source) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);
  const property = getProperty(db, source.propertyId);
  if (!property || property.orgId !== input.orgId) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);

  return transaction(db, () => {
    const copy = createUnit(db, {
      propertyId: source.propertyId,
      name: input.name?.trim() || `${source.name} (cópia)`,
      inventory: source.inventory,
      currency: source.currency,
      minStay: source.minStay,
      maxStay: source.maxStay,
      capacity: source.capacity,
      checkinFrom: source.checkinFrom,
      checkoutUntil: source.checkoutUntil,
      houseRules: source.houseRules,
    });

    const plans = listRatePlans(db, source.id);
    for (const plan of plans) {
      createRatePlan(db, {
        unitId: copy.id,
        name: plan.name,
        basePriceCents: plan.basePriceCents,
        weekendUpliftPct: plan.weekendUpliftPct,
        cleaningFeeCents: plan.cleaningFeeCents,
        minStay: plan.minStay,
        currency: plan.currency,
        cancellationPolicy: plan.cancellationPolicy,
      });
    }
    copyAmenities(db, source.id, copy.id);
    logEvent(db, 'unit', copy.id, 'unit.duplicated', { from: source.id });
    return {
      unitId: copy.id,
      copiedRatePlans: plans.length,
      copiedAmenities: listAmenities(db, copy.id).length,
    };
  });
}

/** Preço sugerido para uma data: base com acréscimo de fim de semana. */
export function suggestedRate(basePriceCents: number, weekendUpliftPct: number, date: string): number {
  return applyPct(basePriceCents, isWeekendNight(date) ? weekendUpliftPct : 0);
}
