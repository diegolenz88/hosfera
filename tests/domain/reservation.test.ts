import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assertTransition,
  canTransition,
  normalizeStatus,
  releasesInventory,
  tasksForReservation,
  validateStay,
} from '../../src/domain/reservation.ts';

test('transições do ciclo de vida são respeitadas', () => {
  assert.ok(canTransition('pending', 'confirmed'));
  assert.ok(canTransition('confirmed', 'checked_in'));
  assert.ok(canTransition('checked_in', 'checked_out'));
  assert.ok(!canTransition('checked_out', 'confirmed'));
  assert.ok(!canTransition('cancelled', 'confirmed'));
  assert.throws(() => assertTransition('checked_out', 'checked_in'));
});

test('cancelamento e no-show liberam inventário', () => {
  assert.ok(releasesInventory('cancelled'));
  assert.ok(releasesInventory('no_show'));
  assert.ok(!releasesInventory('confirmed'));
});

test('status de canal é normalizado para o ciclo canônico', () => {
  assert.equal(normalizeStatus('booking', 'OK'), 'confirmed');
  assert.equal(normalizeStatus('booking', 'CANCELLED_BY_GUEST'), 'cancelled');
  assert.equal(normalizeStatus('airbnb', 'accepted'), 'confirmed');
  assert.equal(normalizeStatus('airbnb', 'inquiry'), 'pending');
  assert.equal(normalizeStatus('expedia', 'Completed'), 'checked_out');
  assert.equal(normalizeStatus('vrbo', 'Booked-Vrbo'), 'confirmed');
  assert.throws(() => normalizeStatus('mock', 'status-inventado'));
});

test('tarefas operacionais são derivadas da reserva', () => {
  const tasks = tasksForReservation({ checkin: '2026-03-10', checkout: '2026-03-14', guests: 2 });
  assert.deepEqual(
    tasks.map((t) => [t.type, t.dueDate]),
    [
      ['checkin', '2026-03-10'],
      ['cleaning', '2026-03-14'],
      ['checkout', '2026-03-14'],
    ],
  );
});

test('grupo grande adiciona tarefa de manutenção', () => {
  const tasks = tasksForReservation({ checkin: '2026-03-10', checkout: '2026-03-14', guests: 8 });
  assert.ok(tasks.some((t) => t.type === 'maintenance'));
});

test('validação de estadia reporta todos os erros de uma vez', () => {
  const result = validateStay({ checkin: '2026-03-10', checkout: '2026-03-11', guests: 9, minStay: 3, maxStay: 30, capacity: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join(' '), /mínima/);
  assert.match(result.errors.join(' '), /capacidade/);
});
