import type { DateString } from './types.ts';

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(value: string): DateString {
  if (!ISO_DATE.test(value)) throw new Error(`data inválida: ${value} (esperado YYYY-MM-DD)`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`data inexistente: ${value}`);
  }
  return value;
}

export function toEpochDay(date: DateString): number {
  return Math.floor(Date.parse(`${assertDate(date)}T00:00:00Z`) / DAY_MS);
}

export function fromEpochDay(day: number): DateString {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: DateString, days: number): DateString {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Lista de datas [from, to) — estadia de uma noite retorna 1 data. */
export function eachDate(from: DateString, to: DateString): DateString[] {
  const start = toEpochDay(from);
  const end = toEpochDay(to);
  if (end < start) throw new Error('intervalo invertido');
  const out: DateString[] = [];
  for (let d = start; d < end; d++) out.push(fromEpochDay(d));
  return out;
}

export function nightsBetween(checkin: DateString, checkout: DateString): number {
  return toEpochDay(checkout) - toEpochDay(checkin);
}

/**
 * Intervalos de estadia são meio-abertos [checkin, checkout):
 * uma reserva que sai dia 10 libera a noite do dia 10.
 */
export function intervalsOverlap(
  aStart: DateString,
  aEnd: DateString,
  bStart: DateString,
  bEnd: DateString,
): boolean {
  return toEpochDay(aStart) < toEpochDay(bEnd) && toEpochDay(bStart) < toEpochDay(aEnd);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(date: DateString): number {
  return new Date(`${assertDate(date)}T00:00:00Z`).getUTCDay();
}

export function isWeekendNight(date: DateString): boolean {
  const d = weekday(date);
  return d === 5 || d === 6; // sexta e sábado são as noites caras
}

export function todayUtc(now: Date = new Date()): DateString {
  return now.toISOString().slice(0, 10);
}
