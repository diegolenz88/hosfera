import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { createApp } from '../../src/http/app.ts';
import { AdapterRegistry } from '../../src/connectivity/registry.ts';
import { BookingAdapter } from '../../src/connectivity/adapters/booking/adapter.ts';
import { MemoryTransport } from '../../src/connectivity/adapters/booking/transport.ts';

const BOOTSTRAP = 'booking-bootstrap';
const SECRET = 'webhook-value';
let db: Db;
let app: FastifyInstance;
let auth: Record<string, string>;
let connectionId: string;
let unitId: string;
let transport: MemoryTransport;

const reservationXml = (id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OTA_HotelResNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="echo-1" TimeStamp="2026-11-06T12:00:00Z" Version="1.0">
  <HotelReservations>
    <HotelReservation ResStatus="Commit">
      <UniqueID Type="14" ID="${id}"/>
      <RoomStays>
        <RoomStay>
          <RoomTypes><RoomType RoomTypeCode="ROOM-1"/></RoomTypes>
          <TimeSpan Start="2026-12-20" End="2026-12-23"/>
          <Total AmountAfterTax="1350.00" CurrencyCode="BRL"/>
          <BasicPropertyInfo HotelCode="HOTEL-1"/>
        </RoomStay>
      </RoomStays>
      <ResGuests>
        <ResGuest><Profiles><ProfileInfo><Profile><Customer>
          <PersonName><GivenName>Maria</GivenName><Surname>Silva</Surname></PersonName>
        </Customer></Profile></ProfileInfo></Profiles></ResGuest>
      </ResGuests>
    </HotelReservation>
  </HotelReservations>
</OTA_HotelResNotifRQ>`;

before(async () => {
  db = openDatabase(':memory:');
  transport = new MemoryTransport(() => ({
    status: 200,
    body: '<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05"><Success/></OTA_HotelAvailNotifRS>',
  }));
  const booking = new BookingAdapter({
    credentials: {
      machineAccount: 'MACHINE-ACCOUNT',
      auth: { user: 'MACHINE-ACCOUNT', value: 'opaque-value' },
      hotelCode: 'HOTEL-1',
    },
    certified: true,
    transport,
    webhookSecret: SECRET,
  });
  const registry = AdapterRegistry.withDefaults();
  registry.register(booking);

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
    payload: { orgName: 'Org Booking', userName: 'Operador' },
  });
  const body = boot.json() as { token: string };
  auth = { authorization: `Bearer ${body.token}` };

  const property = await app.inject({ method: 'POST', url: '/v1/properties', headers: auth, payload: { name: 'Casa Booking' } });
  const propertyId = (property.json() as { id: string }).id;
  const unit = await app.inject({
    method: 'POST',
    url: `/v1/properties/${propertyId}/units`,
    headers: auth,
    payload: { name: 'Suíte', inventory: 1, minStay: 2 },
  });
  unitId = (unit.json() as { id: string }).id;
  await app.inject({
    method: 'POST',
    url: `/v1/units/${unitId}/rate-plans`,
    headers: auth,
    payload: { name: 'Flexível', basePriceCents: 45_000, minStay: 2 },
  });
  const connection = await app.inject({
    method: 'POST',
    url: '/v1/connections',
    headers: auth,
    payload: { channel: 'booking', label: 'Booking HOTEL-1', status: 'active' },
  });
  connectionId = (connection.json() as { id: string }).id;
  const listing = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: auth,
    payload: { unitId, connectionId, externalId: 'ROOM-1' },
  });
  // Publicar confirma o mapeamento e sincroniza o calendário pelo protocolo OTA.
  const listingId = (listing.json() as { id: string }).id;
  const published = await app.inject({ method: 'POST', url: `/v1/listings/${listingId}/publish`, headers: auth });
  assert.equal(published.statusCode, 200, published.body);
});

after(async () => {
  await app.close();
  db.close();
});

const webhook = (xml: string, secret: string | null = SECRET) =>
  app.inject({
    method: 'POST',
    url: `/v1/webhooks/booking/${connectionId}`,
    headers: { 'content-type': 'application/xml', ...(secret ? { 'x-booking-signature': secret } : {}) },
    payload: xml,
  });

test('reserva do Booking é aceita e confirmada em OTA, não em JSON', async () => {
  const response = await webhook(reservationXml('BK-5001'));

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] as string, /application\/xml/);
  assert.match(response.body, /<OTA_HotelResNotifRS/);
  assert.match(response.body, /<UniqueID Type="14" ID="BK-5001"\/>/, 'confirmação precisa ecoar o id do canal');

  const rows = db.prepare('SELECT external_id, status, total_cents, channel FROM reservations WHERE external_id = ?').get('BK-5001') as
    | Record<string, unknown>
    | undefined;
  assert.ok(rows, 'reserva precisa estar no banco');
  assert.equal(String(rows.status), 'confirmed');
  assert.equal(Number(rows.total_cents), 135_000);
  assert.equal(String(rows.channel), 'booking');
});

test('reserva do Booking bloqueia a disponibilidade da unidade', async () => {
  const availability = await app.inject({
    method: 'GET',
    url: `/v1/units/${unitId}/availability?from=2026-12-20&to=2026-12-23`,
    headers: auth,
  });
  const days = availability.json() as { date: string; available: number }[];
  assert.ok(days.every((day) => day.available === 0), 'todas as noites precisam estar bloqueadas');
});

test('reenvio da mesma reserva responde 200 e não duplica', async () => {
  const again = await webhook(reservationXml('BK-5001'));
  assert.equal(again.statusCode, 200);
  const count = db.prepare('SELECT COUNT(*) AS total FROM reservations WHERE external_id = ?').get('BK-5001') as { total: number };
  assert.equal(Number(count.total), 1);
});

test('assinatura inválida recebe erro OTA (o canal precisa saber que falhou)', async () => {
  const response = await webhook(reservationXml('BK-5002'), 'errado');
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /<Errors>/);
  assert.match(response.body, /<Error Type="3" Code="400">/);
  const rows = db.prepare('SELECT COUNT(*) AS total FROM reservations WHERE external_id = ?').get('BK-5002') as { total: number };
  assert.equal(Number(rows.total), 0);
});

test('cancelamento vindo do canal libera a disponibilidade', async () => {
  const cancelled = reservationXml('BK-5001').replace('ResStatus="Commit"', 'ResStatus="Cancelled"');
  const response = await webhook(cancelled);
  assert.equal(response.statusCode, 200);

  const availability = await app.inject({
    method: 'GET',
    url: `/v1/units/${unitId}/availability?from=2026-12-20&to=2026-12-23`,
    headers: auth,
  });
  const days = availability.json() as { available: number }[];
  assert.ok(days.every((day) => day.available === 1));
});

test('ARI publica no endpoint OTA com a conta de máquina configurada', async () => {
  await app.inject({
    method: 'PUT',
    url: `/v1/units/${unitId}/ari`,
    headers: auth,
    payload: { days: [{ date: '2026-12-24', rateCents: 61_000, available: 1, minStay: 2 }] },
  });
  await app.inject({ method: 'POST', url: '/v1/outbox/dispatch', headers: auth });

  const sent = transport.requests.filter((request) => /OTA_Hotel(Avail|RateAmount)NotifRQ/.test(request.url));
  assert.ok(sent.length >= 2, `esperava disponibilidade e tarifa, vieram ${sent.length}`);
  assert.ok(sent.every((request) => /^Basic /.test(request.headers.authorization ?? '')));
});
