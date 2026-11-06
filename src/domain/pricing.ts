import { eachDate, isWeekendNight, nightsBetween } from './dates.ts';
import { applyPct } from './money.ts';
import type { CalendarDayOverride, DateString, RatePlan } from './types.ts';

export interface QuoteRequest {
  checkin: DateString;
  checkout: DateString;
  guests?: number;
  /** Overrides de preço por dia (vindos do calendário). */
  overrides?: CalendarDayOverride[];
}

export interface QuoteNight {
  date: DateString;
  weekend: boolean;
  rateCents: number;
}

export interface Quote {
  unitId: string;
  checkin: DateString;
  checkout: DateString;
  nights: number;
  nightly: QuoteNight[];
  accommodationCents: number;
  cleaningFeeCents: number;
  totalCents: number;
  currency: string;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Preço de uma estadia: base + acréscimo de fim de semana, com override por dia.
 * Regras de negócio ficam aqui (puras) para serem testáveis sem banco.
 */
export function quote(ratePlan: RatePlan, request: QuoteRequest): Quote {
  const nights = nightsBetween(request.checkin, request.checkout);
  if (nights <= 0) throw new PricingError('checkout deve ser posterior ao checkin');
  if (nights < ratePlan.minStay) {
    throw new PricingError(`estadia mínima de ${ratePlan.minStay} noites para este plano`);
  }

  const overrides = new Map((request.overrides ?? []).map((o) => [o.date, o]));
  const nightly: QuoteNight[] = eachDate(request.checkin, request.checkout).map((date) => {
    const override = overrides.get(date);
    const weekend = isWeekendNight(date);
    const base = override?.rateCents ?? applyPct(ratePlan.basePriceCents, weekend ? ratePlan.weekendUpliftPct : 0);
    return { date, weekend, rateCents: base };
  });

  const accommodationCents = nightly.reduce((sum, n) => sum + n.rateCents, 0);
  return {
    unitId: ratePlan.unitId,
    checkin: request.checkin,
    checkout: request.checkout,
    nights,
    nightly,
    accommodationCents,
    cleaningFeeCents: ratePlan.cleaningFeeCents,
    totalCents: accommodationCents + ratePlan.cleaningFeeCents,
    currency: ratePlan.currency,
  };
}

/** Preço médio por noite — base do ADR nos relatórios. */
export function adr(quoteResult: Quote): number {
  return Math.round(quoteResult.accommodationCents / quoteResult.nights);
}
