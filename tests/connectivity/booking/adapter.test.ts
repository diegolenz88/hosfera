import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BookingAdapter } from '../../../src/connectivity/adapters/booking/adapter.ts';
import { MemoryTransport, TransportError, type TransportRequest } from '../../../src/connectivity/adapters/booking/transport.ts';
import { ChannelError, type ChannelContext, type Listing } from '../../../src/connectivity/adapter.ts';
import { AdapterRegistry } from '../../../src/connectivity/registry.ts';

const ctx: ChannelContext = { connectionId: 'conn-booking', channel: 'booking', externalAccount: 'HOTEL-1' };

const credentials = {
  machineAccount: 'MACHINE-ACCOUNT',
  auth: { user: 'MACHINE-ACCOUNT', value: 'opaque-value' },
  hotelCode: 'HOTEL-1',
};

const listing: Listing = {
  id: 'listing-1',
  unitId: 'unit-1',
  connectionId: 'conn-booking',
  externalId: 'ROOM-1',
  status: 'published',
  publishedAt: null,
  lastSyncAt: null,
  createdAt: '2026-11-06T00:00:00Z',
};

const successAck = `<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05"><Success/></OTA_HotelAvailNotifRS>`;

const build = (opts: { certified?: boolean; transport?: MemoryTransport } = {}) =>
  new BookingAdapter({
    credentials,
    certified: opts.certified ?? true,
    transport: opts.transport ?? new MemoryTransport(() => ({ status: 200, body: successAck })),
    webhookSecret: 'webhook-value',
    clock: () => new Date('2026-11-06T12:00:00.000Z'),
  });

test('sem homologação o adaptador recusa operação de forma terminal', async () => {
  const adapter = build({ certified: false });
  await assert.rejects(
    adapter.pushAvailability(ctx, {
      unitId: 'unit-1',
      externalListingId: 'ROOM-1',
      days: [{ date: '2026-12-20', available: 1, closed: false, minStay: 2 }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChannelError);
      assert.equal(error.code, 'channel_not_certified');
      assert.equal(error.retryable, false, 'não pode entrar em retry infinito esperando homologação');
      return true;
    },
  );

  const health = await adapter.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.detail, /homologa/i);
});

test('homologado envia disponibilidade com Basic auth para o endpoint correto', async () => {
  const transport = new MemoryTransport(() => ({ status: 200, body: successAck }));
  const adapter = build({ transport });

  const result = await adapter.pushAvailability(ctx, {
    unitId: 'unit-1',
    externalListingId: 'ROOM-1',
    days: [{ date: '2026-12-20', available: 2, closed: false, minStay: 2 }],
  });

  assert.deepEqual(result, { ok: true });
  const request = transport.requests[0] as TransportRequest;
  assert.match(request.url, /\/hotels\/ota\/OTA_HotelAvailNotifRQ$/);
  assert.match(request.url, /^https:\/\/supply-xml\.booking\.com/, 'disponibilidade vai no servidor não-PCI');
  assert.match(request.headers.authorization ?? '', /^Basic /);
  assert.match(request.body, /HotelCode="HOTEL-1"/);
  assert.match(request.body, /BookingLimit="2"/);
  assert.equal(request.operation, 'availability');
});

test('erro de negócio do canal não é retentável', async () => {
  const transport = new MemoryTransport(() => ({
    status: 200,
    body: `<OTA_HotelRateAmountNotifRS xmlns="http://www.opentravel.org/OTA/2003/05">
      <Errors><Error Type="3" Code="392">Rate plan not found</Error></Errors>
    </OTA_HotelRateAmountNotifRS>`,
  }));
  const adapter = build({ transport });

  const result = await adapter.pushRates(ctx, {
    unitId: 'unit-1',
    externalListingId: 'ROOM-1',
    currency: 'BRL',
    days: [{ date: '2026-12-20', rateCents: 48_000 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error ?? '', /392/);
});

test('falha de transporte 5xx é retentável', async () => {
  const transport = new MemoryTransport(() => {
    throw new TransportError('HTTP 503 no Booking', true);
  });
  const adapter = build({ transport });
  const result = await adapter.pushAvailability(ctx, {
    unitId: 'unit-1',
    externalListingId: 'ROOM-1',
    days: [{ date: '2026-12-20', available: 1, closed: false, minStay: 1 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test('normaliza reserva OTA e recusa HotelCode de outra conexão', () => {
  const adapter = build();
  const xml = `<?xml version="1.0"?><OTA_HotelResNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05">
    <HotelReservations><HotelReservation ResStatus="Commit">
      <UniqueID Type="14" ID="BK-1"/>
      <RoomStays><RoomStay>
        <RoomTypes><RoomType RoomTypeCode="ROOM-1"/></RoomTypes>
        <TimeSpan Start="2026-12-20" End="2026-12-23"/>
        <Total AmountAfterTax="900.00" CurrencyCode="BRL"/>
        <BasicPropertyInfo HotelCode="HOTEL-1"/>
      </RoomStay></RoomStays>
    </HotelReservation></HotelReservations>
  </OTA_HotelResNotifRQ>`;

  const normalized = adapter.normalizeReservation(ctx, xml);
  assert.equal(normalized.externalId, 'BK-1');
  assert.equal(normalized.externalListingId, 'ROOM-1');
  assert.equal(normalized.status, 'confirmed');
  assert.equal(normalized.totalCents, 90_000);

  const otherHotel = xml.replace('HOTEL-1', 'HOTEL-9');
  assert.throws(
    () => adapter.normalizeReservation(ctx, otherHotel),
    (error: unknown) => error instanceof ChannelError && error.code === 'hotel_mismatch',
  );
});

test('JSON não é aceito como reserva do Booking', () => {
  const adapter = build();
  assert.throws(
    () => adapter.normalizeReservation(ctx, { externalId: 'x' }),
    (error: unknown) => error instanceof ChannelError && error.code === 'invalid_payload',
  );
});

test('confirmação do webhook volta em XML, com erro quando falha', () => {
  const adapter = build();
  const ok = adapter.confirmWebhook({ reservationId: 'BK-1', externalListingId: 'ROOM-1' });
  assert.equal(ok?.status, 200);
  assert.equal(ok?.contentType, 'application/xml; charset=utf-8');
  assert.match(ok?.body ?? '', /OTA_HotelResNotifRS/);
  assert.match(ok?.body ?? '', /UniqueID Type="14" ID="BK-1"/);

  const failure = adapter.confirmWebhook({ reservationId: '', externalListingId: '', error: 'assinatura inválida' });
  assert.equal(failure?.status, 400);
  assert.match(failure?.body ?? '', /<Error Type="3" Code="400">assinatura inválida<\/Error>/);
});

test('webhook exige segredo compartilhado', () => {
  const adapter = build();
  const body = '<OTA_HotelResNotifRQ/>';
  assert.equal(adapter.verifyWebhook({ 'x-booking-signature': 'webhook-value' }, body), true);
  assert.equal(adapter.verifyWebhook({ 'x-booking-signature': 'errado' }, body), false);
  assert.equal(adapter.verifyWebhook({}, body), false);
});

test('publicar sem RoomCode mapeado falha com instrução, não com sucesso falso', async () => {
  const adapter = build();
  await assert.rejects(
    adapter.publishListing(ctx, { ...listing, externalId: null }),
    (error: unknown) => error instanceof ChannelError && error.code === 'mapping_required',
  );
  const mapped = await adapter.publishListing(ctx, listing);
  assert.deepEqual(mapped, { ok: true, externalId: 'ROOM-1' });
});

test('registry troca o canal pendente pelo adaptador quando configurado', () => {
  const withoutBooking = AdapterRegistry.withDefaults();
  assert.equal((withoutBooking.get('booking') as { profile?: unknown }).profile !== undefined, true, 'padrão é pendente');

  const withBooking = AdapterRegistry.withDefaults({
    booking: { credentials, certified: false, transport: new MemoryTransport(() => ({ status: 200, body: successAck })) },
  });
  const adapter = withBooking.get('booking');
  assert.ok(adapter instanceof BookingAdapter);

  const catalog = withBooking.catalog();
  const bookingEntry = catalog.find((entry) => entry.channel === 'booking');
  assert.equal(bookingEntry?.implemented, true, 'catálogo distingue protocolo implementado de canal pronto');
});
