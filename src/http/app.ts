import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Db } from '../db/database.ts';
import { config as defaultConfig, type Config } from '../config.ts';
import { AdapterRegistry } from '../connectivity/registry.ts';
import { Dispatcher } from '../services/dispatcher.service.ts';
import { ChannelError } from '../connectivity/adapter.ts';
import { PricingError } from '../domain/pricing.ts';
import { getAvailability, getQuote } from '../services/availability.service.ts';
import { NotFoundError, StateError, ValidationError } from '../errors.ts';
import { blockDates, setAri } from '../services/ari.service.ts';
import { publishListing } from '../services/publishing.service.ts';
import { ingestReservation, reservationDetail, transitionReservation } from '../services/reservation.service.ts';
import {
  createConnection,
  createListing,
  createOrganization,
  createProperty,
  createRatePlan,
  createUnit,
  getOrganization,
  getReservation,
  listAllListings,
  listConnections,
  listEventLog,
  listLedger,
  listListingsByUnit,
  listOutbox,
  listProperties,
  listRatePlans,
  listReservations,
  listTasks,
  listUnits,
  outboxStats,
} from '../db/repositories.ts';
import type { Channel, ReservationStatus } from '../domain/types.ts';
import { CHANNELS } from '../domain/types.ts';
import { assertDate } from '../domain/dates.ts';

export interface AppOptions {
  db: Db;
  registry?: AdapterRegistry;
  config?: Config;
  dispatcher?: Dispatcher;
  /** Desliga o worker periódico (testes controlam o dispatcher manualmente). */
  startWorker?: boolean;
}

/**
 * Declarado como function (e não const) para o TypeScript tratar a chamada como
 * término de fluxo — é o que faz `if (!from) badRequest(...)` estreitar o tipo.
 */
function badRequest(message: string): never {
  const error = new Error(message);
  error.name = 'BadRequest';
  throw error;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') badRequest(`campo obrigatório: ${field}`);
  const trimmed = value.trim();
  if (trimmed === '') badRequest(`campo obrigatório: ${field}`);
  return trimmed;
}

const optionalNumber = (value: unknown): number | undefined =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

export function createApp(options: AppOptions): FastifyInstance {
  const cfg = options.config ?? defaultConfig;
  const registry = options.registry ?? AdapterRegistry.withDefaults({ enableMock: cfg.enableMockChannel });
  const dispatcher =
    options.dispatcher ??
    new Dispatcher(options.db, registry, {
      batchSize: cfg.dispatcher.batchSize,
      maxAttempts: cfg.dispatcher.maxAttempts,
      baseBackoffMs: cfg.dispatcher.baseBackoffMs,
      maxBackoffMs: cfg.dispatcher.maxBackoffMs,
    });

  const app = Fastify({ logger: cfg.env === 'test' ? false : { level: 'warn' }, trustProxy: true });

  // Guarda o corpo cru: assinatura de webhook é sobre os bytes, não sobre o JSON reserializado.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string;
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
    // Corpo vazio é legítimo (POST sem payload): não é JSON inválido.
    if (raw.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new Error('JSON inválido'), undefined);
    }
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/health')) return;
    if (request.url.startsWith('/v1/webhooks/')) return; // autenticado por assinatura
    if (request.url.startsWith('/v1/dev/')) return; // apenas em desenvolvimento
    const provided = request.headers['x-api-key'];
    if (provided !== cfg.authKey) {
      await reply.code(401).send({ error: 'unauthorized', message: 'x-api-key ausente ou inválida' });
    }
  });

  app.setErrorHandler((error: Error & { validation?: unknown }, _request, reply) => {
    if (error instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: error.message });
    if (error instanceof StateError) return reply.code(409).send({ error: 'invalid_state', message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: 'bad_request', message: error.message });
    if (error instanceof PricingError) return reply.code(422).send({ error: 'pricing_error', message: error.message });
    if (error instanceof ChannelError) {
      return reply.code(error.code === 'channel_not_certified' ? 409 : 502).send({
        error: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    if (error.name === 'BadRequest') return reply.code(400).send({ error: 'bad_request', message: error.message });
    if (error.validation) return reply.code(400).send({ error: 'validation_error', message: error.message });
    const message = error instanceof Error ? error.message : String(error);
    if (/inválid|obrigatóri|desconhecid|não encontrad|posterior|mínima|máxima|transição/i.test(message)) {
      return reply.code(400).send({ error: 'bad_request', message });
    }
    console.error('[http] erro não tratado:', error);
    return reply.code(500).send({ error: 'internal_error', message: 'erro interno' });
  });

  // ───────────────────────────── sistema ─────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    service: 'hosfera',
    version: '0.1.0',
    env: cfg.env,
    channels: registry.list().map((adapter) => adapter.channel),
    outbox: outboxStats(options.db),
  }));

  app.get('/v1/channels', async () => registry.catalog());

  // ───────────────────────────── organizações e inventário ─────────────────────────────

  app.post('/v1/organizations', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const org = createOrganization(options.db, requireString(body, 'name'));
    return reply.code(201).send(org);
  });

  app.get('/v1/organizations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const org = getOrganization(options.db, id);
    if (!org) throw new NotFoundError(`organização não encontrada: ${id}`);
    return reply.send(org);
  });

  app.get('/v1/properties', async (request) => {
    const { orgId } = request.query as { orgId?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    return listProperties(options.db, orgId);
  });

  app.post('/v1/properties', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const orgId = requireString(body, 'orgId');
    if (!getOrganization(options.db, orgId)) throw new NotFoundError(`organização não encontrada: ${orgId}`);
    const property = createProperty(options.db, {
      orgId,
      name: requireString(body, 'name'),
      city: (body.city as string | undefined) ?? null,
      state: (body.state as string | undefined) ?? null,
      address: (body.address as string | undefined) ?? null,
    });
    return reply.code(201).send(property);
  });

  app.get('/v1/properties/:id/units', async (request) => {
    const { id } = request.params as { id: string };
    return listUnits(options.db, id);
  });

  app.post('/v1/properties/:id/units', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const unit = createUnit(options.db, {
      propertyId: id,
      name: requireString(body, 'name'),
      inventory: optionalNumber(body.inventory) ?? 1,
      minStay: optionalNumber(body.minStay) ?? 1,
      maxStay: optionalNumber(body.maxStay) ?? 365,
    });
    return reply.code(201).send(unit);
  });

  app.post('/v1/units/:id/rate-plans', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const basePriceCents = optionalNumber(body.basePriceCents);
    if (basePriceCents === undefined || basePriceCents <= 0) badRequest('basePriceCents deve ser positivo');
    const plan = createRatePlan(options.db, {
      unitId: id,
      name: requireString(body, 'name'),
      basePriceCents,
      weekendUpliftPct: optionalNumber(body.weekendUpliftPct) ?? 0,
      cleaningFeeCents: optionalNumber(body.cleaningFeeCents) ?? 0,
      minStay: optionalNumber(body.minStay) ?? 1,
    });
    return reply.code(201).send(plan);
  });

  app.get('/v1/units/:id/rate-plans', async (request) => {
    const { id } = request.params as { id: string };
    return listRatePlans(options.db, id);
  });

  app.get('/v1/units/:id/availability', async (request) => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) badRequest('queries obrigatórias: from, to');
    assertDate(from);
    assertDate(to);
    return getAvailability(options.db, { unitId: id, from, to });
  });

  app.get('/v1/units/:id/quote', async (request) => {
    const { id } = request.params as { id: string };
    const { checkin, checkout, ratePlanId } = request.query as {
      checkin?: string;
      checkout?: string;
      ratePlanId?: string;
    };
    if (!checkin || !checkout) badRequest('queries obrigatórias: checkin, checkout');
    return getQuote(options.db, { unitId: id, checkin, checkout, ratePlanId });
  });

  app.put('/v1/units/:id/ari', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { days?: unknown };
    if (!Array.isArray(body.days) || body.days.length === 0) badRequest('days deve ser uma lista não vazia');
    const days = body.days.map((raw) => {
      const day = raw as Record<string, unknown>;
      const date = requireString(day, 'date');
      return {
        date,
        rateCents: optionalNumber(day.rateCents) ?? null,
        available: optionalNumber(day.available) ?? null,
        minStay: optionalNumber(day.minStay) ?? null,
        closed: day.closed === true,
      };
    });
    return setAri(options.db, { unitId: id, days });
  });

  app.post('/v1/units/:id/blocks', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const result = blockDates(options.db, {
      unitId: id,
      startDate: requireString(body, 'startDate'),
      endDate: requireString(body, 'endDate'),
      reason: (body.reason as string | undefined) ?? undefined,
    });
    return reply.code(201).send(result);
  });

  // ───────────────────────────── conexões e anúncios ─────────────────────────────

  app.get('/v1/connections', async (request) => {
    const { orgId } = request.query as { orgId?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    return listConnections(options.db, orgId);
  });

  app.post('/v1/connections', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const channel = requireString(body, 'channel') as Channel;
    if (!CHANNELS.includes(channel)) badRequest(`canal inválido: ${channel}`);
    if (!registry.has(channel)) badRequest(`canal não suportado pelo runtime: ${channel}`);
    const connection = createConnection(options.db, {
      orgId: requireString(body, 'orgId'),
      channel,
      label: requireString(body, 'label'),
      status: (body.status as 'pending' | 'active') ?? 'active',
      externalAccount: (body.externalAccount as string | undefined) ?? null,
    });
    return reply.code(201).send(connection);
  });

  app.post('/v1/listings', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const listing = createListing(options.db, {
      unitId: requireString(body, 'unitId'),
      connectionId: requireString(body, 'connectionId'),
      externalId: (body.externalId as string | undefined) ?? null,
    });
    return reply.code(201).send(listing);
  });

  app.get('/v1/units/:id/listings', async (request) => {
    const { id } = request.params as { id: string };
    return listListingsByUnit(options.db, id);
  });

  app.get('/v1/listings', async (request) => {
    const { orgId } = request.query as { orgId?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    return listAllListings(options.db, orgId);
  });

  app.post('/v1/listings/:id/publish', async (request) => {
    const { id } = request.params as { id: string };
    return publishListing(options.db, registry, id);
  });

  // ───────────────────────────── reservas ─────────────────────────────

  app.post('/v1/webhooks/:channel/:connectionId', async (request, reply) => {
    const { channel, connectionId } = request.params as { channel: string; connectionId: string };
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers = request.headers as Record<string, string | undefined>;
    const result = ingestReservation(options.db, registry, {
      channel: channel as Channel,
      connectionId,
      headers,
      rawBody,
      raw: request.body,
    });
    return reply.code(result.created ? 201 : 200).send({
      reservationId: result.reservation.id,
      status: result.reservation.status,
      created: result.created,
      tasksCreated: result.tasksCreated,
      republished: result.republished,
    });
  });

  app.get('/v1/reservations', async (request) => {
    const { orgId, limit } = request.query as { orgId?: string; limit?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    return listReservations(options.db, orgId, optionalNumber(limit) ?? 50);
  });

  app.get('/v1/reservations/:id', async (request) => {
    const { id } = request.params as { id: string };
    return reservationDetail(options.db, id);
  });

  app.post('/v1/reservations/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const status = requireString(body, 'status') as ReservationStatus;
    const result = transitionReservation(options.db, { reservationId: id, status });
    return { reservation: result.reservation, republished: result.republished };
  });

  app.get('/v1/reservations/:id/ledger', async (request) => {
    const { id } = request.params as { id: string };
    if (!getReservation(options.db, id)) throw new NotFoundError(`reserva não encontrada: ${id}`);
    return listLedger(options.db, id);
  });

  // ───────────────────────────── operação ─────────────────────────────

  app.get('/v1/tasks', async (request) => {
    const { orgId, status } = request.query as { orgId?: string; status?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    return listTasks(options.db, { orgId, status });
  });

  app.get('/v1/outbox', async (request) => {
    const { connectionId, status } = request.query as { connectionId?: string; status?: string };
    return { stats: outboxStats(options.db), events: listOutbox(options.db, { connectionId, status }) };
  });

  app.post('/v1/outbox/dispatch', async () => dispatcher.runOnce());

  app.get('/v1/audit', async (request) => {
    const { scope, refId } = request.query as { scope?: string; refId?: string };
    if (!scope) badRequest('query obrigatória: scope');
    return listEventLog(options.db, scope, refId ?? null);
  });

  app.get('/v1/summary', async (request) => {
    const { orgId } = request.query as { orgId?: string };
    if (!orgId) badRequest('query obrigatória: orgId');
    const reservations = listReservations(options.db, orgId, 500);
    const active = reservations.filter((r) => r.status !== 'cancelled' && r.status !== 'no_show');
    const gross = active.reduce((sum, r) => sum + r.totalCents, 0);
    const commission = active.reduce((sum, r) => sum + r.commissionCents, 0);
    return {
      orgId,
      reservations: reservations.length,
      activeReservations: active.length,
      grossCents: gross,
      commissionCents: commission,
      netCents: gross - commission,
      pendingTasks: listTasks(options.db, { orgId, status: 'pending' }).length,
      outbox: outboxStats(options.db),
      channels: registry.list().map((adapter) => adapter.channel),
    };
  });

  // ───────────────────────────── simulador de OTA (dev) ─────────────────────────────

  app.post('/v1/dev/mock/reservations', async (request, reply) => {
    if (cfg.env === 'production') return reply.code(404).send({ error: 'not_found' });
    const body = request.body as Record<string, unknown>;
    const connectionId = requireString(body, 'connectionId');
    const mock = registry.get('mock') as unknown as { registerReservation: (r: unknown) => void; sign: (b: string) => string };

    const payload = {
      externalId: requireString(body, 'externalId'),
      externalListingId: requireString(body, 'externalListingId'),
      checkin: requireString(body, 'checkin'),
      checkout: requireString(body, 'checkout'),
      guests: optionalNumber(body.guests) ?? 2,
      guestName: (body.guestName as string | undefined) ?? 'Hóspede teste',
      guestEmail: (body.guestEmail as string | undefined) ?? null,
      status: (body.status as string | undefined) ?? 'confirmed',
      // null = não informado; o serviço preserva o valor existente em updates.
      totalCents: optionalNumber(body.totalCents) ?? null,
      commissionCents: optionalNumber(body.commissionCents) ?? null,
      currency: 'BRL',
    };

    mock.registerReservation({
      ...payload,
      guestEmail: payload.guestEmail,
      status: 'confirmed',
      currency: 'BRL',
    } as never);

    const rawBody = JSON.stringify(payload);
    const result = ingestReservation(options.db, registry, {
      channel: 'mock',
      connectionId,
      headers: { 'x-mock-signature': mock.sign(rawBody), 'content-type': 'application/json' },
      rawBody,
      raw: payload,
    });
    return reply.code(result.created ? 201 : 200).send({
      reservationId: result.reservation.id,
      status: result.reservation.status,
      created: result.created,
      tasksCreated: result.tasksCreated,
      republished: result.republished,
    });
  });

  if (options.startWorker) {
    app.addHook('onReady', async () => {
      dispatcher.start(cfg.dispatcher.intervalMs);
    });
    app.addHook('onClose', async () => {
      dispatcher.stop();
    });
  }

  return app;
}
