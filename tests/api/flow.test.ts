import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';
import type { MockChannelAdapter } from '../../src/connectivity/adapters/mock.ts';
import { addDays, todayUtc } from '../../src/domain/dates.ts';
import type { FastifyInstance } from 'fastify';

const BOOTSTRAP = 'test-bootstrap';
let db: Db;
let app: FastifyInstance;
let mock: MockChannelAdapter;
let AUTH: Record<string, string> = {};
let ORG_ID = '';

const start = todayUtc();

before(async () => {
  db = openDatabase(':memory:');
  const registry = AdapterRegistry.withDefaults({ enableMock: true });
  mock = registry.get('mock') as unknown as MockChannelAdapter;
  app = createApp({
    db,
    registry,
    startWorker: false,
    config: {
      env: 'test',
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      bootstrapKey: BOOTSTRAP,
      dispatcher: { intervalMs: 60_000, batchSize: 50, maxAttempts: 6, baseBackoffMs: 1000, maxBackoffMs: 60_000 },
      enableMockChannel: true,
    },
  });
  await app.ready();

  const boot = await app.inject({
    method: 'POST',
    url: '/v1/bootstrap',
    headers: { 'x-bootstrap-key': BOOTSTRAP },
    payload: { orgName: 'Org Teste', userName: 'Operador Teste' },
  });
  assert.equal(boot.statusCode, 201, boot.body);
  const body = boot.json() as { organization: { id: string }; token: string };
  ORG_ID = body.organization.id;
  AUTH = { authorization: `Bearer ${body.token}` };
});

after(async () => {
  await app.close();
  db.close();
});

/** Esvazia o outbox para que um teste não herde eventos pendentes dos anteriores. */
async function drainOutbox(limit = 20): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const report = await api<{ processed: number }>('POST', '/v1/outbox/dispatch');
    if (report.processed === 0) return;
  }
}

async function api<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method: method as 'GET', url, headers: AUTH, payload: payload as object });
  assert.ok(response.statusCode < 400, `${method} ${url} → ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

/** Monta o cenário base e devolve os ids usados nos testes. */
async function scenario() {
  const org = { id: ORG_ID };
  const property = await api<{ id: string }>('POST', '/v1/properties', { name: 'Casa Teste' });
  const unit = await api<{ id: string }>('POST', `/v1/properties/${property.id}/units`, { name: 'Suíte', inventory: 1 });
  await api('POST', `/v1/units/${unit.id}/rate-plans`, {
    name: 'Flexível',
    basePriceCents: 40_000,
    weekendUpliftPct: 20,
    cleaningFeeCents: 10_000,
    minStay: 1,
  });
  const conn = await api<{ id: string }>('POST', '/v1/connections', {
    channel: 'mock',
    label: `Mock ${Math.random()}`,
    status: 'active',
  });
  const listing = await api<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: conn.id });
  return { org, property, unit, conn, listing };
}

test('health não exige autenticação e lista os canais', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.json().channels.length, 7);
});

test('requisição sem chave responde 401', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/channels' });
  assert.equal(response.statusCode, 401);
  const invalid = await app.inject({ method: 'GET', url: '/v1/channels', headers: { authorization: 'Bearer hsk_invalido' } });
  assert.equal(invalid.statusCode, 401);
});

test('publicação exige conexão ativa', async () => {
  const { org, unit } = await scenario();
  const pending = await api<{ id: string }>('POST', '/v1/connections', {
    channel: 'mock',
    label: `Pendente ${Math.random()}`,
    status: 'pending',
  });
  const listing = await api<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: pending.id });
  const response = await app.inject({ method: 'POST', url: `/v1/listings/${listing.id}/publish`, headers: AUTH });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().message, /ative antes de publicar/);
});

test('publicar cria id externo e sincroniza o calendário existente', async () => {
  const { unit, listing } = await scenario();
  const days = [{ date: addDays(start, 10), rateCents: 33_000, available: 1 }];
  await api('PUT', `/v1/units/${unit.id}/ari`, { days });

  const published = await api<{ externalId: string; daysSynced: number }>('POST', `/v1/listings/${listing.id}/publish`);
  assert.match(published.externalId, /^MOCK-/);
  // Publicar sincroniza a janela inteira (365 dias), não só o que já existe no calendário.
  assert.equal(published.daysSynced, 365);
  assert.equal(mock.snapshot(published.externalId)[days[0]!.date]?.rateCents, 33_000);
  assert.equal(mock.snapshot(published.externalId)[days[0]!.date]?.available, 1);
});

test('ARI enfileira um evento por anúncio publicado e o dispatcher entrega', async () => {
  const { unit, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);

  const ari = await api<{ daysWritten: number; events: number }>('PUT', `/v1/units/${unit.id}/ari`, {
    days: [
      { date: addDays(start, 30), rateCents: 51_000, available: 1 },
      { date: addDays(start, 31), rateCents: 52_000, available: 0, minStay: 3 },
    ],
  });
  assert.equal(ari.daysWritten, 2);
  assert.equal(ari.events, 2);

  const report = await api<{ sent: number; dead: number }>('POST', '/v1/outbox/dispatch');
  assert.equal(report.dead, 0);
  assert.ok(report.sent >= 2);

  const snapshot = mock.snapshot(published.externalId);
  assert.equal(snapshot[addDays(start, 30)]?.rateCents, 51_000);
  assert.equal(snapshot[addDays(start, 30)]?.available, 1);
  assert.equal(snapshot[addDays(start, 31)]?.minStay, 3);
});

test('falha transitória do canal entra em retry com backoff, sem perder o evento', async () => {
  const { unit, listing } = await scenario();
  await drainOutbox();
  await api('POST', `/v1/listings/${listing.id}/publish`);
  await drainOutbox();
  mock.failNext(1);

  // Só disponibilidade: UM evento por anúncio publicado, para isolar a falha.
  await api('PUT', `/v1/units/${unit.id}/ari`, { days: [{ date: addDays(start, 40), available: 1 }] });
  const first = await api<{ retried: number; sent: number }>('POST', '/v1/outbox/dispatch');
  assert.equal(first.retried, 1);
  assert.equal(first.sent, 0, 'a chamada que falhou não pode ser contada como enviada');

  const outbox = await api<{
    stats: Record<string, number>;
    events: { status: string; attempts: number; lastError: string }[];
  }>('GET', '/v1/outbox?status=pending');
  const retried = outbox.events.find((event) => event.attempts > 0);
  assert.ok(retried, 'evento que falhou deve voltar para a fila');
  assert.equal(retried.attempts, 1);
  assert.match(retried.lastError, /falha simulada/);
  assert.equal(outbox.stats.dead, 0, 'falha transitória não pode virar dead-letter');
});

test('reserva do canal reduz disponibilidade, cria tarefas e lança financeiro', async () => {
  const { org, unit, conn, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);

  const checkin = addDays(start, 50);
  const checkout = addDays(start, 53);
  const ingest = await api<{ reservationId: string; created: boolean; tasksCreated: number }>(
    'POST',
    '/v1/dev/mock/reservations',
    {
      connectionId: conn.id,
      externalListingId: published.externalId,
      externalId: 'EXT-900',
      checkin,
      checkout,
      guests: 2,
      totalCents: 120_000,
      commissionCents: 18_000,
    },
  );
  assert.equal(ingest.created, true);
  assert.equal(ingest.tasksCreated, 3);

  const availability = await api<{ date: string; available: number }[]>(
    'GET',
    `/v1/units/${unit.id}/availability?from=${checkin}&to=${checkout}`,
  );
  assert.ok(availability.every((day) => day.available === 0));

  const detail = await api<{ ledger: unknown[]; netCents: number }>('GET', `/v1/reservations/${ingest.reservationId}`);
  assert.equal(detail.ledger.length, 2);
  assert.equal(detail.netCents, 102_000);

  const tasks = await api<unknown[]>('GET', `/v1/tasks?orgId=${org.id}`);
  assert.equal(tasks.length, 3);
});

test('webhook repetido não duplica reserva nem tarefas', async () => {
  const { unit, conn, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);
  const payload = {
    connectionId: conn.id,
    externalListingId: published.externalId,
    externalId: 'EXT-901',
    checkin: addDays(start, 60),
    checkout: addDays(start, 62),
    guests: 2,
    totalCents: 80_000,
  };

  const first = await api<{ created: boolean }>('POST', '/v1/dev/mock/reservations', payload);
  const second = await api<{ created: boolean }>('POST', '/v1/dev/mock/reservations', payload);
  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const rows = db.prepare('SELECT COUNT(*) AS total FROM reservations WHERE unit_id = ?').get(unit.id) as { total: number };
  assert.equal(Number(rows.total), 1);
});

test('webhook parcial não zera valores financeiros já gravados', async () => {
  const { conn, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);
  const base = {
    connectionId: conn.id,
    externalListingId: published.externalId,
    externalId: 'EXT-PARTIAL',
    checkin: addDays(start, 65),
    checkout: addDays(start, 67),
    guests: 2,
  };

  const created = await api<{ reservationId: string }>('POST', '/v1/dev/mock/reservations', {
    ...base,
    totalCents: 90_000,
    commissionCents: 13_500,
  });
  // Mesma reserva, payload sem valores: o total não pode ser sobrescrito por zero.
  await api('POST', '/v1/dev/mock/reservations', base);

  const detail = await api<{ reservation: { totalCents: number; commissionCents: number }; netCents: number }>(
    'GET',
    `/v1/reservations/${created.reservationId}`,
  );
  assert.equal(detail.reservation.totalCents, 90_000);
  assert.equal(detail.reservation.commissionCents, 13_500);
  assert.equal(detail.netCents, 76_500);
});

test('cancelamento libera a disponibilidade de novo', async () => {
  const { unit, conn, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);
  const checkin = addDays(start, 70);
  const checkout = addDays(start, 72);

  const ingest = await api<{ reservationId: string }>('POST', '/v1/dev/mock/reservations', {
    connectionId: conn.id,
    externalListingId: published.externalId,
    externalId: 'EXT-902',
    checkin,
    checkout,
    guests: 2,
  });

  await api('POST', `/v1/reservations/${ingest.reservationId}/status`, { status: 'cancelled' });
  const availability = await api<{ available: number }[]>(
    'GET',
    `/v1/units/${unit.id}/availability?from=${checkin}&to=${checkout}`,
  );
  assert.ok(availability.every((day) => day.available === 1));
});

test('ARI recusa disponibilidade acima do inventário', async () => {
  const { unit } = await scenario();
  const response = await app.inject({
    method: 'PUT',
    url: `/v1/units/${unit.id}/ari`,
    headers: AUTH,
    payload: { days: [{ date: addDays(start, 85), available: 3 }] },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /excede o inventário/);
});

test('bloqueio manual fecha as datas e propaga ao canal', async () => {
  const { unit, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);
  const from = addDays(start, 80);

  await api('POST', `/v1/units/${unit.id}/blocks`, { startDate: from, endDate: addDays(start, 82), reason: 'manutenção' });
  await api('POST', '/v1/outbox/dispatch');

  const snapshot = mock.snapshot(published.externalId);
  assert.equal(snapshot[from]?.available, 0);
  assert.equal(snapshot[from]?.closed, true);
});

test('cotação aplica mínimo de noites e devolve total com limpeza', async () => {
  const { unit } = await scenario();
  const quote = await api<{ nights: number; totalCents: number }>(
    'GET',
    `/v1/units/${unit.id}/quote?checkin=${addDays(start, 100)}&checkout=${addDays(start, 103)}`,
  );
  assert.equal(quote.nights, 3);
  assert.ok(quote.totalCents > 0);

  const tooShort = await app.inject({
    method: 'GET',
    url: `/v1/units/${unit.id}/quote?checkin=${addDays(start, 100)}&checkout=${addDays(start, 100)}`,
    headers: AUTH,
  });
  assert.equal(tooShort.statusCode, 422);
});

test('canal não certificado responde 409 e não polui o outbox', async () => {
  const org = { id: ORG_ID };
  const property = await api<{ id: string }>('POST', '/v1/properties', { name: 'Casa' });
  const unit = await api<{ id: string }>('POST', `/v1/properties/${property.id}/units`, { name: 'U' });
  const booking = await api<{ id: string }>('POST', '/v1/connections', {
    channel: 'booking',
    label: 'Booking',
    status: 'active',
  });
  const listing = await api<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: booking.id });

  const response = await app.inject({ method: 'POST', url: `/v1/listings/${listing.id}/publish`, headers: AUTH });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'channel_not_certified');
});

test('auditoria registra publicação, reserva e mudança de status', async () => {
  const { conn, listing } = await scenario();
  const published = await api<{ externalId: string }>('POST', `/v1/listings/${listing.id}/publish`);
  const ingest = await api<{ reservationId: string }>('POST', '/v1/dev/mock/reservations', {
    connectionId: conn.id,
    externalListingId: published.externalId,
    externalId: `EXT-${Math.random()}`,
    checkin: addDays(start, 110),
    checkout: addDays(start, 112),
    guests: 2,
  });
  await api('POST', `/v1/reservations/${ingest.reservationId}/status`, { status: 'checked_in' });

  const events = await api<{ type: string }[]>('GET', `/v1/audit?scope=reservation&refId=${ingest.reservationId}`);
  assert.ok(events.some((event) => event.type === 'reservation.created'));
  assert.ok(events.some((event) => event.type === 'reservation.status_changed'));
});
