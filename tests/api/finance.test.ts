import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';
import { addDays, todayUtc } from '../../src/domain/dates.ts';

const BOOTSTRAP = 'finance-bootstrap';
let db: Db;
let app: FastifyInstance;
let auth: Record<string, string>;
let unitId: string;
let connectionId: string;
let listingExternalId: string;

const start = todayUtc();
const checkin = addDays(start, 30);
const checkout = addDays(start, 33);

before(async () => {
  db = openDatabase(':memory:');
  const registry = AdapterRegistry.withDefaults({ enableMock: true });
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
    payload: { orgName: 'Org Financeiro', userName: 'Financeiro' },
  });
  auth = { authorization: `Bearer ${(boot.json() as { token: string }).token}` };

  const onboard = await app.inject({
    method: 'POST',
    url: '/v1/onboarding',
    headers: auth,
    payload: {
      property: { name: 'Casa do Repasse', ownerName: 'Proprietária Ana', ownerSharePct: 70 },
      units: [{ name: 'Suíte', inventory: 1, basePriceCents: 45_000, minStay: 1 }],
    },
  });
  unitId = (onboard.json() as { units: { id: string }[] }).units[0]!.id;

  const connection = await app.inject({
    method: 'POST',
    url: '/v1/connections',
    headers: auth,
    payload: { channel: 'mock', label: 'Mock financeiro', status: 'active' },
  });
  connectionId = (connection.json() as { id: string }).id;
  const listing = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: auth,
    payload: { unitId, connectionId },
  });
  const listingId = (listing.json() as { id: string }).id;
  const published = await app.inject({ method: 'POST', url: `/v1/listings/${listingId}/publish`, headers: auth });
  listingExternalId = (published.json() as { externalId: string }).externalId;
});

after(async () => {
  await app.close();
  db.close();
});

const call = async <T>(method: string, url: string, payload?: unknown) => {
  const response = await app.inject({ method: method as 'GET', url, headers: auth, payload: payload as object });
  assert.ok(response.statusCode < 400, `${method} ${url} → ${response.statusCode}: ${response.body}`);
  return response.json() as T;
};

test('relatório de repasse calcula líquido e repasse sobre o líquido', async () => {
  await call('POST', '/v1/dev/mock/reservations', {
    connectionId,
    externalListingId: listingExternalId,
    externalId: 'FIN-1',
    checkin,
    checkout,
    guests: 2,
    totalCents: 135_000,
    commissionCents: 20_250,
  });

  const report = await call<{
    totals: { grossCents: number; commissionCents: number; netCents: number; ownerPayableCents: number };
    properties: { propertyName: string; ownerName: string; ownerSharePct: number; payout: { ownerPayableCents: number } }[];
    channels: { channel: string; netMarginPct: number }[];
    withoutLedger: number;
  }>('GET', `/v1/finance/payouts?from=${start}&to=${addDays(start, 120)}`);

  assert.equal(report.totals.grossCents, 135_000);
  assert.equal(report.totals.commissionCents, 20_250);
  assert.equal(report.totals.netCents, 114_750);
  assert.equal(report.totals.ownerPayableCents, 80_325);
  assert.equal(report.properties[0]?.ownerName, 'Proprietária Ana');
  assert.equal(report.properties[0]?.ownerSharePct, 70);
  assert.equal(report.properties[0]?.payout.ownerPayableCents, 80_325);
  assert.equal(report.channels[0]?.channel, 'mock');
  assert.equal(report.withoutLedger, 0);
});

test('período sem reservas devolve zeros, não erro', async () => {
  const report = await call<{ totals: { grossCents: number }; properties: unknown[] }>(
    'GET',
    `/v1/finance/payouts?from=${addDays(start, 300)}&to=${addDays(start, 320)}`,
  );
  assert.equal(report.totals.grossCents, 0);
  assert.equal(report.properties.length, 1);
});

test('período invertido é recusado', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/finance/payouts?from=${addDays(start, 40)}&to=${addDays(start, 20)}`,
    headers: auth,
  });
  assert.equal(response.statusCode, 400);
});

test('reconciliação detecta reserva sobreposta (overbooking)', async () => {
  // Segunda reserva na mesma unidade, sobrepondo 1 noite: é o que acontece quando
  // um canal não recebe a atualização de disponibilidade.
  await call('POST', '/v1/dev/mock/reservations', {
    connectionId,
    externalListingId: listingExternalId,
    externalId: 'FIN-2',
    checkin: addDays(checkin, 2),
    checkout: addDays(checkout, 1),
    guests: 2,
    totalCents: 90_000,
    commissionCents: 13_500,
  });

  const report = await call<{ counts: { critical: number }; issues: { kind: string; severity: string }[] }>(
    'GET',
    `/v1/reconciliation?from=${start}&to=${addDays(start, 120)}`,
  );
  assert.ok(report.counts.critical >= 1);
  assert.ok(report.issues.some((issue) => issue.kind === 'overlap' && issue.severity === 'critical'));
});

test('reconciliação acusa anúncio publicado sem id externo', async () => {
  const listing = await call<{ id: string }>('POST', '/v1/listings', { unitId, connectionId: connectionId });
  // publicamos e depois apagamos o id externo direto no banco: estado impossível
  // que só um bug produziria — exatamente o que a reconciliação precisa pegar.
  await call('POST', `/v1/listings/${listing.id}/publish`);
  db.prepare('UPDATE listings SET external_id = NULL WHERE id = ?').run(listing.id);

  const report = await call<{ issues: { kind: string; listingId?: string }[] }>(
    'GET',
    `/v1/reconciliation?from=${start}&to=${addDays(start, 120)}`,
  );
  assert.ok(report.issues.some((issue) => issue.kind === 'listing_without_external_id' && issue.listingId === listing.id));
});

test('RBAC: papel operations não lê financeiro', async () => {
  const token = await call<{ token: string }>('POST', '/v1/tokens', { userName: 'Operação', role: 'operations' });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/finance/payouts?from=${start}&to=${addDays(start, 120)}`,
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(response.statusCode, 403);
});
