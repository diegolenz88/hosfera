import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeAvailability, minAvailable, canSell } from '../../src/domain/availability.ts';
import type { Reservation } from '../../src/domain/types.ts';

const base = {
  unitId: 'u1',
  inventory: 1,
  defaultMinStay: 2,
  reservations: [] as Reservation[],
  blocks: [],
  overrides: [],
  baseRateCents: 40_000,
};

const res = (checkin: string, checkout: string, status: Reservation['status'] = 'confirmed'): Reservation => ({
  id: `r-${checkin}-${checkout}`,
  orgId: 'o1',
  connectionId: 'c1',
  externalId: `ext-${checkin}`,
  unitId: 'u1',
  guestName: 'Teste',
  guestEmail: null,
  checkin,
  checkout,
  guests: 2,
  status,
  totalCents: 0,
  commissionCents: 0,
  currency: 'BRL',
  channel: 'mock',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('estadia é meio-aberta: saída no dia 12 libera a noite do dia 12', () => {
  const days = computeAvailability({
    ...base,
    from: '2026-03-10',
    to: '2026-03-13',
    reservations: [res('2026-03-10', '2026-03-12')],
  });
  assert.deepEqual(
    days.map((d) => [d.date, d.available]),
    [
      ['2026-03-10', 0],
      ['2026-03-11', 0],
      ['2026-03-12', 1],
    ],
  );
});

test('reserva cancelada não ocupa inventário', () => {
  const days = computeAvailability({
    ...base,
    from: '2026-03-10',
    to: '2026-03-12',
    reservations: [res('2026-03-10', '2026-03-12', 'cancelled')],
  });
  assert.equal(minAvailable(days), 1);
  assert.ok(canSell(days));
});

test('reserva pendente bloqueia venda para não gerar overbooking', () => {
  const days = computeAvailability({
    ...base,
    from: '2026-03-10',
    to: '2026-03-11',
    reservations: [res('2026-03-10', '2026-03-11', 'pending')],
  });
  assert.equal(days[0]?.available, 0);
});

test('inventário 2 permite duas reservas simultâneas e fecha na terceira', () => {
  const days = computeAvailability({
    ...base,
    inventory: 2,
    from: '2026-03-10',
    to: '2026-03-11',
    reservations: [res('2026-03-09', '2026-03-12'), res('2026-03-10', '2026-03-11')],
  });
  assert.equal(days[0]?.available, 0);
  assert.equal(days[0]?.reserved, 2);
});

test('bloqueio manual zera disponibilidade sem criar reserva', () => {
  const days = computeAvailability({
    ...base,
    from: '2026-03-10',
    to: '2026-03-12',
    blocks: [{ unitId: 'u1', startDate: '2026-03-11', endDate: '2026-03-12' }],
  });
  assert.equal(days[0]?.available, 1);
  assert.equal(days[1]?.blocked, true);
  assert.equal(days[1]?.available, 0);
});

test('override de calendário fecha o dia e sobrescreve preço e mínimo de noites', () => {
  const days = computeAvailability({
    ...base,
    from: '2026-03-10',
    to: '2026-03-11',
    overrides: [
      { unitId: 'u1', date: '2026-03-10', available: 5, rateCents: 99_000, minStay: 4, closed: true, updatedAt: '' },
    ],
  });
  assert.equal(days[0]?.closed, true);
  assert.equal(days[0]?.available, 0);
  assert.equal(days[0]?.rateCents, 99_000);
  assert.equal(days[0]?.minStay, 4);
});

test('reserva de outra unidade não afeta a disponibilidade desta', () => {
  const other = { ...res('2026-03-10', '2026-03-11'), unitId: 'u2' };
  const days = computeAvailability({ ...base, from: '2026-03-10', to: '2026-03-11', reservations: [other] });
  assert.equal(days[0]?.available, 1);
});

test('intervalo vazio ou invertido é rejeitado', () => {
  assert.throws(() => computeAvailability({ ...base, from: '2026-03-12', to: '2026-03-10', reservations: [] }));
  assert.deepEqual(computeAvailability({ ...base, from: '2026-03-10', to: '2026-03-10', reservations: [] }), []);
});


test('override de disponibilidade não pode passar do inventário', () => {
  const days = computeAvailability({
    ...base,
    inventory: 1,
    from: '2026-03-10',
    to: '2026-03-11',
    overrides: [
      { unitId: 'u1', date: '2026-03-10', available: 5, rateCents: null, minStay: null, closed: false, updatedAt: '' },
    ],
  });
  assert.equal(days[0]?.available, 1, 'edição manual não pode vender o que não existe');
});
