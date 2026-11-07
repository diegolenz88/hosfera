import type { Config } from '../config.ts';
import type { RegistryOptions } from './registry.ts';
import { FetchTransport } from './adapters/booking/transport.ts';

/**
 * Monta as opções do adaptador Booking a partir do ambiente.
 *
 * Sem conta de máquina, HotelCode e valor de autenticação não há conexão —
 * devolve `undefined` e o registry mantém o canal pendente. `certified` continua
 * sendo decisão explícita de homologação, não consequência de ter credencial.
 */
export function bookingOptionsFromConfig(cfg: Config): RegistryOptions['booking'] {
  const booking = cfg.booking;
  if (!booking) return undefined;
  if (!booking.machineAccount || !booking.hotelCode || !booking.authValue) return undefined;
  return {
    certified: booking.certified,
    credentials: {
      machineAccount: booking.machineAccount,
      auth: { user: booking.machineAccount, value: booking.authValue },
      hotelCode: booking.hotelCode,
      baseUrl: booking.baseUrl,
      secureBaseUrl: booking.secureBaseUrl,
    },
    transport: new FetchTransport(),
    webhookSecret: booking.webhookSecret || undefined,
  };
}
