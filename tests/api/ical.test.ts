import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';
import { addDays, todayUtc } from '../../src/domain/dates.ts';

const BOOTSTRAP = 'ical-bootstrap';
const start = todayUtc();
const base = addDays(start, 40);

let db: Db;
let app: FastifyInstance;
let auth: Record<string, string>;
let unitId: string;
let feedServer: Server;
let feedUrl: string;
let feedBody = '';
let feedStatus = 200;

/** Feed muda conforme `feedBody`: simula cancelamento e alteração no canal. */
const ics = (events: { uid: string; start: string; end: string; status?: string }[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Airbnb//iCal//PT',
    ...events.flatMap((event) => [
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTART;VALUE=DATE:${event.start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${event.end.replace(/-/g, '')}`,
      'SUMMARY:Reserved (Airbnb)',
      ...(event.status ? [`STATUS:${event.status}`] : []),
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');

before(async () => {
  feedServer = createServer((_request, response) => {
    response.writeHead(feedStatus, { 'content-type': 'text/calendar; charset=utf-8' });
    response.end(feedBody);
  });
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const { port } = feedServer.address() as AddressInfo;
  feedUrl = `http://127.0.0.1:${port}/calendar.ics`;

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
    payload: { orgName: 'Org iCal', userName: 'Gestor' },
  });
  auth = { authorization: `Bearer ${(boot.json() as { token: string }).token}` };

  const onboard = await app.inject({
    method: 'POST',
    url: '/v1/onboarding',
    headers: auth,
    payload: {
      property: { name: 'Casa iCal' },
      units: [{ name: 'Suíte', inventory: 1, basePriceCents: 40_000, minStay: 1 }],
    },
  });
  unitId = (onboard.json() as { units: { id: string }[] }).units[0]!.id;
});

after(async () => {
  await app.close();
  db.close();
  await new Promise<void>((resolve) => feedServer.close(() => resolve()));
});

const call = async <T>(method: string, url: string, payload?: unknown, headers = auth) => {
  const response = await app.inject({ method: method as 'GET', url, headers, payload: payload as object });
  return { status: response.statusCode, body: response.body, json: () => response.json() as T };
};

const availability = async (date: string) => {
  const result = await call<{ date: string; available: number; blocked: boolean; reserved: number }[]>(
    'GET',
    `/v1/units/${unitId}/availability?from=${date}&to=${addDays(date, 1)}`,
  );
  return result.json()[0]!;
};

test('fonte iCal é criada e valida a URL', async () => {
  const invalida = await call('POST', `/v1/units/${unitId}/ical-sources`, { url: 'ftp://x/y.ics' });
  assert.equal(invalida.status, 400);

  const criada = await call<{ id: string; label: string; lastStatus: string | null }>(
    'POST',
    `/v1/units/${unitId}/ical-sources`,
    { url: feedUrl, label: 'Airbnb' },
  );
  assert.equal(criada.status, 201);
  assert.equal(criada.json().label, 'Airbnb');
  assert.equal(criada.json().lastStatus, null);
});

test('primeira sincronização cria bloqueios e zera a disponibilidade', async () => {
  feedBody = ics([
    { uid: 'airbnb-1@airbnb.com', start: base, end: addDays(base, 3) },
    { uid: 'airbnb-2@airbnb.com', start: addDays(base, 10), end: addDays(base, 12) },
  ]);
  const source = (await call<{ id: string }[]>('GET', `/v1/units/${unitId}/ical-sources`)).json()[0]!;

  const sync = await call<{ status: string; message: string; imported: { created: number } }>(
    'POST',
    `/v1/ical-sources/${source.id}/sync`,
  );
  assert.equal(sync.status, 200);
  assert.equal(sync.json().status, 'ok');
  assert.equal(sync.json().imported.created, 2);

  assert.equal((await availability(base)).available, 0, 'primeira noite bloqueada');
  assert.equal((await availability(addDays(base, 1))).available, 0, 'segunda noite bloqueada');
  assert.equal((await availability(addDays(base, 3))).available, 1, 'checkout libera a noite');
  assert.equal((await availability(addDays(base, 11))).blocked, true);
});

test('reservar em noite bloqueada pelo canal é recusado', async () => {
  const response = await call('POST', '/v1/reservations', {
    unitId,
    checkin: base,
    checkout: addDays(base, 2),
    guests: 2,
  });
  assert.ok(response.status >= 400, 'a noite já está vendida no canal');
});

test('reimportar é idempotente: não duplica bloqueio', async () => {
  const source = (await call<{ id: string }[]>('GET', `/v1/units/${unitId}/ical-sources`)).json()[0]!;
  const sync = await call<{ imported: { created: number; updated: number; removed: number } }>(
    'POST',
    `/v1/ical-sources/${source.id}/sync`,
  );
  assert.deepEqual(sync.json().imported, { total: 2, created: 0, updated: 0, removed: 0 });
});

test('cancelamento no canal libera a noite; evento adiado move o bloqueio', async () => {
  feedBody = ics([{ uid: 'airbnb-1@airbnb.com', start: addDays(base, 20), end: addDays(base, 23) }]);
  const source = (await call<{ id: string }[]>('GET', `/v1/units/${unitId}/ical-sources`)).json()[0]!;
  const sync = await call<{ imported: { created: number; updated: number; removed: number } }>(
    'POST',
    `/v1/ical-sources/${source.id}/sync`,
  );
  assert.deepEqual(sync.json().imported, { total: 1, created: 0, updated: 1, removed: 1 });

  assert.equal((await availability(base)).available, 1, 'noite liberada após cancelamento');
  assert.equal((await availability(addDays(base, 11))).available, 1, 'evento removido libera o período');
  assert.equal((await availability(addDays(base, 21))).available, 0, 'bloqueio mudou de data');
});

test('feed indisponível não apaga bloqueio existente e registra o erro', async () => {
  feedStatus = 500;
  const source = (await call<{ id: string }[]>('GET', `/v1/units/${unitId}/ical-sources`)).json()[0]!;
  const sync = await call<{ status: string; message: string }>('POST', `/v1/ical-sources/${source.id}/sync`);
  assert.equal(sync.json().status, 'error');
  assert.match(sync.json().message, /500/);
  feedStatus = 200;

  const listed = (await call<{ lastStatus: string; lastError: string }[]>(
    'GET',
    `/v1/units/${unitId}/ical-sources`,
  )).json()[0]!;
  assert.equal(listed.lastStatus, 'error');
  assert.match(listed.lastError, /500/);
  assert.equal((await availability(addDays(base, 21))).available, 0, 'agenda continua fechada com o que se sabia');
});

test('feed de exportação é público, sem login, e reflete bloqueio manual', async () => {
  const manualStart = addDays(base, 60);
  await call('POST', `/v1/units/${unitId}/blocks`, {
    startDate: manualStart,
    endDate: addDays(manualStart, 2),
    reason: 'Manutenção',
  });

  const feed = await call<{ url: string; token: string }>('GET', `/v1/units/${unitId}/ical-feed`);
  assert.match(feed.json().url, /^\/v1\/ical\/ifs_[a-z0-9]+\.ics$/);

  const publicResponse = await app.inject({ method: 'GET', url: feed.json().url });
  assert.equal(publicResponse.statusCode, 200);
  assert.match(publicResponse.headers['content-type'] as string, /text\/calendar/);
  const body = publicResponse.body;
  assert.ok(body.includes(`DTSTART;VALUE=DATE:${manualStart.replace(/-/g, '')}`));
  assert.ok(body.includes('Indisponível: Manutenção'));
  // bloqueio importado do canal não pode voltar no feed exportado (eco/loop)
  assert.ok(!body.includes('Reservado (Airbnb)'), 'evento importado não é reexportado');
});

test('token de feed inválido responde 404', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/ical/ifs_naoexiste.ics' });
  assert.equal(response.statusCode, 404);
});

test('remover a fonte apaga os bloqueios que ela criou', async () => {
  const source = (await call<{ id: string }[]>('GET', `/v1/units/${unitId}/ical-sources`)).json()[0]!;
  const removed = await call<{ removedBlocks: number }>('DELETE', `/v1/ical-sources/${source.id}`);
  assert.equal(removed.json().removedBlocks, 1);
  assert.equal((await availability(addDays(base, 21))).available, 1);
});
