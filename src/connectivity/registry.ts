import type { ChannelAdapter } from './adapter.ts';
import { ChannelError } from './adapter.ts';
import type { Channel } from '../domain/types.ts';
import { MockChannelAdapter } from './adapters/mock.ts';
import { PendingChannelAdapter, type ChannelProfile } from './adapters/pending.ts';

/**
 * Perfis dos canais prioritários.
 *
 * `capabilities` reflete o que cada programa publica hoje; `certification`
 * registra o que falta para tirar o canal de `pending`. Nenhum adaptador real
 * é marcado como pronto sem homologação — ver docs/adr/0004.
 */
export const CHANNEL_PROFILES: Record<Exclude<Channel, 'mock'>, ChannelProfile> = {
  booking: {
    channel: 'booking',
    capabilities: { content: true, rates: true, availability: true, reservations: true, messaging: true, payments: true },
    auth: 'HTTPS + credenciais de máquina; OTA 2003B e B.XML (supply-xml / secure-supply-xml)',
    certification: 'Connectivity Partner aprovado + connection types habilitados por propriedade',
    docs: 'https://developers.booking.com/connectivity/docs',
  },
  airbnb: {
    channel: 'airbnb',
    capabilities: { content: true, rates: true, availability: true, reservations: true, messaging: true, payments: false },
    auth: 'OAuth2 do programa de software parceiro',
    certification: 'Software Partner Program: NDA, API Terms, revisão de segurança e requisitos obrigatórios em 6 meses',
    docs: 'https://www.airbnb.com/help/article/3418',
  },
  decolar: {
    channel: 'decolar',
    capabilities: { content: true, rates: true, availability: true, reservations: true, messaging: false, payments: false },
    auth: 'Credenciais do programa de conectividade (Despegar Group)',
    certification: 'Contrato e homologação regional; grupo opera Despegar, Decolar, Best Day, Viajes Falabella',
    docs: 'https://www.us.despegar.com/information/partners',
  },
  expedia: {
    channel: 'expedia',
    capabilities: { content: true, rates: true, availability: true, reservations: true, messaging: true, payments: false },
    auth: 'OAuth2 (BEARER) nas APIs de lodging supply',
    certification: 'Certificação Expedia Group: Availability & Rates, Reservation Management e Product API',
    docs: 'https://developers.expediagroup.com/supply/lodging/documentation',
  },
  vrbo: {
    channel: 'vrbo',
    capabilities: { content: true, rates: true, availability: true, reservations: true, messaging: true, payments: true },
    auth: 'OAuth2 + GraphQL Lodging Supply (Expedia Group)',
    certification: 'Acesso ao produto Vrbo é limitado a parceiros selecionados; exige webhooks e mensageria',
    docs: 'https://connectivityportal.expediagroup.com/documentation/vrbo',
  },
  google: {
    channel: 'google',
    capabilities: { content: false, rates: true, availability: true, reservations: false, messaging: false, payments: false },
    auth: 'Feed/API de preços e disponibilidade aprovado pelo Google',
    certification: 'Aprovação como parceiro de conectividade de Vacation Rentals + booking site elegível',
    docs: 'https://support.google.com/hotelprices/answer/12567939',
  },
};

export class AdapterRegistry {
  private readonly adapters = new Map<Channel, ChannelAdapter>();

  constructor(adapters: ChannelAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  static withDefaults(opts: { enableMock?: boolean } = {}): AdapterRegistry {
    const adapters: ChannelAdapter[] = [
      ...Object.values(CHANNEL_PROFILES).map((profile) => new PendingChannelAdapter(profile)),
    ];
    if (opts.enableMock !== false) adapters.push(new MockChannelAdapter());
    return new AdapterRegistry(adapters);
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  get(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(channel as Channel);
    if (!adapter) throw new ChannelError(`canal desconhecido: ${channel}`, false, 'unknown_channel');
    return adapter;
  }

  has(channel: string): boolean {
    return this.adapters.has(channel as Channel);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  catalog(): { channel: Channel; capabilities: ReturnType<ChannelAdapter['capabilities']>; certification: string; docs: string }[] {
    return this.list().map((adapter) => {
      const profile = adapter.channel === 'mock' ? null : CHANNEL_PROFILES[adapter.channel as Exclude<Channel, 'mock'>];
      return {
        channel: adapter.channel,
        capabilities: adapter.capabilities(),
        certification: profile?.certification ?? 'canal de desenvolvimento, sem certificação externa',
        docs: profile?.docs ?? 'interno',
      };
    });
  }
}
