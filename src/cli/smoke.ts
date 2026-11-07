/**
 * Smoke test de ponta a ponta sobre HTTP real.
 *
 * Sobe a API em porta efêmera com banco em memória e percorre o fluxo completo:
 * catálogo → publicação → ARI → dispatch → reserva de canal → disponibilidade →
 * tarefas → financeiro → fan-out entre canais.
 *
 * Falha com exit code 1 no primeiro passo que não bater.
 */
import { openDatabase } from '../db/database.ts';
import { createApp } from '../http/app.ts';
import { AdapterRegistry } from '../connectivity/registry.ts';
import type { MockChannelAdapter } from '../connectivity/adapters/mock.ts';
import { addDays, todayUtc } from '../domain/dates.ts';

const BOOTSTRAP = 'smoke-bootstrap';
const db = openDatabase(':memory:');
const registry = AdapterRegistry.withDefaults({ enableMock: true });
const mock = registry.get('mock') as unknown as MockChannelAdapter;

const app = createApp({
  db,
  registry,
  startWorker: false,
  config: {
    env: 'test',
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    bootstrapKey: BOOTSTRAP,
    dispatcher: { intervalMs: 60_000, batchSize: 50, maxAttempts: 6, baseBackoffMs: 1000, maxBackoffMs: 60_000 },
    enableMockChannel: true,
  },
});

await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('endereço do servidor indisponível');
const base = `http://127.0.0.1:${address.port}`;

let checks = 0;
const failures: string[] = [];

let token = '';

async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return json as T;
}

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FALHA ${label}`, detail ?? '');
  }
}

const start = todayUtc();
const checkin = addDays(start, 21);
const checkout = addDays(start, 24);

try {
  console.log('\n▶ health');
  const health = await call<{ status: string; channels: string[] }>('GET', '/health');
  check('serviço responde ok', health.status === 'ok');
  check('catálogo inclui os 6 canais + mock', health.channels.length === 7, health.channels);


  console.log('\n▶ bootstrap e identidade');
  const boot = await call<{ organization: { id: string }; token: string; user: { role: string } }>(
    'POST',
    '/v1/bootstrap',
    { orgName: 'Org Smoke', userName: 'Operador Smoke' },
    { 'x-bootstrap-key': BOOTSTRAP },
  );
  token = boot.token;
  const org = boot.organization;
  check('bootstrap devolve token de owner', boot.user.role === 'owner' && token.startsWith('hsk_'), boot.user);
  const me = await call<{ organization: { id: string }; role: string; permissions: string[] }>('GET', '/v1/me');
  check('token resolve a própria organização', me.organization.id === org.id && me.permissions.length > 0, me.role);

  const catalog = await call<{ channel: string; implemented: boolean; certification: string }[]>('GET', '/v1/channels');
  const booking = catalog.find((entry) => entry.channel === 'booking');
  check('booking anuncia protocolo implementado', booking?.implemented === true, booking);
  check('booking segue pendente de homologação', /Connectivity Partner/.test(booking?.certification ?? ''), booking);

  console.log('\n▶ inventário');
  const property = await call<{ id: string }>('POST', '/v1/properties', { orgId: org.id, name: 'Casa Smoke', city: 'Porto Seguro' });
  const unit = await call<{ id: string }>('POST', `/v1/properties/${property.id}/units`, { name: 'Suíte', inventory: 1, minStay: 2 });
  await call('POST', `/v1/units/${unit.id}/rate-plans`, {
    name: 'Flexível',
    basePriceCents: 40_000,
    weekendUpliftPct: 20,
    cleaningFeeCents: 10_000,
    minStay: 2,
  });
  check('unidade criada', Boolean(unit.id));

  console.log('\n▶ conexões e publicação');
  const mockConn = await call<{ id: string }>('POST', '/v1/connections', {
    orgId: org.id,
    channel: 'mock',
    label: 'Mock principal',
    status: 'active',
  });
  const mockConn2 = await call<{ id: string }>('POST', '/v1/connections', {
    orgId: org.id,
    channel: 'mock',
    label: 'Mock secundário',
    status: 'active',
  });
  const bookingConn = await call<{ id: string }>('POST', '/v1/connections', {
    orgId: org.id,
    channel: 'booking',
    label: 'Booking pendente',
    status: 'active',
  });

  const listing1 = await call<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: mockConn.id });
  const listing2 = await call<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: mockConn2.id });
  const bookingListing = await call<{ id: string }>('POST', '/v1/listings', { unitId: unit.id, connectionId: bookingConn.id });

  const published1 = await call<{ externalId: string }>('POST', `/v1/listings/${listing1.id}/publish`);
  await call('POST', `/v1/listings/${listing2.id}/publish`);
  check('anúncio publicado com id externo', published1.externalId.startsWith('MOCK-'), published1);

  const bookingPublish = await fetch(`${base}/v1/listings/${bookingListing.id}/publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  check('canal não certificado recusa publicação com 409', bookingPublish.status === 409, bookingPublish.status);

  console.log('\n▶ tarifas e disponibilidade');
  const days = [0, 1, 2, 3].map((offset) => ({
    date: addDays(start, offset + 20),
    rateCents: 45_000 + offset * 1_000,
    available: 1,
    minStay: 2,
  }));
  const ari = await call<{ daysWritten: number; events: number }>('PUT', `/v1/units/${unit.id}/ari`, { days });
  check('ARI gravado', ari.daysWritten === 4, ari);
  check('eventos enfileirados por anúncio publicado', ari.events >= 4, ari);

  const dispatch1 = await call<{ sent: number; dead: number }>('POST', '/v1/outbox/dispatch');
  check('dispatcher enviou eventos, nenhum dead-letter', dispatch1.dead === 0 && dispatch1.sent > 0, dispatch1);

  const snapshot = mock.snapshot(published1.externalId);
  check('canal mock recebeu tarifa do dia', Boolean(snapshot[days[0]!.date]), Object.keys(snapshot).slice(0, 3));

  console.log('\n▶ reserva vinda do canal');
  const reservation = await call<{ reservationId: string; created: boolean; tasksCreated: number; republished: number }>(
    'POST',
    '/v1/dev/mock/reservations',
    {
      connectionId: mockConn.id,
      externalListingId: published1.externalId,
      externalId: 'SMOKE-1001',
      checkin,
      checkout,
      guests: 4,
      totalCents: 135_000,
      commissionCents: 20_250,
    },
  );
  check('reserva ingerida', reservation.created === true, reservation);
  check('tarefas operacionais criadas', reservation.tasksCreated === 3, reservation);
  check('disponibilidade republicada nos outros canais', reservation.republished === 1, reservation);

  const replay = await call<{ created: boolean }>('POST', '/v1/dev/mock/reservations', {
    connectionId: mockConn.id,
    externalListingId: published1.externalId,
    externalId: 'SMOKE-1001',
    checkin,
    checkout,
    guests: 4,
  });
  check('reprocessar a mesma reserva não duplica', replay.created === false, replay);

  console.log('\n▶ disponibilidade derivada');
  const availability = await call<{ date: string; available: number; reserved: number }[]>(
    'GET',
    `/v1/units/${unit.id}/availability?from=${addDays(start, 20)}&to=${addDays(start, 25)}`,
  );
  const occupied = availability.filter((day) => day.available === 0);
  check('noites da reserva ficaram sem disponibilidade', occupied.length === 3, availability);

  await call('POST', '/v1/outbox/dispatch');
  const listing2Snapshot = mock.snapshot(
    (await call<{ externalId: string }>('POST', `/v1/listings/${listing2.id}/publish`)).externalId,
  );
  const syncedSoldOut = Object.values(listing2Snapshot).some((day) => (day as { available?: number }).available === 0);
  check('segundo canal recebeu bloqueio por disponibilidade', syncedSoldOut, listing2Snapshot);

  console.log('\n▶ operação e financeiro');
  const tasks = await call<{ type: string; status: string }[]>('GET', `/v1/tasks?orgId=${org.id}`);
  check('tarefas listadas para a operação', tasks.length === 3, tasks.map((t) => t.type));

  const detail = await call<{ ledger: { kind: string; amountCents: number }[]; netCents: number }>(
    'GET',
    `/v1/reservations/${reservation.reservationId}`,
  );
  check('lançamentos de receita e comissão', detail.ledger.length === 2, detail.ledger);
  check('líquido = total − comissão', detail.netCents === 135_000 - 20_250, detail.netCents);

  const summary = await call<{ grossCents: number; netCents: number; pendingTasks: number }>('GET', `/v1/summary?orgId=${org.id}`);
  check('resumo consolidado bate com a reserva', summary.grossCents === 135_000 && summary.netCents === 114_750, summary);

  const transition = await call<{ reservation: { status: string } }>('POST', `/v1/reservations/${reservation.reservationId}/status`, {
    status: 'checked_in',
  });
  check('transição para check-in aceita', transition.reservation.status === 'checked_in');

  const invalid = await fetch(`${base}/v1/reservations/${reservation.reservationId}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'pending' }),
  });
  check('transição inválida recusada', invalid.status === 400, invalid.status);

  console.log('\n▶ autenticação e RBAC');
  const unauthorized = await fetch(`${base}/v1/summary`);
  check('sem token responde 401', unauthorized.status === 401, unauthorized.status);

  const viewer = await call<{ token: string }>('POST', '/v1/tokens', { userName: 'Leitor', role: 'viewer' });
  const viewerWrite = await fetch(`${base}/v1/units/${unit.id}/ari`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${viewer.token}` },
    body: JSON.stringify({ days: [{ date: addDays(start, 90), rateCents: 1 }] }),
  });
  check('viewer não escreve ARI (403)', viewerWrite.status === 403, viewerWrite.status);

  const viewerRead = await fetch(`${base}/v1/reservations`, { headers: { authorization: `Bearer ${viewer.token}` } });
  check('viewer lê reservas (200)', viewerRead.status === 200, viewerRead.status);

  const otherOrg = await call<{ organization: { id: string }; token: string }>(
    'POST',
    '/v1/bootstrap',
    { orgName: 'Outra Org', userName: 'Outro' },
    { 'x-bootstrap-key': BOOTSTRAP },
  );
  const crossTenant = await fetch(`${base}/v1/units/${unit.id}/availability?from=${addDays(start, 1)}&to=${addDays(start, 3)}`, {
    headers: { authorization: `Bearer ${otherOrg.token}` },
  });
  check('token de outra organização não vê a unidade (404)', crossTenant.status === 404, crossTenant.status);

  const tokens = await call<{ id: string; role: string }[]>('GET', '/v1/tokens');
  const viewerToken = tokens.find((t) => t.role === 'viewer');
  if (viewerToken) {
    await call('DELETE', `/v1/tokens/${viewerToken.id}`);
    const afterRevoke = await fetch(`${base}/v1/reservations`, { headers: { authorization: `Bearer ${viewer.token}` } });
    check('token revogado deixa de autenticar (401)', afterRevoke.status === 401, afterRevoke.status);
  }
} catch (error) {
  failures.push(String(error));
  console.error('\nerro no smoke:', error);
} finally {
  await app.close();
  db.close();
}

console.log(`\n${checks - failures.length}/${checks} verificações ok`);
if (failures.length) {
  console.error('falhas:', failures);
  process.exit(1);
}
console.log('smoke completo ✔');
