import type { ChannelAdapter } from './adapter.ts';
import { ChannelError } from './adapter.ts';
import type { Channel } from '../domain/types.ts';
import { MockChannelAdapter } from './adapters/mock.ts';
import { PendingChannelAdapter } from './adapters/pending.ts';
import { BookingAdapter, type BookingOptions } from './adapters/booking/adapter.ts';
import { CHANNEL_PROFILES, type ChannelProfile } from './profiles.ts';

export { CHANNEL_PROFILES };
export type { ChannelProfile };

export interface RegistryOptions {
  enableMock?: boolean;
  /** Quando presente, o canal booking usa o adaptador OTA real (respeitando `certified`). */
  booking?: BookingOptions;
}

export class AdapterRegistry {
  private readonly adapters = new Map<Channel, ChannelAdapter>();

  constructor(adapters: ChannelAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  static withDefaults(opts: RegistryOptions = {}): AdapterRegistry {
    const adapters: ChannelAdapter[] = Object.values(CHANNEL_PROFILES).map(
      (profile) => new PendingChannelAdapter(profile),
    );
    if (opts.booking) {
      const index = adapters.findIndex((adapter) => adapter.channel === 'booking');
      const booking = new BookingAdapter(opts.booking);
      if (index >= 0) adapters[index] = booking;
      else adapters.push(booking);
    }
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

  catalog(): {
    channel: Channel;
    capabilities: ReturnType<ChannelAdapter['capabilities']>;
    certification: string;
    docs: string;
    /** `true` quando existe implementação de protocolo, mesmo sem homologação. */
    implemented: boolean;
  }[] {
    return this.list().map((adapter) => {
      const profile = adapter.channel === 'mock' ? null : CHANNEL_PROFILES[adapter.channel as Exclude<Channel, 'mock'>];
      return {
        channel: adapter.channel,
        capabilities: adapter.capabilities(),
        certification: profile?.certification ?? 'canal de desenvolvimento, sem certificação externa',
        docs: profile?.docs ?? 'interno',
        implemented: adapter.channel === 'mock' || adapter.channel === 'booking',
      };
    });
  }
}
