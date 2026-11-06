import type { Db } from '../db/database.ts';
import {
  dueEvents,
  getConnection,
  getListing,
  getUnit,
  markEventRetry,
  markEventSent,
  markListingPublished,
  nowIso,
} from '../db/repositories.ts';
import type { AdapterRegistry } from '../connectivity/registry.ts';
import { ChannelError, type ChannelContext } from '../connectivity/adapter.ts';
import { addDays } from '../domain/dates.ts';
import type { OutboxEvent } from '../domain/types.ts';
import { getAvailability } from './availability.service.ts';

export interface DispatcherOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface DispatchReport {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
}

/** Calcula o próximo instante de tentativa com backoff exponencial + jitter. */
export function nextAttempt(
  attempts: number,
  opts: Required<Pick<DispatcherOptions, 'baseBackoffMs' | 'maxBackoffMs'>>,
): string {
  const exp = Math.min(opts.baseBackoffMs * 2 ** attempts, opts.maxBackoffMs);
  const jitter = Math.floor(Math.random() * 250);
  return new Date(Date.now() + exp + jitter).toISOString();
}

/**
 * Worker do outbox.
 *
 * Um único lugar fala com as OTAs. Isso concentra rate limit, retry, dead-letter
 * e auditoria — e mantém o request HTTP do operador rápido.
 *
 * Disponibilidade é recalculada no envio, não confiada ao payload: entre o
 * enfileiramento e o envio pode ter chegado outra reserva.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly db: Db;
  private readonly registry: AdapterRegistry;
  private readonly opts: Required<DispatcherOptions>;

  constructor(db: Db, registry: AdapterRegistry, options: DispatcherOptions = {}) {
    this.db = db;
    this.registry = registry;
    this.opts = {
      batchSize: options.batchSize ?? 25,
      maxAttempts: options.maxAttempts ?? 6,
      baseBackoffMs: options.baseBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
    };
  }

  async runOnce(): Promise<DispatchReport> {
    const events = dueEvents(this.db, this.opts.batchSize, nowIso());
    const report: DispatchReport = { processed: 0, sent: 0, retried: 0, dead: 0, skipped: 0 };

    for (const event of events) {
      report.processed += 1;
      const outcome = await this.dispatch(event);
      if (outcome === 'sent') report.sent += 1;
      else if (outcome === 'retry') report.retried += 1;
      else if (outcome === 'dead') report.dead += 1;
      else report.skipped += 1;
    }
    return report;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((error) => console.error('[dispatcher] erro inesperado:', error))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async dispatch(event: OutboxEvent): Promise<'sent' | 'retry' | 'dead' | 'skip'> {
    const listing = event.listingId ? getListing(this.db, event.listingId) : null;
    const connection = getConnection(this.db, event.connectionId);
    if (!connection) return this.fail(event, 'conexão removida', false);

    const adapter = this.registry.get(connection.channel);
    const ctx: ChannelContext = {
      connectionId: connection.id,
      channel: connection.channel,
      externalAccount: connection.externalAccount,
    };

    try {
      switch (event.type) {
        case 'listing.published': {
          if (!listing) return this.fail(event, 'anúncio ausente no evento de publicação', false);
          const result = await adapter.publishListing(ctx, listing);
          if (!result.ok || !result.externalId) {
            return this.fail(event, result.error ?? 'canal não retornou id externo', result.retryable ?? true);
          }
          markListingPublished(this.db, listing.id, result.externalId);
          markEventSent(this.db, event.id);
          return 'sent';
        }

        case 'rates.updated': {
          const payload = JSON.parse(event.payloadJson) as {
            externalListingId: string;
            days: { date: string; rateCents: number }[];
          };
          const result = await adapter.pushRates(ctx, {
            unitId: event.unitId ?? '',
            externalListingId: payload.externalListingId,
            currency: 'BRL',
            days: payload.days,
          });
          if (!result.ok) return this.fail(event, result.error ?? 'falha ao enviar tarifas', result.retryable ?? true);
          markEventSent(this.db, event.id);
          return 'sent';
        }

        case 'availability.updated': {
          const payload = JSON.parse(event.payloadJson) as {
            externalListingId: string;
            unitId: string;
            days: { date: string }[];
          };
          const unit = getUnit(this.db, payload.unitId);
          if (!unit) return this.fail(event, 'unidade removida', false);

          const dates = payload.days.map((d) => d.date).sort();
          const first = dates[0];
          const last = dates[dates.length - 1];
          if (!first || !last) {
            markEventSent(this.db, event.id);
            return 'skip';
          }

          const computed = getAvailability(this.db, {
            unitId: unit.id,
            from: first,
            to: addDays(last, 1),
          });
          const byDate = new Map(computed.map((day) => [day.date, day]));

          const result = await adapter.pushAvailability(ctx, {
            unitId: unit.id,
            externalListingId: payload.externalListingId,
            days: payload.days.map((d) => {
              const day = byDate.get(d.date);
              return {
                date: d.date,
                available: day?.available ?? 0,
                closed: day?.closed ?? false,
                minStay: day?.minStay ?? unit.minStay,
              };
            }),
          });
          if (!result.ok) return this.fail(event, result.error ?? 'falha ao enviar disponibilidade', result.retryable ?? true);
          markEventSent(this.db, event.id);
          return 'sent';
        }

        case 'reservation.created':
        case 'reservation.modified':
        case 'reservation.cancelled': {
          // Reserva nasce no canal; não há push. O evento existe para auditoria
          // e para futuros adaptadores que exijam confirmação (ex.: Vrbo).
          markEventSent(this.db, event.id);
          return 'skip';
        }

        default: {
          return this.fail(event, `tipo de evento desconhecido: ${String(event.type)}`, false);
        }
      }
    } catch (error) {
      if (error instanceof ChannelError) return this.fail(event, error.message, error.retryable);
      return this.fail(event, error instanceof Error ? error.message : String(error), true);
    }
  }

  private fail(event: OutboxEvent, message: string, retryable: boolean): 'retry' | 'dead' {
    const attempts = event.attempts + 1;
    const exhausted = attempts >= this.opts.maxAttempts;
    const dead = !retryable || exhausted;
    markEventRetry(this.db, event.id, message, attempts, nextAttempt(attempts, this.opts), dead);
    return dead ? 'dead' : 'retry';
  }
}
