import { nightsBetween } from './dates.ts';
import type { DateString, ReservationStatus, Task, TaskType } from './types.ts';

/** Transições permitidas do ciclo de vida de uma reserva. */
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new Error(`transição inválida de reserva: ${from} → ${to}`);
  }
}

/** Status que liberam inventário imediatamente. */
export function releasesInventory(status: ReservationStatus): boolean {
  return status === 'cancelled' || status === 'no_show' || status === 'checked_out';
}

/**
 * Tarefas operacionais geradas por uma reserva.
 *
 * `dueDate` das tarefas de limpeza é o dia do checkout (a unidade precisa estar
 * pronta para a próxima entrada) e o check-in é feito no dia da chegada.
 */
export function tasksForReservation(reservation: {
  checkin: DateString;
  checkout: DateString;
  guests: number;
}): Pick<Task, 'type' | 'dueDate'>[] {
  const tasks: Pick<Task, 'type' | 'dueDate'>[] = [
    { type: 'checkin' satisfies TaskType, dueDate: reservation.checkin },
    { type: 'cleaning' satisfies TaskType, dueDate: reservation.checkout },
    { type: 'checkout' satisfies TaskType, dueDate: reservation.checkout },
  ];
  // Grupos maiores exigem limpeza mais longa: sinaliza no mesmo dia com prioridade.
  if (reservation.guests > 6) tasks.push({ type: 'maintenance' satisfies TaskType, dueDate: reservation.checkout });
  return tasks;
}

export interface StayValidation {
  ok: boolean;
  errors: string[];
}

export function validateStay(input: {
  checkin: DateString;
  checkout: DateString;
  guests: number;
  minStay: number;
  maxStay: number;
  capacity: number;
}): StayValidation {
  const errors: string[] = [];
  const nights = nightsBetween(input.checkin, input.checkout);
  if (nights <= 0) errors.push('checkout deve ser posterior ao checkin');
  if (nights > 0 && nights < input.minStay) errors.push(`estadia mínima de ${input.minStay} noites`);
  if (nights > input.maxStay) errors.push(`estadia máxima de ${input.maxStay} noites`);
  if (input.guests < 1) errors.push('número de hóspedes inválido');
  if (input.guests > input.capacity) errors.push(`capacidade máxima de ${input.capacity} hóspedes`);
  return { ok: errors.length === 0, errors };
}

/** Normaliza status vindos de canais para o ciclo canônico. */
export function normalizeStatus(channel: string, raw: string): ReservationStatus {
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const table: Record<string, ReservationStatus> = {
    // genéricos
    new: 'confirmed',
    created: 'confirmed',
    confirmed: 'confirmed',
    booked: 'confirmed',
    modified: 'confirmed',
    modified_by_traveler: 'confirmed',
    modified_by_partner: 'confirmed',
    pending: 'pending',
    pending_payment: 'pending',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    cancelled_by_guest: 'cancelled',
    cancelled_by_host: 'cancelled',
    no_show: 'no_show',
    checked_in: 'checked_in',
    in_house: 'checked_in',
    checked_out: 'checked_out',
    completed: 'checked_out',
    // Booking.com
    ok: 'confirmed',
    modify: 'confirmed',
    cancel: 'cancelled',
    // Airbnb (reservation status)
    inquiry: 'pending',
    accepted: 'confirmed',
    // Expedia/Vrbo
    booked_vrbo: 'confirmed',
  };
  const mapped = table[value];
  if (!mapped) throw new Error(`status desconhecido do canal ${channel}: ${raw}`);
  return mapped;
}
