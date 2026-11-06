import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeStatus, validateStay } from '../../domain/reservation.ts';
import type {
  AvailabilityPush,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  NormalizedReservation,
  PushResult,
  RatePush,
} from '../adapter.ts';
import { ChannelError } from '../adapter.ts';
import type { Channel, Listing } from '../../domain/types.ts';

const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

/**
 * Canal de desenvolvimento: aceita tudo, guarda o estado enviado e permite
 * simular uma reserva de hóspede. É o que torna o fluxo multicanal testável
 * sem credencial de OTA — e serve de referência para os adaptadores reais.
 */
export class MockChannelAdapter implements ChannelAdapter {
  readonly channel: Channel = 'mock';

  private readonly secret: string;
  private readonly listings = new Map<string, { externalId: string; unitId: string; publishedAt: string }>();
  private readonly calendar = new Map<string, Map<string, { rateCents?: number; available?: number; closed?: boolean; minStay?: number }>>();
  private readonly reservations = new Map<string, NormalizedReservation>();
  private failuresLeft = 0;
  private nextExternalId = 1;

  constructor(secret = 'mock-shared-secret') {
    this.secret = secret;
  }

  capabilities(): ChannelCapabilities {
    return {
      content: true,
      rates: true,
      availability: true,
      reservations: true,
      messaging: false,
      payments: false,
    };
  }

  async publishListing(_ctx: ChannelContext, listing: Listing): Promise<PushResult> {
    // Idempotente por anúncio interno: republicar não cria um segundo anúncio no canal.
    const existing = this.listings.get(listing.id);
    const externalId =
      listing.externalId ?? existing?.externalId ?? `MOCK-${String(this.nextExternalId++).padStart(5, '0')}`;
    this.listings.set(listing.id, { externalId, unitId: listing.unitId, publishedAt: new Date().toISOString() });
    return { ok: true, externalId };
  }

  async pushRates(_ctx: ChannelContext, payload: RatePush): Promise<PushResult> {
    this.maybeFail();
    const calendar = this.calendarFor(payload.externalListingId);
    for (const day of payload.days) {
      calendar.set(day.date, { ...(calendar.get(day.date) ?? {}), rateCents: day.rateCents });
    }
    return { ok: true };
  }

  async pushAvailability(_ctx: ChannelContext, payload: AvailabilityPush): Promise<PushResult> {
    this.maybeFail();
    const calendar = this.calendarFor(payload.externalListingId);
    for (const day of payload.days) {
      calendar.set(day.date, {
        ...(calendar.get(day.date) ?? {}),
        available: day.available,
        closed: day.closed,
        minStay: day.minStay,
      });
    }
    return { ok: true };
  }

  /** Webhook de exemplo: HMAC-SHA256 do corpo cru com o segredo compartilhado. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    const received = headers[MOCK_SIGNATURE_HEADER];
    if (!received) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Assinatura para uso em testes e no simulador (`signBody`). */
  sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  normalizeReservation(_ctx: ChannelContext, raw: unknown): NormalizedReservation {
    const payload = raw as Record<string, unknown>;
    const required = ['externalId', 'externalListingId', 'checkin', 'checkout'];
    for (const field of required) {
      if (!payload[field]) throw new ChannelError(`campo obrigatório ausente: ${field}`, false, 'invalid_payload');
    }
    const checkin = String(payload.checkin);
    const checkout = String(payload.checkout);
    const guests = Number(payload.guests ?? 1);
    const validation = validateStay({ checkin, checkout, guests, minStay: 1, maxStay: 365, capacity: 99 });
    if (!validation.ok) throw new ChannelError(validation.errors.join('; '), false, 'invalid_stay');

    return {
      externalId: String(payload.externalId),
      externalListingId: String(payload.externalListingId),
      checkin,
      checkout,
      guests,
      guestName: payload.guestName ? String(payload.guestName) : 'Hóspede mock',
      guestEmail: payload.guestEmail ? String(payload.guestEmail) : null,
      status: normalizeStatus('mock', String(payload.status ?? 'confirmed')),
      // `== null` cobre undefined E null: ausência de valor não pode virar zero.
      totalCents: payload.totalCents == null ? null : Number(payload.totalCents),
      commissionCents: payload.commissionCents == null ? null : Number(payload.commissionCents),
      currency: (payload.currency as NormalizedReservation['currency']) ?? 'BRL',
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `mock ok · ${this.listings.size} anúncios, ${this.reservations.size} reservas` };
  }

  // ───────── superfície usada por testes e pelo simulador de OTA ─────────

  /** Simula uma falha transitória nas próximas N chamadas. */
  failNext(count: number): void {
    this.failuresLeft = count;
  }

  snapshot(externalListingId: string): Record<string, { rateCents?: number; available?: number; closed?: boolean; minStay?: number }> {
    return Object.fromEntries(this.calendarFor(externalListingId));
  }

  externalIdFor(listingId: string): string | undefined {
    return this.listings.get(listingId)?.externalId;
  }

  registerReservation(reservation: NormalizedReservation): void {
    this.reservations.set(reservation.externalId, reservation);
  }

  listReservations(): NormalizedReservation[] {
    return [...this.reservations.values()];
  }

  reset(): void {
    this.listings.clear();
    this.calendar.clear();
    this.reservations.clear();
    this.failuresLeft = 0;
  }

  private calendarFor(externalListingId: string): Map<string, { rateCents?: number; available?: number; closed?: boolean; minStay?: number }> {
    const existing = this.calendar.get(externalListingId);
    if (existing) return existing;
    const created = new Map<string, { rateCents?: number; available?: number; closed?: boolean; minStay?: number }>();
    this.calendar.set(externalListingId, created);
    return created;
  }

  private maybeFail(): void {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new ChannelError('canal indisponível (falha simulada)', true, 'mock_unavailable');
    }
  }
}
