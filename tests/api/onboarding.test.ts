import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';

const BOOTSTRAP = 'onboarding-bootstrap';
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let db: Db;
let app: FastifyInstance;
let auth: Record<string, string>;
let storageDir: string;
let propertyId: string;
let unitId: string;

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'hosfera-photos-'));
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
      uploadDir: storageDir,
    },
  });
  await app.ready();

  const boot = await app.inject({
    method: 'POST',
    url: '/v1/bootstrap',
    headers: { 'x-bootstrap-key': BOOTSTRAP },
    payload: { orgName: 'Org Onboarding', userName: 'Gestor' },
  });
  auth = { authorization: `Bearer ${(boot.json() as { token: string }).token}` };

  const onboard = await app.inject({
    method: 'POST',
    url: '/v1/onboarding',
    headers: auth,
    payload: {
      property: {
        name: 'Casa Onboarding',
        city: 'Mata de São João',
        ownerName: 'Proprietária Ana',
        ownerEmail: 'ana@example.com',
        ownerSharePct: 65,
      },
      units: [
        {
          name: 'Suíte Aurora',
          inventory: 1,
          capacity: 4,
          basePriceCents: 48_000,
          cleaningFeeCents: 15_000,
          weekendUpliftPct: 25,
          minStay: 2,
          amenities: ['Wi-Fi', 'piscina', 'pet'],
        },
        { name: 'Loft Maré', inventory: 2, capacity: 2, basePriceCents: 32_000, minStay: 1 },
      ],
    },
  });
  assert.equal(onboard.statusCode, 201, onboard.body);
  const body = onboard.json() as { propertyId: string; units: { id: string }[] };
  propertyId = body.propertyId;
  unitId = body.units[0]!.id;
});

after(async () => {
  await app.close();
  db.close();
  rmSync(storageDir, { recursive: true, force: true });
});

const call = async <T>(method: string, url: string, payload?: unknown) => {
  const response = await app.inject({ method: method as 'GET', url, headers: auth, payload: payload as object });
  return response.json() as T;
};

test('onboarding cria imóvel, unidades, tarifa e comodidades em uma transação', async () => {
  const units = await call<{ id: string; capacity: number; checkinFrom: string }[]>(
    'GET',
    `/v1/properties/${propertyId}/units`,
  );
  assert.equal(units.length, 2);
  assert.equal(units.find((unit) => unit.id === unitId)?.capacity, 4);
  assert.equal(units.find((unit) => unit.id === unitId)?.checkinFrom, '15:00');

  const plans = await call<{ basePriceCents: number; weekendUpliftPct: number }[]>(
    'GET',
    `/v1/units/${unitId}/rate-plans`,
  );
  assert.equal(plans.length, 1, 'toda unidade nasce com tarifa — sem tarifa ela não vende');
  assert.equal(plans[0]?.basePriceCents, 48_000);
  assert.equal(plans[0]?.weekendUpliftPct, 25);
});

test('onboarding inválido não cria nada (transação atômica)', async () => {
  const before = db.prepare('SELECT COUNT(*) AS total FROM properties').get() as { total: number };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/onboarding',
    headers: auth,
    payload: { property: { name: 'Casa Inválida' }, units: [{ name: 'X', basePriceCents: 0 }] },
  });
  assert.equal(response.statusCode, 400);
  const after = db.prepare('SELECT COUNT(*) AS total FROM properties').get() as { total: number };
  assert.equal(Number(after.total), Number(before.total), 'nada pode ter sido criado');
});

test('comodidade inventada é recusada com 400', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/v1/units/${unitId}/amenities`,
    headers: auth,
    payload: { codes: ['wifi', 'jacuzzi_presidencial'] },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /comodidade desconhecida/);
});

test('comodidades são gravadas normalizadas', async () => {
  const result = await call<{ amenities: string[] }>('PUT', `/v1/units/${unitId}/amenities`, {
    codes: ['Wi-Fi', 'churrasqueira', 'wifi'],
  });
  assert.deepEqual(result.amenities, ['churrasqueira', 'wifi']);
});

test('duplicar unidade copia tarifa e comodidades', async () => {
  const copy = await call<{ unitId: string; copiedRatePlans: number; copiedAmenities: number }>(
    'POST',
    `/v1/units/${unitId}/duplicate`,
    { name: 'Suíte Aurora 2' },
  );
  assert.equal(copy.copiedRatePlans, 1);
  assert.equal(copy.copiedAmenities, 2);

  const plans = await call<{ basePriceCents: number }[]>('GET', `/v1/units/${copy.unitId}/rate-plans`);
  assert.equal(plans[0]?.basePriceCents, 48_000, 'cópia sem preço não vende');
});

test('foto é validada pelo conteúdo e servida com o content-type correto', async () => {
  const created = await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/photos`,
    headers: auth,
    payload: { dataBase64: PNG_1X1, contentType: 'image/png' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const photo = created.json() as { id: string; url: string; bytes: number };
  assert.equal(photo.bytes, Buffer.from(PNG_1X1, 'base64').length);

  const image = await app.inject({ method: 'GET', url: `${photo.url}?t=${auth.authorization?.slice(7)}` });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(image.headers.etag);
});

test('foto sem token não é servida', async () => {
  const photos = await call<{ id: string }[]>('GET', `/v1/units/${unitId}/photos`);
  const response = await app.inject({ method: 'GET', url: `/v1/photos/${photos[0]?.id}` });
  assert.equal(response.statusCode, 401);
});

test('mesma foto não duplica registro nem arquivo', async () => {
  const first = await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/photos`,
    headers: auth,
    payload: { dataBase64: PNG_1X1, contentType: 'image/png' },
  });
  const before = db.prepare('SELECT COUNT(*) AS total FROM unit_photos WHERE unit_id = ?').get(unitId) as { total: number };
  const again = await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/photos`,
    headers: auth,
    payload: { dataBase64: PNG_1X1, contentType: 'image/png' },
  });
  const after = db.prepare('SELECT COUNT(*) AS total FROM unit_photos WHERE unit_id = ?').get(unitId) as { total: number };
  assert.equal(Number(after.total), Number(before.total));
  assert.equal((again.json() as { id: string }).id, (first.json() as { id: string }).id);
});

test('arquivo que não é imagem é recusado', async () => {
  const notImage = Buffer.from('#!/bin/sh\necho oi\n').toString('base64');
  const response = await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/photos`,
    headers: auth,
    payload: { dataBase64: notImage, contentType: 'image/png' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /formato não suportado/);
});

test('unidade de outra organização responde 404', async () => {
  const other = await app.inject({
    method: 'POST',
    url: '/v1/bootstrap',
    headers: { 'x-bootstrap-key': BOOTSTRAP },
    payload: { orgName: 'Outra Org', userName: 'Outro' },
  });
  const otherAuth = { authorization: `Bearer ${(other.json() as { token: string }).token}` };
  const response = await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/photos`,
    headers: otherAuth,
    payload: { dataBase64: PNG_1X1, contentType: 'image/png' },
  });
  assert.equal(response.statusCode, 404);
});

test('catálogo de comodidades é público para a organização', async () => {
  const catalog = await call<{ code: string; label: string }[]>('GET', '/v1/amenities');
  assert.ok(catalog.length >= 10);
  assert.ok(catalog.some((amenity) => amenity.code === 'wifi' && amenity.label === 'Wi-Fi'));
});
