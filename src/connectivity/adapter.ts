import type { Channel, DateString, Listing, ReservationStatus } from '../domain/types.ts';
import type { UnitRow } from '../db/repositories.ts';

/** Contexto de uma conexão ativa (credenciais ficam fora do domínio). */
export interface ChannelContext {
  connectionId: string;
  channel: Channel;
  externalAccount: string | null;
}

export interface ChannelCapabilities {
  /** Publica/edita conteúdo do anúncio (título, fotos, política). */
  content: boolean;
  /** Envia tarifas (rate plans). */
  rates: boolean;
  /** Envia disponibilidade e restrições (min stay, fechamento). */
  availability: boolean;
  /** Recebe reservas por webhook/polling. */
  reservations: boolean;
  /** Troca mensagens com o hóspede. */
  messaging: boolean;
  /** Gerencia pagamentos do canal. */
  payments: boolean;
}

/** Resultado de uma chamada ao canal. `retryable` decide a política do outbox. */
export interface PushResult {
  ok: boolean;
  externalId?: string;
  retryable?: boolean;
  error?: string;
}

export interface RatePush {
  unitId: string;
  externalListingId: string;
  currency: string;
  days: { date: DateString; rateCents: number }[];
}

export interface AvailabilityPush {
  unitId: string;
  externalListingId: string;
  days: { date: DateString; available: number; closed: boolean; minStay: number }[];
}

/** Reserva já traduzida para o modelo canônico. */
export interface NormalizedReservation {
  externalId: string;
  /** Id do anúncio no canal; o serviço resolve para a listing interna. */
  externalListingId: string;
  checkin: DateString;
  checkout: DateString;
  guests: number;
  guestName: string | null;
  guestEmail: string | null;
  status: ReservationStatus;
  /** `null` = canal não enviou; o valor existente é preservado no upsert. */
  totalCents: number | null;
  commissionCents: number | null;
  currency: 'BRL' | 'USD' | 'EUR';
}

/**
 * Contrato único de integração.
 *
 * Todo canal implementa esta interface; nenhuma regra de negócio conhece
 * particularidades de payload. Ver tests/connectivity/contract.test.ts.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  capabilities(): ChannelCapabilities;
  publishListing(ctx: ChannelContext, listing: Listing): Promise<PushResult>;
  pushRates(ctx: ChannelContext, payload: RatePush): Promise<PushResult>;
  pushAvailability(ctx: ChannelContext, payload: AvailabilityPush): Promise<PushResult>;
  normalizeReservation(ctx: ChannelContext, raw: unknown): NormalizedReservation;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean;
  healthCheck(ctx?: ChannelContext): Promise<{ ok: boolean; detail: string }>;
  /**
   * Resposta que o canal espera receber no webhook. Quando ausente, a API
   * responde JSON. Booking exige OTA_HotelResNotifRS — devolver JSON faria o
   * canal reenviar a reserva indefinidamente.
   */
  confirmWebhook?(input: {
    reservationId: string;
    externalListingId: string;
    echoToken?: string;
    error?: string;
  }): { status: number; contentType: string; body: string } | undefined;
}

/** Erro de integração com informação suficiente para o operador agir. */
export class ChannelError extends Error {
  readonly retryable: boolean;
  readonly code: string;

  constructor(message: string, retryable: boolean, code: string) {
    super(message);
    this.name = 'ChannelError';
    this.retryable = retryable;
    this.code = code;
  }
}

export type { Listing, UnitRow };
