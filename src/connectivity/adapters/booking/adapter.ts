import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AvailabilityPush,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  NormalizedReservation,
  PushResult,
  RatePush,
} from '../../adapter.ts';
import { ChannelError } from '../../adapter.ts';
import type { Channel, Listing } from '../../../domain/types.ts';
import { CHANNEL_PROFILES } from '../../registry.ts';
import {
  BookingMessageError,
  buildAvailabilityNotif,
  buildCancelRequest,
  buildErrorAck,
  buildPing,
  buildRateAmountNotif,
  buildReservationAck,
  parseAck,
  parseReservationNotification,
} from './messages.ts';
import { TransportError, type Transport } from './transport.ts';

/** Valor sensível (string opaca) — evita literal de credencial no código. */
export type Credential = string;

export interface BookingCredentials {
  /** Conta de máquina fornecida no Provider Portal. */
  machineAccount: string;
  /** Par de autenticação HTTP Basic (usuário + valor). */
  auth: { user: string; value: Credential };
  /** HotelCode do Booking (uma conexão por hotel). */
  hotelCode: string;
  /** `supply-xml` (não-PCI) ou `secure-supply-xml` (reservas). */
  baseUrl?: string;
  secureBaseUrl?: string;
}

export interface BookingOptions {
  credentials: BookingCredentials;
  transport: Transport;
  /**
   * Gate explícito de homologação. Sem isto o adaptador responde
   * `channel_not_certified` — protocolo implementado não é contrato assinado.
   */
  certified: boolean;
  /** Segredo compartilhado do webhook, quando o canal o suportar. */
  webhookSecret?: string;
  clock?: () => Date;
}

const PATH_AVAILABILITY = '/hotels/ota/OTA_HotelAvailNotifRQ';
const PATH_RATES = '/hotels/ota/OTA_HotelRateAmountNotifRQ';
const PATH_RESERVATION = '/hotels/ota/OTA_HotelResNotifRQ';
const PATH_CANCEL = '/hotels/ota/OTA_CancelRQ';
const PATH_PING = '/hotels/ota/OTA_PingRQ';

/**
 * Adaptador Booking.com sobre as Connectivity APIs (OTA 2003B).
 *
 * O protocolo está implementado; a ativação exige homologação porque:
 *  - o conteúdo do anúncio vem do extranet/Content API, não desta mensagem;
 *  - o mapeamento quarto/plano é feito por HotelCode + RoomCode no extranet;
 *  - só a conta de máquina homologada tem permissão nos endpoints PCI.
 */
export class BookingAdapter implements ChannelAdapter {
  readonly channel: Channel = 'booking';
  private readonly credentials: BookingCredentials;
  private readonly transport: Transport;
  private readonly certified: boolean;
  private readonly webhookSecret: string | null;
  private readonly clock: () => Date;

  constructor(options: BookingOptions) {
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.certified = options.certified;
    this.webhookSecret = options.webhookSecret ?? null;
    this.clock = options.clock ?? (() => new Date());
  }

  capabilities(): ChannelCapabilities {
    return CHANNEL_PROFILES.booking.capabilities;
  }

  async publishListing(_ctx: ChannelContext, listing: Listing): Promise<PushResult> {
    this.assertCertified('publicação de anúncio');
    // Conteúdo e criação de anúncio vivem no extranet/Content API. O que a hosfera
    // faz é confirmar o mapeamento quarto → anúncio interno.
    if (!listing.externalId) {
      throw new ChannelError(
        `informe o RoomCode do Booking para mapear o anúncio ${listing.id}`,
        false,
        'mapping_required',
      );
    }
    return { ok: true, externalId: listing.externalId };
  }

  async pushAvailability(ctx: ChannelContext, payload: AvailabilityPush): Promise<PushResult> {
    this.assertCertified('envio de disponibilidade');
    void ctx;
    const { echoToken, timestamp } = this.envelope();
    const xml = buildAvailabilityNotif({
      hotelCode: this.credentials.hotelCode,
      roomCode: this.requireRoomCode(payload.externalListingId),
      ratePlanCode: payload.externalListingId,
      days: payload.days.map((day) => ({
        date: day.date,
        available: day.available,
        closed: day.closed,
        minStay: day.minStay,
      })),
      echoToken,
      timestamp,
      machineAccount: this.credentials.machineAccount,
    });
    return this.send('availability', this.url(PATH_AVAILABILITY), xml, echoToken);
  }

  async pushRates(ctx: ChannelContext, payload: RatePush): Promise<PushResult> {
    this.assertCertified('envio de tarifas');
    void ctx;
    if (payload.days.length === 0) return { ok: true };
    const { echoToken, timestamp } = this.envelope();
    const xml = buildRateAmountNotif({
      hotelCode: this.credentials.hotelCode,
      roomCode: this.requireRoomCode(payload.externalListingId),
      ratePlanCode: payload.externalListingId,
      currency: payload.currency,
      days: payload.days.map((day) => ({ date: day.date, rateCents: day.rateCents })),
      echoToken,
      timestamp,
      machineAccount: this.credentials.machineAccount,
    });
    return this.send('rates', this.url(PATH_RATES), xml, echoToken);
  }

  normalizeReservation(_ctx: ChannelContext, raw: unknown): NormalizedReservation {
    this.assertCertified('normalização de reserva');
    try {
      const xml = typeof raw === 'string' ? raw : null;
      if (!xml) throw new BookingMessageError('reserva do Booking deve ser XML', 'invalid_payload');
      const parsed = parseReservationNotification(xml);
      if (parsed.hotelCode && parsed.hotelCode !== this.credentials.hotelCode) {
        throw new BookingMessageError(
          `HotelCode ${parsed.hotelCode} não pertence a esta conexão (${this.credentials.hotelCode})`,
          'hotel_mismatch',
        );
      }
      return {
        externalId: parsed.reservationId,
        externalListingId: parsed.roomCode,
        checkin: parsed.checkin,
        checkout: parsed.checkout,
        guests: parsed.guests,
        guestName: parsed.guestName,
        guestEmail: parsed.guestEmail,
        status: parsed.status,
        totalCents: parsed.totalCents,
        commissionCents: parsed.commissionCents,
        currency: parsed.currency as NormalizedReservation['currency'],
      };
    } catch (error) {
      if (error instanceof BookingMessageError) {
        throw new ChannelError(error.message, false, error.code);
      }
      throw new ChannelError(error instanceof Error ? error.message : String(error), false, 'invalid_payload');
    }
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean {
    if (!this.webhookSecret) return false;
    const provided = headers['x-booking-signature'] ?? headers['x-webhook-secret'];
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.webhookSecret);
    if (a.length !== b.length) return false;
    const bodyOk = timingSafeEqual(a, b);
    return bodyOk && rawBody.length > 0;
  }

  /** O Booking exige resposta OTA, não JSON: devolvemos a confirmação no formato dele. */
  confirmWebhook(input: { reservationId: string; externalListingId: string; echoToken?: string; error?: string }):
    | { status: number; contentType: string; body: string }
    | undefined {
    const timestamp = this.clock().toISOString();
    const echoToken = input.echoToken ?? randomUUID();
    if (input.error) {
      return {
        status: 400,
        contentType: 'application/xml; charset=utf-8',
        body: buildErrorAck({ echoToken, timestamp, code: '400', message: input.error }),
      };
    }
    return {
      status: 200,
      contentType: 'application/xml; charset=utf-8',
      body: buildReservationAck({
        reservationId: input.reservationId,
        hotelCode: this.credentials.hotelCode,
        echoToken,
        timestamp,
      }),
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.certified) {
      return { ok: false, detail: 'booking: protocolo pronto, homologação pendente (BOOKING_CERTIFIED=false)' };
    }
    const { echoToken, timestamp } = this.envelope();
    try {
      const response = await this.transport.post({
        url: this.url(PATH_PING),
        body: buildPing(this.credentials.machineAccount, echoToken, timestamp),
        headers: this.headers(),
        operation: 'ping',
      });
      const ack = parseAck(response.body);
      return { ok: ack.ok, detail: ack.ok ? 'booking ping ok' : ack.errors.map((e) => e.message).join('; ') };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Cancelamento iniciado pelo hotel (o do hóspede chega como notificação). */
  async cancelReservation(input: { reservationId: string; reason?: string }): Promise<PushResult> {
    this.assertCertified('cancelamento');
    if (!input.reservationId) throw new ChannelError('reservationId obrigatório', false, 'invalid_payload');
    const { echoToken, timestamp } = this.envelope();
    const xml = buildCancelRequest({
      machineAccount: this.credentials.machineAccount,
      reservationId: input.reservationId,
      hotelCode: this.credentials.hotelCode,
      echoToken,
      timestamp,
      reason: input.reason,
    });
    // Cancelamento passa pelo servidor PCI (contém dado de reserva).
    return this.send('cancel', this.url(PATH_CANCEL, true), xml, echoToken);
  }

  // ───────────────────────────── interno ─────────────────────────────

  private assertCertified(operation: string): void {
    if (!this.certified) {
      throw new ChannelError(
        `canal booking não certificado para ${operation}: ${CHANNEL_PROFILES.booking.certification}`,
        false,
        'channel_not_certified',
      );
    }
  }

  private requireRoomCode(externalListingId: string): string {
    if (!externalListingId) {
      throw new ChannelError('anúncio sem RoomCode do Booking mapeado', false, 'mapping_required');
    }
    return externalListingId.includes('/') ? externalListingId.split('/').pop()! : externalListingId;
  }

  private envelope(): { echoToken: string; timestamp: string } {
    return { echoToken: randomUUID(), timestamp: this.clock().toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  private url(path: string, secure = false): string {
    const base = secure
      ? (this.credentials.secureBaseUrl ?? 'https://secure-supply-xml.booking.com')
      : (this.credentials.baseUrl ?? 'https://supply-xml.booking.com');
    return `${base}${path}`;
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.credentials.machineAccount}:${this.credentials.auth.value}`).toString('base64');
    return { authorization: `Basic ${basic}` };
  }

  private async send(operation: string, url: string, xml: string, echoToken: string): Promise<PushResult> {
    try {
      const response = await this.transport.post({ url, body: xml, headers: this.headers(), operation });
      const ack = parseAck(response.body);
      if (!ack.ok) {
        const retryable = ack.errors.some((error) => error.retryable);
        return { ok: false, retryable, error: ack.errors.map((e) => `${e.code}: ${e.message}`).join('; ') };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof TransportError) {
        return { ok: false, retryable: error.retryable, error: error.message };
      }
      return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
    } finally {
      void echoToken;
      void operation;
    }
  }
}
