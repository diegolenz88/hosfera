import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MockChannelAdapter } from '../../src/connectivity/adapters/mock.ts';
import { AdapterRegistry, CHANNEL_PROFILES } from '../../src/connectivity/registry.ts';
import { ChannelError, type ChannelAdapter, type ChannelContext } from '../../src/connectivity/adapter.ts';
import type { Listing } from '../../src/domain/types.ts';

const ctx: ChannelContext = { connectionId: 'conn-1', channel: 'mock', externalAccount: null };

const listing: Listing = {
  id: 'l1',
  unitId: 'u1',
  connectionId: 'conn-1',
  externalId: null,
  status: 'draft',
  publishedAt: null,
  lastSyncAt: null,
  createdAt: '',
};

/**
 * Contrato que todo adaptador — mock agora, Booking/Airbnb/Decolar depois —
 * precisa cumprir. Um adaptador novo só entra em produção passando por aqui.
 */
function runContract(name: string, adapter: ChannelAdapter, opts: { certified: boolean }): void {
  test(`${name}: declara capacidades completas`, () => {
    const caps = adapter.capabilities();
    for (const key of ['content', 'rates', 'availability', 'reservations', 'messaging', 'payments'] as const) {
      assert.equal(typeof caps[key], 'boolean', `capacidade ${key} ausente`);
    }
  });

  test(`${name}: healthCheck responde sem lançar`, async () => {
    const health = await adapter.healthCheck();
    assert.equal(typeof health.ok, 'boolean');
    if (opts.certified) assert.equal(health.ok, true);
  });

  if (opts.certified) {
    test(`${name}: publica anúncio e devolve id externo estável`, async () => {
      const first = await adapter.publishListing(ctx, listing);
      assert.equal(first.ok, true);
      assert.ok(first.externalId);
      const second = await adapter.publishListing(ctx, listing);
      assert.equal(second.externalId, first.externalId, 'republicar deve reaproveitar o id externo');
    });

    test(`${name}: aceita tarifas e disponibilidade`, async () => {
      const externalListingId = (await adapter.publishListing(ctx, { ...listing, id: 'l2' })).externalId!;
      const rates = await adapter.pushRates(ctx, {
        unitId: 'u1',
        externalListingId,
        currency: 'BRL',
        days: [{ date: '2026-05-01', rateCents: 50_000 }],
      });
      assert.equal(rates.ok, true);
      const availability = await adapter.pushAvailability(ctx, {
        unitId: 'u1',
        externalListingId,
        days: [{ date: '2026-05-01', available: 0, closed: false, minStay: 2 }],
      });
      assert.equal(availability.ok, true);
    });

    test(`${name}: normaliza reserva para o modelo canônico`, () => {
      const normalized = adapter.normalizeReservation(ctx, {
        externalId: 'ext-1',
        externalListingId: 'ext-listing',
        checkin: '2026-05-01',
        checkout: '2026-05-04',
        guests: 2,
        status: 'confirmed',
        totalCents: 100_000,
        commissionCents: 15_000,
        currency: 'BRL',
      });
      assert.equal(normalized.status, 'confirmed');
      assert.equal(normalized.currency, 'BRL');
      assert.equal(normalized.checkin, '2026-05-01');
    });

    test(`${name}: recusa payload de reserva inválido`, () => {
      assert.throws(() => adapter.normalizeReservation(ctx, { externalId: 'x' }), ChannelError);
    });
  } else {
    test(`${name}: operações falham explicitamente enquanto não certificado`, async () => {
      await assert.rejects(() => adapter.publishListing(ctx, listing), (error: unknown) => {
        assert.ok(error instanceof ChannelError);
        assert.equal(error.retryable, false, 'canal não certificado não deve entrar em retry infinito');
        return true;
      });
    });

    test(`${name}: healthCheck informa a pendência`, async () => {
      const health = await adapter.healthCheck();
      assert.equal(health.ok, false);
      assert.match(health.detail, /pendente/);
    });
  }
}

runContract('mock', new MockChannelAdapter(), { certified: true });

for (const profile of Object.values(CHANNEL_PROFILES)) {
  const adapter = AdapterRegistry.withDefaults().get(profile.channel);
  runContract(profile.channel, adapter, { certified: false });
}

test('webhook do mock exige assinatura HMAC válida', () => {
  const adapter = new MockChannelAdapter();
  const body = JSON.stringify({ externalId: 'abc' });
  assert.equal(adapter.verifyWebhook({ 'x-mock-signature': adapter.sign(body) }, body), true);
  assert.equal(adapter.verifyWebhook({ 'x-mock-signature': 'deadbeef' }, body), false);
  assert.equal(adapter.verifyWebhook({}, body), false);
});

test('registro recusa canal desconhecido', () => {
  const registry = AdapterRegistry.withDefaults();
  assert.throws(() => registry.get('trivago'), ChannelError);
  assert.equal(registry.list().length, 7);
});

test('catálogo expõe a pendência de certificação por canal', () => {
  const catalog = AdapterRegistry.withDefaults().catalog();
  const booking = catalog.find((entry) => entry.channel === 'booking');
  assert.ok(booking);
  assert.match(booking.certification, /Connectivity Partner/);
  const mock = catalog.find((entry) => entry.channel === 'mock');
  assert.match(mock!.certification, /desenvolvimento/);
});
