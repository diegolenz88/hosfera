import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computePayout, marginByChannel } from '../../src/domain/finance.ts';

const reservation = (over: Partial<Parameters<typeof computePayout>[0]['reservations'][number]> = {}) => ({
  id: 'r1',
  checkin: '2026-12-20',
  checkout: '2026-12-23',
  status: 'confirmed' as const,
  totalCents: 135_000,
  commissionCents: 20_250,
  ...over,
});

test('repasse incide sobre o líquido, não sobre o bruto', () => {
  const result = computePayout({ reservations: [reservation()], ownerSharePct: 70 });
  assert.equal(result.grossCents, 135_000);
  assert.equal(result.commissionCents, 20_250);
  assert.equal(result.netCents, 114_750);
  // 70% de 114.750 = 80.325 (se fosse sobre o bruto, daria 94.500 — erro de R$ 14 mil)
  assert.equal(result.ownerPayableCents, 80_325);
  assert.equal(result.managementFeeCents, 34_425);
  assert.equal(result.nights, 3);
});

test('cancelada e no-show não entram no repasse', () => {
  const result = computePayout({
    reservations: [
      reservation(),
      reservation({ id: 'r2', status: 'cancelled', totalCents: 999_000 }),
      reservation({ id: 'r3', status: 'no_show', totalCents: 999_000 }),
    ],
    ownerSharePct: 70,
  });
  assert.equal(result.reservationCount, 1);
  assert.equal(result.grossCents, 135_000);
});

test('estadia de uma noite conta uma noite', () => {
  const result = computePayout({
    reservations: [reservation({ checkin: '2026-12-20', checkout: '2026-12-21' })],
    ownerSharePct: 50,
  });
  assert.equal(result.nights, 1);
  assert.equal(result.ownerPayableCents, 57_375);
});

test('percentual fora de faixa é recusado', () => {
  assert.throws(() => computePayout({ reservations: [], ownerSharePct: 120 }));
  assert.throws(() => computePayout({ reservations: [], ownerSharePct: -1 }));
  assert.throws(() => computePayout({ reservations: [], ownerSharePct: 33.5 }));
});

test('margem por canal ordena por líquido e calcula percentual', () => {
  const rows = marginByChannel([
    { channel: 'booking', totalCents: 100_000, commissionCents: 18_000 },
    { channel: 'booking', totalCents: 50_000, commissionCents: 9_000 },
    { channel: 'mock', totalCents: 80_000, commissionCents: 0 },
  ]);
  // booking: 123.000 líquidos (82%) · mock: 80.000 (100%) — ordena por líquido
  assert.equal(rows[0]?.channel, 'booking');
  assert.equal(rows[0]?.netCents, 123_000);
  assert.equal(rows[0]?.netMarginPct, 82);
  assert.equal(rows[1]?.channel, 'mock');
  assert.equal(rows[1]?.netMarginPct, 100);
});

test('sem reservas o resultado é zero, não NaN', () => {
  const result = computePayout({ reservations: [], ownerSharePct: 70 });
  assert.deepEqual(
    [result.grossCents, result.netCents, result.ownerPayableCents, result.managementFeeCents, result.nights],
    [0, 0, 0, 0, 0],
  );
});
