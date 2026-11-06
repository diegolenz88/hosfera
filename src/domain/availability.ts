import { eachDate, toEpochDay } from './dates.ts';
import type {
  Block,
  CalendarDayOverride,
  DateString,
  DayAvailability,
  Reservation,
  ReservationStatus,
} from './types.ts';

const OCCUPYING = new Set<ReservationStatus>(['pending', 'confirmed', 'checked_in']);

export interface AvailabilityInput {
  unitId: string;
  inventory: number;
  from: DateString;
  to: DateString;
  /** Default de estadia mínima da unidade; sobrescrito por rate plan/dia. */
  defaultMinStay: number;
  reservations: Pick<Reservation, 'unitId' | 'checkin' | 'checkout' | 'status'>[];
  blocks: Pick<Block, 'unitId' | 'startDate' | 'endDate'>[];
  overrides: CalendarDayOverride[];
  /** Preço base usado quando o dia não tem override. */
  baseRateCents: number | null;
}

/**
 * Disponibilidade derivada, não armazenada.
 *
 * Fonte de verdade: inventário da unidade − reservas ativas − bloqueios.
 * O calendário só guarda exceções (preço, fechamento, mínimo de noites), o que
 * evita o drift clássico entre "disponibilidade no PMS" e "disponibilidade no canal".
 */
export function computeAvailability(input: AvailabilityInput): DayAvailability[] {
  const days = eachDate(input.from, input.to);
  const overrides = new Map(input.overrides.map((o) => [o.date, o]));
  const reservedByDay = new Map<number, number>();
  const blockedDays = new Set<number>();

  for (const r of input.reservations) {
    if (!OCCUPYING.has(r.status)) continue;
    if (r.unitId !== input.unitId) continue;
    const start = toEpochDay(r.checkin);
    const end = toEpochDay(r.checkout);
    for (let d = start; d < end; d++) reservedByDay.set(d, (reservedByDay.get(d) ?? 0) + 1);
  }

  for (const b of input.blocks) {
    if (b.unitId !== input.unitId) continue;
    const start = toEpochDay(b.startDate);
    const end = toEpochDay(b.endDate);
    for (let d = start; d < end; d++) blockedDays.add(d);
  }

  return days.map((date) => {
    const key = toEpochDay(date);
    const override = overrides.get(date);
    const reserved = reservedByDay.get(key) ?? 0;
    const closed = Boolean(override?.closed);
    const blocked = blockedDays.has(key) || closed;
    const baseAvailable = override?.available ?? input.inventory;
    const available = blocked ? 0 : Math.max(0, baseAvailable - reserved);
    return {
      date,
      inventory: input.inventory,
      reserved,
      blocked,
      available,
      rateCents: override?.rateCents ?? input.baseRateCents,
      minStay: override?.minStay ?? input.defaultMinStay,
      closed,
    };
  });
}

/** Menor disponibilidade do período — usado para decidir se um canal pode vender. */
export function minAvailable(days: DayAvailability[]): number {
  if (days.length === 0) return 0;
  return Math.min(...days.map((d) => d.available));
}

/** Verifica se o período inteiro comporta a quantidade pedida. */
export function canSell(days: DayAvailability[], quantity = 1): boolean {
  return days.every((d) => d.available >= quantity);
}

/** Primeira data sem disponibilidade — atalho para a UI de calendário. */
export function firstSoldOut(days: DayAvailability[]): DateString | null {
  return days.find((d) => d.available === 0)?.date ?? null;
}
