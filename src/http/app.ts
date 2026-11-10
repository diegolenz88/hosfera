import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/database.ts';
import { config as defaultConfig, type Config } from '../config.ts';
import { AdapterRegistry } from '../connectivity/registry.ts';
import { bookingOptionsFromConfig } from '../connectivity/booking-config.ts';
import { Dispatcher } from '../services/dispatcher.service.ts';
import { ChannelError } from '../connectivity/adapter.ts';
import { PricingError } from '../domain/pricing.ts';
import { getAvailability, getQuote } from '../services/availability.service.ts';
import { ForbiddenError, NotFoundError, StateError, UnauthorizedError, ValidationError } from '../errors.ts';
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
  listAmenities,
  listIcalSources,
  getIcalSource,
  unitIdForFeedToken,
  listUnits,
  outboxStats,
  setAmenities,
} from '../db/repositories.ts';
import { normalizeAmenities } from '../domain/amenities.ts';
import { createToken, listTokens, resolveToken, revokeToken, ROLES, type AuthContext, type Role } from '../auth/tokens.ts';
import { AMENITIES } from '../domain/amenities.ts';
import { onboardProperty, duplicateUnit, updateUnitDetails } from '../services/onboarding.service.ts';
import { listUnitPhotos, readPhoto, removePhoto, storePhoto, requireUnitInOrg } from '../services/photo.service.ts';
import { payoutReport } from '../services/finance.service.ts';
import { reconcileOrg } from '../services/reconciliation.service.ts';
import {
  addIcalSource,
  exportUnitFeed,
  feedTokenFor,
  importFeedText,
  removeIcalSource,
  syncIcalSource,
} from '../services/ical.service.ts';
import { can, permissionsFor, type Action } from '../auth/permissions.ts';
import {
  assertConnectionAccess,
  assertListingAccess,
  assertOrg,
  assertPropertyAccess,
  assertReservationAccess,
  assertUnitAccess,
} from './scope.ts';
import type { Channel, ReservationStatus } from '../domain/types.ts';
import { CHANNELS } from '../domain/types.ts';
import { assertDate } from '../domain/dates.ts';
import { VERSION } from '../version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');

export interface AppOptions {
  db: Db;
  registry?: AdapterRegistry;
  config?: Config;
  dispatcher?: Dispatcher;
  /** Desliga o worker periódico (testes controlam o dispatcher manualmente). */
  startWorker?: boolean;
}

type AuthedRequest = FastifyRequest & { auth?: AuthContext };

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

/** Rotas que não exigem token (webhook se autentica por assinatura; UI é pública). */
const PUBLIC_PATHS = [
  '/health',
  '/v1/bootstrap',
  '/v1/webhooks/',
  '/v1/photos/',
  '/v1/ical/',
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
];

export function createApp(options: AppOptions): FastifyInstance {
  const cfg = options.config ?? defaultConfig;
  const registry =
    options.registry ??
    AdapterRegistry.withDefaults({
      enableMock: cfg.enableMockChannel,
      ...(cfg.booking ? { booking: bookingOptionsFromConfig(cfg) } : {}),
    });
  const dispatcher =
    options.dispatcher ??
    new Dispatcher(options.db, registry, {
      batchSize: cfg.dispatcher.batchSize,
      maxAttempts: cfg.dispatcher.maxAttempts,
      baseBackoffMs: cfg.dispatcher.baseBackoffMs,
      maxBackoffMs: cfg.dispatcher.maxBackoffMs,
    });

  const storageDir = cfg.uploadDir ?? './data/uploads';
  const app = Fastify({ logger: cfg.env === 'test' ? false : { level: 'warn' }, trustProxy: true });

  // Guarda o corpo cru: assinatura de webhook é sobre os bytes, não sobre o JSON reserializado.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string;
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
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

  // Canais OTA entregam reserva em XML: precisamos do corpo cru (assinatura) e
  // sem parse — o adaptador do canal interpreta o documento.
  for (const mediaType of ['application/xml', 'text/xml']) {
    app.addContentTypeParser(mediaType, { parseAs: 'string' }, (request, body, done) => {
      const raw = body as string;
      (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
      done(null, raw);
    });
  }

  const tokenFrom = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    const legacy = request.headers['x-api-key'];
    return typeof legacy === 'string' && legacy.length > 0 ? legacy : null;
  };

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = (request.url.split('?')[0] ?? '/') as string;
    if (PUBLIC_PATHS.some((prefix) => (prefix === '/' ? path === '/' : path.startsWith(prefix)))) return;

    const token = tokenFrom(request);
    if (!token) throw new UnauthorizedError('envie Authorization: Bearer <token>');
    const auth = resolveToken(options.db, token);
    if (!auth) throw new UnauthorizedError('token inválido ou revogado');
    (request as AuthedRequest).auth = auth;
    void reply;
  });

  /** Autoriza a ação e devolve o contexto; `org_id` nunca vem do cliente. */
  const guard = (request: FastifyRequest, action: Action): AuthContext => {
    const auth = (request as AuthedRequest).auth;
    if (!auth) throw new UnauthorizedError();
    if (!can(auth.role, action)) throw new ForbiddenError(`papel ${auth.role} não pode executar ${action}`);
    return auth;
  };

  app.setErrorHandler((error: Error & { validation?: unknown }, _request, reply) => {
    if (error instanceof UnauthorizedError) return reply.code(401).send({ error: 'unauthorized', message: error.message });
    if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden', message: error.message });
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

  const serve = (file: string, type: string) => (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type(type).header('cache-control', 'no-store').send(readFileSync(join(PUBLIC_DIR, file), 'utf8'));

  // ───────────────────────────── interface ─────────────────────────────

  app.get('/', serve('index.html', 'text/html; charset=utf-8'));
  app.get('/index.html', serve('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', serve('app.js', 'text/javascript; charset=utf-8'));
  app.get('/styles.css', serve('styles.css', 'text/css; charset=utf-8'));

  // ───────────────────────────── sistema ─────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    service: 'hosfera',
    version: VERSION,
    env: cfg.env,
    channels: registry.list().map((adapter) => adapter.channel),
    outbox: outboxStats(options.db),
  }));

  app.get('/v1/channels', async (request) => {
    guard(request, 'org:read');
    return registry.catalog();
  });

  /**
   * Bootstrap: cria organização + primeiro token de `owner`.
   * Protegido por segredo de ambiente — é o único caminho sem token.
   */
  app.post('/v1/bootstrap', async (request, reply) => {
    const provided = request.headers['x-bootstrap-key'];
    const configured = Boolean(process.env.HOSFERA_BOOTSTRAP);
    if (cfg.env === 'production' && !configured) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (provided !== cfg.bootstrapKey) throw new UnauthorizedError('chave de bootstrap inválida');

    const body = request.body as Record<string, unknown>;
    const org = createOrganization(options.db, requireString(body, 'orgName'));
    const userName = requireString(body, 'userName');
    const { token } = createToken(options.db, { orgId: org.id, userName, role: 'owner' });
    return reply.code(201).send({
      organization: org,
      user: { name: userName, role: 'owner' },
      token,
      warning: 'guarde este token: ele não é exibido novamente',
    });
  });

  app.get('/v1/me', async (request) => {
    const auth = guard(request, 'org:read');
    const org = getOrganization(options.db, auth.orgId);
    return {
      user: auth.userName,
      role: auth.role,
      organization: org,
      permissions: permissionsFor(auth.role),
    };
  });

  app.get('/v1/tokens', async (request) => {
    const auth = guard(request, 'token:manage');
    return listTokens(options.db, auth.orgId).map((token) => ({ ...token, tokenHash: undefined }));
  });

  app.post('/v1/tokens', async (request, reply) => {
    const auth = guard(request, 'token:manage');
    const body = request.body as Record<string, unknown>;
    const role = requireString(body, 'role') as Role;
    if (!ROLES.includes(role)) badRequest(`papel inválido: ${role}`);
    const created = createToken(options.db, {
      orgId: auth.orgId,
      userName: requireString(body, 'userName'),
      role,
      label: (body.label as string | undefined) ?? 'default',
    });
    return reply.code(201).send({
      id: created.record.id,
      role: created.record.role,
      userName: created.record.userName,
      token: created.token,
      warning: 'guarde este token: ele não é exibido novamente',
    });
  });

  app.delete('/v1/tokens/:id', async (request, reply) => {
    const auth = guard(request, 'token:manage');
    const { id } = request.params as { id: string };
    const revoked = revokeToken(options.db, auth.orgId, id);
    if (!revoked) throw new NotFoundError(`token não encontrado: ${id}`);
    return reply.code(204).send();
  });

  // ───────────────────────────── organizações e inventário ─────────────────────────────

  app.get('/v1/organizations/:id', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    if (id !== auth.orgId) throw new NotFoundError(`organização não encontrada: ${id}`);
    const org = getOrganization(options.db, id);
    if (!org) throw new NotFoundError(`organização não encontrada: ${id}`);
    return org;
  });

  app.get('/v1/properties', async (request) => {
    const auth = guard(request, 'org:read');
    return listProperties(options.db, assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId));
  });

  app.post('/v1/properties', async (request, reply) => {
    const auth = guard(request, 'property:write');
    const body = request.body as Record<string, unknown>;
    const property = createProperty(options.db, {
      orgId: assertOrg(auth.orgId, (body.orgId as string | undefined) ?? null),
      name: requireString(body, 'name'),
      city: (body.city as string | undefined) ?? null,
      state: (body.state as string | undefined) ?? null,
      address: (body.address as string | undefined) ?? null,
    });
    return reply.code(201).send(property);
  });

  app.get('/v1/properties/:id/units', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertPropertyAccess(options.db, auth.orgId, id);
    return listUnits(options.db, id).map((unit) => ({ ...unit, amenities: listAmenities(options.db, unit.id) }));
  });

  app.post('/v1/properties/:id/units', async (request, reply) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    assertPropertyAccess(options.db, auth.orgId, id);
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
    const auth = guard(request, 'rate:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
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
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    return listRatePlans(options.db, id);
  });

  app.get('/v1/units/:id/availability', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) badRequest('queries obrigatórias: from, to');
    assertDate(from);
    assertDate(to);
    return getAvailability(options.db, { unitId: id, from, to });
  });

  app.get('/v1/units/:id/quote', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const { checkin, checkout, ratePlanId } = request.query as {
      checkin?: string;
      checkout?: string;
      ratePlanId?: string;
    };
    if (!checkin || !checkout) badRequest('queries obrigatórias: checkin, checkout');
    return getQuote(options.db, { unitId: id, checkin, checkout, ratePlanId });
  });

  app.put('/v1/units/:id/ari', async (request) => {
    const auth = guard(request, 'ari:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
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
    const auth = guard(request, 'block:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    const result = blockDates(options.db, {
      unitId: id,
      startDate: requireString(body, 'startDate'),
      endDate: requireString(body, 'endDate'),
      reason: (body.reason as string | undefined) ?? undefined,
    });
    return reply.code(201).send(result);
  });

  // ───────────────────────────── iCal (sincronização de agenda) ─────────────────────────────

  app.get('/v1/units/:id/ical-sources', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    return listIcalSources(options.db, id);
  });

  app.post('/v1/units/:id/ical-sources', async (request, reply) => {
    const auth = guard(request, 'connection:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    const source = addIcalSource(options.db, {
      orgId: auth.orgId,
      unitId: id,
      url: requireString(body, 'url'),
      label: (body.label as string | undefined) ?? null,
    });
    return reply.code(201).send(source);
  });

  app.post('/v1/ical-sources/:id/sync', async (request) => {
    const auth = guard(request, 'connection:write');
    const { id } = request.params as { id: string };
    const source = getIcalSource(options.db, id);
    if (!source) throw new NotFoundError(`fonte iCal não encontrada: ${id}`);
    assertUnitAccess(options.db, auth.orgId, source.unitId);
    return syncIcalSource(options.db, id);
  });

  app.delete('/v1/ical-sources/:id', async (request) => {
    const auth = guard(request, 'connection:write');
    const { id } = request.params as { id: string };
    const source = getIcalSource(options.db, id);
    if (!source) throw new NotFoundError(`fonte iCal não encontrada: ${id}`);
    assertUnitAccess(options.db, auth.orgId, source.unitId);
    return removeIcalSource(options.db, id);
  });

  // Importa texto colado — usado pelos testes e por quem só tem o .ics em mãos.
  app.post('/v1/units/:id/ical-import', async (request) => {
    const auth = guard(request, 'connection:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    const sourceId = requireString(body, 'sourceId');
    const text = requireString(body, 'text');
    return importFeedText(options.db, { unitId: id, sourceId, text });
  });

  app.get('/v1/units/:id/ical-feed', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const token = feedTokenFor(options.db, id);
    return { url: `/v1/ical/${token}.ics`, token };
  });

  // Canal assina sem login: o token é a credencial e só expõe noites ocupadas.
  app.get('/v1/ical/:token.ics', async (request, reply) => {
    const { token } = request.params as { token: string };
    const unitId = unitIdForFeedToken(options.db, token);
    if (!unitId) throw new NotFoundError('feed não encontrado');
    const feed = exportUnitFeed(options.db, unitId);
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', `inline; filename="${unitId}.ics"`)
      .header('cache-control', 'no-cache')
      .send(feed.body);
  });

  // ───────────────────────────── conexões e anúncios ─────────────────────────────

  app.get('/v1/connections', async (request) => {
    const auth = guard(request, 'org:read');
    return listConnections(options.db, assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId));
  });

  app.post('/v1/connections', async (request, reply) => {
    const auth = guard(request, 'connection:write');
    const body = request.body as Record<string, unknown>;
    const channel = requireString(body, 'channel') as Channel;
    if (!CHANNELS.includes(channel)) badRequest(`canal inválido: ${channel}`);
    if (!registry.has(channel)) badRequest(`canal não suportado pelo runtime: ${channel}`);
    const connection = createConnection(options.db, {
      orgId: assertOrg(auth.orgId, (body.orgId as string | undefined) ?? null),
      channel,
      label: requireString(body, 'label'),
      status: (body.status as 'pending' | 'active') ?? 'active',
      externalAccount: (body.externalAccount as string | undefined) ?? null,
    });
    return reply.code(201).send(connection);
  });

  app.post('/v1/listings', async (request, reply) => {
    const auth = guard(request, 'listing:write');
    const body = request.body as Record<string, unknown>;
    const unitId = requireString(body, 'unitId');
    const connectionId = requireString(body, 'connectionId');
    assertUnitAccess(options.db, auth.orgId, unitId);
    assertConnectionAccess(options.db, auth.orgId, connectionId);
    const listing = createListing(options.db, {
      unitId,
      connectionId,
      externalId: (body.externalId as string | undefined) ?? null,
    });
    return reply.code(201).send(listing);
  });

  app.get('/v1/units/:id/listings', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    return listListingsByUnit(options.db, id);
  });

  app.get('/v1/listings', async (request) => {
    const auth = guard(request, 'org:read');
    return listAllListings(options.db, assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId));
  });

  app.post('/v1/listings/:id/publish', async (request) => {
    const auth = guard(request, 'listing:publish');
    const { id } = request.params as { id: string };
    assertListingAccess(options.db, auth.orgId, id);
    return publishListing(options.db, registry, id);
  });

  // ───────────────────────────── onboarding ─────────────────────────────

  app.get('/v1/amenities', async (request) => {
    guard(request, 'org:read');
    return AMENITIES;
  });

  app.post('/v1/onboarding', async (request, reply) => {
    const auth = guard(request, 'property:write');
    const body = request.body as Record<string, unknown>;
    const property = (body.property ?? {}) as Record<string, unknown>;
    const units = Array.isArray(body.units) ? (body.units as Record<string, unknown>[]) : [];
    const result = onboardProperty(options.db, {
      orgId: assertOrg(auth.orgId, (body.orgId as string | undefined) ?? null),
      property: {
        name: requireString(property, 'name'),
        city: property.city as string | undefined,
        state: property.state as string | undefined,
        address: property.address as string | undefined,
        ownerName: property.ownerName as string | undefined,
        ownerEmail: property.ownerEmail as string | undefined,
        ownerSharePct: optionalNumber(property.ownerSharePct),
      },
      units: units.map((unit) => ({
        name: requireString(unit, 'name'),
        inventory: optionalNumber(unit.inventory),
        capacity: optionalNumber(unit.capacity),
        basePriceCents: optionalNumber(unit.basePriceCents) ?? 0,
        cleaningFeeCents: optionalNumber(unit.cleaningFeeCents),
        weekendUpliftPct: optionalNumber(unit.weekendUpliftPct),
        minStay: optionalNumber(unit.minStay),
        amenities: unit.amenities,
        checkinFrom: unit.checkinFrom as string | undefined,
        checkoutUntil: unit.checkoutUntil as string | undefined,
        houseRules: unit.houseRules as string | undefined,
      })),
    });
    return reply.code(201).send(result);
  });

  app.post('/v1/units/:id/duplicate', async (request, reply) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = duplicateUnit(options.db, { orgId: auth.orgId, unitId: id, name: body.name as string | undefined });
    return reply.code(201).send(result);
  });

  app.patch('/v1/units/:id', async (request) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    return updateUnitDetails(options.db, {
      orgId: auth.orgId,
      unitId: id,
      capacity: optionalNumber(body.capacity),
      checkinFrom: body.checkinFrom as string | undefined,
      checkoutUntil: body.checkoutUntil as string | undefined,
      houseRules: body.houseRules as string | undefined,
    });
  });

  app.put('/v1/units/:id/amenities', async (request) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    assertUnitAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    const codes = body.codes;
    const amenities = normalizeAmenities(codes);
    setAmenities(options.db, id, amenities);
    return { unitId: id, amenities };
  });

  // ───────────────────────────── fotos ─────────────────────────────

  app.post('/v1/units/:id/photos', async (request, reply) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const photo = storePhoto(options.db, { storageDir }, {
      orgId: auth.orgId,
      unitId: id,
      dataBase64: requireString(body, 'dataBase64'),
      declaredType: body.contentType as string | undefined,
    });
    return reply.code(201).send(photo);
  });

  app.get('/v1/units/:id/photos', async (request) => {
    const auth = guard(request, 'org:read');
    const { id } = request.params as { id: string };
    return listUnitPhotos(options.db, auth.orgId, id);
  });

  /** Imagem precisa aceitar token na query: <img src> não envia header. */
  app.get('/v1/photos/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { t?: string };
    const token = query.t ?? (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : null);
    const auth = token ? resolveToken(options.db, token) : null;
    if (!auth) throw new UnauthorizedError('informe ?t=<token> para carregar a imagem');

    const file = readPhoto(options.db, { storageDir }, id);
    const photo = options.db.prepare('SELECT unit_id FROM unit_photos WHERE id = ?').get(id) as { unit_id?: string } | undefined;
    if (!photo?.unit_id) throw new NotFoundError(`foto não encontrada: ${id}`);
    requireUnitInOrg(options.db, auth.orgId, photo.unit_id);

    return reply
      .header('content-type', file.contentType)
      .header('cache-control', 'private, max-age=3600')
      .header('etag', `"${file.sha256}"`)
      .send(file.bytes);
  });

  app.delete('/v1/photos/:id', async (request, reply) => {
    const auth = guard(request, 'unit:write');
    const { id } = request.params as { id: string };
    removePhoto(options.db, { storageDir }, { orgId: auth.orgId, photoId: id });
    return reply.code(204).send();
  });

  // ───────────────────────────── financeiro ─────────────────────────────

  app.get('/v1/finance/payouts', async (request) => {
    const auth = guard(request, 'finance:read');
    const { from, to, propertyId } = request.query as { from?: string; to?: string; propertyId?: string };
    if (!from || !to) badRequest('queries obrigatórias: from, to');
    return payoutReport(options.db, assertOrg(auth.orgId, null), { from, to, propertyId });
  });

  app.get('/v1/reconciliation', async (request) => {
    const auth = guard(request, 'finance:read');
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) badRequest('queries obrigatórias: from, to');
    return reconcileOrg(options.db, assertOrg(auth.orgId, null), { from, to });
  });

  // ───────────────────────────── reservas ─────────────────────────────

  app.post('/v1/webhooks/:channel/:connectionId', async (request, reply) => {
    const { channel, connectionId } = request.params as { channel: string; connectionId: string };
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers = request.headers as Record<string, string | undefined>;
    const adapter = registry.get(channel);
    const echoToken = typeof headers['echo-token'] === 'string' ? headers['echo-token'] : undefined;

    try {
      const result = ingestReservation(options.db, registry, {
        channel: channel as Channel,
        connectionId,
        headers,
        rawBody,
        raw: request.body,
      });
      // Canais OTA esperam a confirmação no próprio formato; devolver JSON faz
      // o canal reenviar a reserva em loop.
      const ack = adapter.confirmWebhook?.({
        reservationId: result.reservation.externalId,
        externalListingId: result.reservation.unitId,
        echoToken,
      });
      if (ack) return reply.code(ack.status).header('content-type', ack.contentType).send(ack.body);
      return reply.code(result.created ? 201 : 200).send({
        reservationId: result.reservation.id,
        status: result.reservation.status,
        created: result.created,
        tasksCreated: result.tasksCreated,
        republished: result.republished,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ack = adapter.confirmWebhook?.({ reservationId: '', externalListingId: '', echoToken, error: message });
      if (ack) return reply.code(ack.status).header('content-type', ack.contentType).send(ack.body);
      throw error;
    }
  });

  app.get('/v1/reservations', async (request) => {
    const auth = guard(request, 'reservation:read');
    const { limit } = request.query as { limit?: string };
    return listReservations(options.db, assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId), optionalNumber(limit) ?? 50);
  });

  app.get('/v1/reservations/:id', async (request) => {
    const auth = guard(request, 'reservation:read');
    const { id } = request.params as { id: string };
    assertReservationAccess(options.db, auth.orgId, id);
    return reservationDetail(options.db, id);
  });

  app.post('/v1/reservations/:id/status', async (request) => {
    const auth = guard(request, 'reservation:write');
    const { id } = request.params as { id: string };
    assertReservationAccess(options.db, auth.orgId, id);
    const body = request.body as Record<string, unknown>;
    const status = requireString(body, 'status') as ReservationStatus;
    const result = transitionReservation(options.db, { reservationId: id, status });
    return { reservation: result.reservation, republished: result.republished };
  });

  app.get('/v1/reservations/:id/ledger', async (request) => {
    const auth = guard(request, 'finance:read');
    const { id } = request.params as { id: string };
    assertReservationAccess(options.db, auth.orgId, id);
    return listLedger(options.db, id);
  });

  // ───────────────────────────── operação ─────────────────────────────

  app.get('/v1/tasks', async (request) => {
    const auth = guard(request, 'reservation:read');
    const { status } = request.query as { status?: string };
    return listTasks(options.db, { orgId: assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId), status });
  });

  app.get('/v1/outbox', async (request) => {
    guard(request, 'outbox:read');
    const { connectionId, status } = request.query as { connectionId?: string; status?: string };
    return { stats: outboxStats(options.db), events: listOutbox(options.db, { connectionId, status }) };
  });

  app.post('/v1/outbox/dispatch', async (request) => {
    guard(request, 'outbox:dispatch');
    return dispatcher.runOnce();
  });

  app.get('/v1/audit', async (request) => {
    guard(request, 'audit:read');
    const { scope, refId } = request.query as { scope?: string; refId?: string };
    if (!scope) badRequest('query obrigatória: scope');
    return listEventLog(options.db, scope, refId ?? null);
  });

  app.get('/v1/summary', async (request) => {
    const auth = guard(request, 'finance:read');
    const orgId = assertOrg(auth.orgId, (request.query as { orgId?: string }).orgId);
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
    const auth = guard(request, 'reservation:write');
    const body = request.body as Record<string, unknown>;
    const connectionId = requireString(body, 'connectionId');
    assertConnectionAccess(options.db, auth.orgId, connectionId);
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
      totalCents: optionalNumber(body.totalCents) ?? null,
      commissionCents: optionalNumber(body.commissionCents) ?? null,
      currency: 'BRL',
    };

    mock.registerReservation({ ...payload, status: 'confirmed', currency: 'BRL' } as never);

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
