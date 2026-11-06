import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { adr, PricingError, quote } from '../../src/domain/pricing.ts';
import type { RatePlan } from '../../src/domain/types.ts';

const plan: RatePlan = {
  id: 'p1',
  unitId: 'u1',
  name: 'Flexível',
  basePriceCents: 40_000,
  weekendUpliftPct: 25,
  cleaningFeeCents: 10_000,
  minStay: 2,
  currency: 'BRL',
  cancellationPolicy: 'flexible',
  createdAt: '',
};

test('fim de semana recebe acréscimo e limpeza é cobrada uma vez', () => {
  // 2026-03-13 é sexta-feira: sexta e sábado são as noites caras.
  const result = quote(plan, { checkin: '2026-03-12', checkout: '2026-03-15' });
  assert.equal(result.nights, 3);
  assert.deepEqual(
    result.nightly.map((n) => [n.date, n.rateCents, n.weekend]),
    [
      ['2026-03-12', 40_000, false],
      ['2026-03-13', 50_000, true],
      ['2026-03-14', 50_000, true],
    ],
  );
  assert.equal(result.accommodationCents, 140_000);
  assert.equal(result.cleaningFeeCents, 10_000);
  assert.equal(result.totalCents, 150_000);
  assert.equal(adr(result), 46_667);
});

test('estadia abaixo do mínimo é recusada', () => {
  assert.throws(() => quote(plan, { checkin: '2026-03-10', checkout: '2026-03-11' }), PricingError);
});

test('override de preço por dia vence a tarifa base', () => {
  const result = quote(plan, {
    checkin: '2026-03-10',
    checkout: '2026-03-12',
    overrides: [{ unitId: 'u1', date: '2026-03-11', available: null, rateCents: 120_000, minStay: null, closed: false, updatedAt: '' }],
  });
  assert.deepEqual(result.nightly.map((n) => n.rateCents), [40_000, 120_000]);
});

test('checkout igual ao checkin é inválido', () => {
  assert.throws(() => quote(plan, { checkin: '2026-03-10', checkout: '2026-03-10' }), PricingError);
});
