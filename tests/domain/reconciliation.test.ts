import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findOverlaps, reconcile, type ReconcileReservation } from '../../src/domain/reconciliation.ts';

const base = (over: Partial<ReconcileReservation> = {}): ReconcileReservation => ({
  id: 'r1',
  unitId: 'u1',
  checkin: '2026-12-20',
  checkout: '2026-12-23',
  status: 'confirmed',
  totalCents: 100_000,
  commissionCents: 15_000,
  ...over,
});

test('duas reservas ativas na mesma noite são um problema crítico', () => {
  const issues = findOverlaps([base(), base({ id: 'r2', checkin: '2026-12-22', checkout: '2026-12-25' })]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, 'overlap');
  assert.equal(issues[0]?.severity, 'critical');
  assert.deepEqual(issues[0]?.reservationIds?.sort(), ['r1', 'r2']);
});

test('checkout no mesmo dia do check-in não é sobreposição', () => {
  const issues = findOverlaps([base(), base({ id: 'r2', checkin: '2026-12-23', checkout: '2026-12-26' })]);
  assert.equal(issues.length, 0);
});

test('reserva cancelada não gera conflito', () => {
  const issues = findOverlaps([
    base(),
    base({ id: 'r2', status: 'cancelled', checkin: '2026-12-21', checkout: '2026-12-22' }),
  ]);
  assert.equal(issues.length, 0);
});

test('unidades diferentes não conflitam', () => {
  const issues = findOverlaps([base(), base({ id: 'r2', unitId: 'u2' })]);
  assert.equal(issues.length, 0);
});

test('reserva sem lançamento e total zero viram avisos; comissão acima do total é crítica', () => {
  const issues = reconcile({
    reservations: [
      base({ id: 'r1' }),
      base({ id: 'r2', totalCents: 0, commissionCents: 0 }),
      base({ id: 'r3', totalCents: 10_000, commissionCents: 20_000 }),
    ],
    listings: [],
    reservationsWithLedger: new Set(['r3']),
  });
  const kinds = issues.map((issue) => issue.kind);
  assert.ok(kinds.includes('missing_ledger'));
  assert.ok(kinds.includes('zero_total'));
  assert.ok(kinds.includes('commission_above_total'));
  assert.equal(issues[0]?.severity, 'critical', 'críticos aparecem primeiro');
});

test('anúncio publicado sem id externo é bloqueante', () => {
  const issues = reconcile({
    reservations: [],
    listings: [
      { id: 'l1', unitId: 'u1', externalId: null, status: 'published' },
      { id: 'l2', unitId: 'u1', externalId: null, status: 'draft' },
    ],
    reservationsWithLedger: new Set(),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, 'listing_without_external_id');
  assert.equal(issues[0]?.listingId, 'l1');
});
