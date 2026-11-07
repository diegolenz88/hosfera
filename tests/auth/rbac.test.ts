import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';

const BOOTSTRAP = 'rbac-bootstrap';
let db: Db;
let app: FastifyInstance;
let owner: string;
let orgId: string;

const H = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  db = openDatabase(':memory:');
  app = createApp({
    db,
    registry: AdapterRegistry.withDefaults({ enableMock: true }),
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
    payload: { orgName: 'Org RBAC', userName: 'Dona' },
  });
  const body = boot.json() as { organization: { id: string }; token: string };
  owner = body.token;
  orgId = body.organization.id;
});

after(async () => {
  await app.close();
  db.close();
});

async function issue(role: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tokens',
    headers: H(owner),
    payload: { userName: `user-${role}`, role },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { token: string }).token;
}

test('bootstrap exige a chave de ambiente', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/bootstrap',
    headers: { 'x-bootstrap-key': 'errada' },
    payload: { orgName: 'X', userName: 'Y' },
  });
  assert.equal(response.statusCode, 401);
});

test('token é exibido uma única vez e nunca em texto claro no banco', async () => {
  const token = await issue('viewer');
  const row = db.prepare('SELECT token_hash FROM api_tokens ORDER BY created_at DESC LIMIT 1').get() as { token_hash: string };
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);

  const list = await app.inject({ method: 'GET', url: '/v1/tokens', headers: H(owner) });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(token), 'a listagem não pode devolver o segredo');
});

test('sem token ou com token inventado responde 401', async () => {
  const none = await app.inject({ method: 'GET', url: '/v1/properties' });
  assert.equal(none.statusCode, 401);
  const fake = await app.inject({ method: 'GET', url: '/v1/properties', headers: H('hsk_inventado_123456') });
  assert.equal(fake.statusCode, 401);
});

test('papel viewer lê mas não escreve', async () => {
  const viewer = await issue('viewer');
  const property = await app.inject({
    method: 'POST',
    url: '/v1/properties',
    headers: H(owner),
    payload: { name: 'Casa Viewer' },
  });
  const propertyId = (property.json() as { id: string }).id;

  const read = await app.inject({ method: 'GET', url: '/v1/properties', headers: H(viewer) });
  assert.equal(read.statusCode, 200);

  const write = await app.inject({
    method: 'POST',
    url: '/v1/properties',
    headers: H(viewer),
    payload: { name: 'Proibida' },
  });
  assert.equal(write.statusCode, 403);
  assert.equal(write.json().error, 'forbidden');

  const ari = await app.inject({
    method: 'PUT',
    url: `/v1/units/inexistente/ari`,
    headers: H(viewer),
    payload: { days: [{ date: '2027-01-01', rateCents: 1000 }] },
  });
  assert.equal(ari.statusCode, 403, 'autorização vem antes de existência');
  void propertyId;
});

test('papel financeiro vê dinheiro e não altera inventário', async () => {
  const finance = await issue('finance');
  const summary = await app.inject({ method: 'GET', url: '/v1/summary', headers: H(finance) });
  assert.equal(summary.statusCode, 200);

  const property = await app.inject({
    method: 'POST',
    url: '/v1/properties',
    headers: H(finance),
    payload: { name: 'Casa Finance' },
  });
  assert.equal(property.statusCode, 403);
});

test('papel operations mexe em reserva e tarefa, não em conexão', async () => {
  const operations = await issue('operations');
  const tasks = await app.inject({ method: 'GET', url: '/v1/tasks', headers: H(operations) });
  assert.equal(tasks.statusCode, 200);

  const connection = await app.inject({
    method: 'POST',
    url: '/v1/connections',
    headers: H(operations),
    payload: { channel: 'mock', label: 'não pode' },
  });
  assert.equal(connection.statusCode, 403);
});

test('isolamento entre organizações: recurso de outra org responde 404', async () => {
  const other = await app.inject({
    method: 'POST',
    url: '/v1/bootstrap',
    headers: { 'x-bootstrap-key': BOOTSTRAP },
    payload: { orgName: 'Outra Org', userName: 'Outro' },
  });
  const otherToken = (other.json() as { token: string }).token;

  const property = await app.inject({
    method: 'POST',
    url: '/v1/properties',
    headers: H(owner),
    payload: { name: 'Casa Minha' },
  });
  const propertyId = (property.json() as { id: string }).id;

  const units = await app.inject({
    method: 'GET',
    url: `/v1/properties/${propertyId}/units`,
    headers: H(otherToken),
  });
  assert.equal(units.statusCode, 404);

  const list = await app.inject({ method: 'GET', url: '/v1/properties', headers: H(otherToken) });
  assert.deepEqual(list.json(), [], 'a listagem não pode vazar imóveis de outra org');
});

test('orgId divergente do token é recusado', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/properties?orgId=00000000-0000-0000-0000-000000000000',
    headers: H(owner),
  });
  assert.equal(response.statusCode, 403);
});

test('token revogado deixa de autenticar e o evento fica auditado', async () => {
  const token = await issue('manager');
  const created = db.prepare("SELECT id FROM api_tokens WHERE role = 'manager' ORDER BY created_at DESC LIMIT 1").get() as { id: string };

  const revoke = await app.inject({ method: 'DELETE', url: `/v1/tokens/${created.id}`, headers: H(owner) });
  assert.equal(revoke.statusCode, 204);

  const after = await app.inject({ method: 'GET', url: '/v1/properties', headers: H(token) });
  assert.equal(after.statusCode, 401);

  const events = db.prepare("SELECT COUNT(*) AS total FROM auth_events WHERE action = 'token.revoked'").get() as { total: number };
  assert.ok(Number(events.total) >= 1);
});

test('health e UI são públicos; API não', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);

  const ui = await app.inject({ method: 'GET', url: '/' });
  assert.equal(ui.statusCode, 200);
  assert.match(ui.body, /hosfera/);

  const api = await app.inject({ method: 'GET', url: '/v1/summary' });
  assert.equal(api.statusCode, 401);
  void orgId;
});
