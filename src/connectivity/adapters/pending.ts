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
import type { ChannelProfile } from '../profiles.ts';

/**
 * Adaptador de canal ainda não certificado.
 *
 * Existe para que o produto tenha o canal no catálogo, na matriz de capacidades
 * e no roteamento — mas nunca finja integração: toda operação falha de forma
 * explícita e não-retentável até credencial + homologação existirem.
 */
export class PendingChannelAdapter implements ChannelAdapter {
  readonly profile: ChannelProfile;

  constructor(profile: ChannelProfile) {
    this.profile = profile;
  }

  get channel(): Channel {
    return this.profile.channel;
  }

  capabilities(): ChannelCapabilities {
    return this.profile.capabilities;
  }

  async publishListing(_ctx: ChannelContext, _listing: Listing): Promise<PushResult> {
    throw this.notCertified('publicação de anúncio');
  }

  async pushRates(_ctx: ChannelContext, _payload: RatePush): Promise<PushResult> {
    throw this.notCertified('envio de tarifas');
  }

  async pushAvailability(_ctx: ChannelContext, _payload: AvailabilityPush): Promise<PushResult> {
    throw this.notCertified('envio de disponibilidade');
  }

  normalizeReservation(_ctx: ChannelContext, _raw: unknown): NormalizedReservation {
    throw this.notCertified('normalização de reserva');
  }

  verifyWebhook(): boolean {
    return false;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail: `canal ${this.channel} pendente de certificação — ${this.profile.certification}`,
    };
  }

  private notCertified(operation: string): ChannelError {
    return new ChannelError(
      `canal ${this.channel} não certificado para ${operation}: ${this.profile.certification}`,
      false,
      'channel_not_certified',
    );
  }
}
