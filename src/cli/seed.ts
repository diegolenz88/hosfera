/**
 * Semeia um cenário mínimo de desenvolvimento:
 * 1 organização, 1 casa com 2 unidades, tarifas, conexão mock + Booking (pendente),
 * anúncios publicados e calendário de 60 dias.
 *
 * Idempotente por nome de organização: rodar duas vezes não duplica o cenário.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { config } from '../config.ts';
import { AdapterRegistry } from '../connectivity/registry.ts';
import {
  createConnection,
  createListing,
  createOrganization,
  createProperty,
  createRatePlan,
  createUnit,
  listConnections,
  listProperties,
} from '../db/repositories.ts';
import { publishListing } from '../services/publishing.service.ts';
import { setAri } from '../services/ari.service.ts';
import { Dispatcher } from '../services/dispatcher.service.ts';
import { createToken, listTokens } from '../auth/tokens.ts';
import { addDays, todayUtc } from '../domain/dates.ts';

const ORG_NAME = 'Administradora Demo';
const PROPERTY_NAME = 'Casa Praia do Forte';

const db = openDatabase(config.databasePath);
const registry = AdapterRegistry.withDefaults({ enableMock: config.enableMockChannel });

const orgRow = db.prepare('SELECT * FROM organizations WHERE name = ?').get(ORG_NAME) as
  | Record<string, unknown>
  | undefined;

const org = orgRow ? { id: String(orgRow.id), name: String(orgRow.name) } : createOrganization(db, ORG_NAME);
// Token de `owner` para a operação local. Só é impresso na criação.
const existingToken = listTokens(db, org.id).find((t) => t.label === 'seed' && !t.revokedAt);
const issued = existingToken ? null : createToken(db, { orgId: org.id, userName: 'Operador Demo', role: 'owner', label: 'seed' });

if (orgRow) {
  console.log('cenário já existente, reutilizando organização', org.id);
} else {
  console.log('organização criada', org.id);
}

const property =
  (listProperties(db, org.id).find((p) => p.name === PROPERTY_NAME)) ??
  createProperty(db, {
    orgId: org.id,
    name: PROPERTY_NAME,
    city: 'Mata de São João',
    state: 'BA',
    address: 'Rua das Palmeiras, 120',
  });

const units = db.prepare('SELECT * FROM units WHERE property_id = ?').all(property.id) as Record<string, unknown>[];
const ensureUnit = (name: string, inventory: number) => {
  const found = units.find((u) => String(u.name) === name);
  if (found) return { id: String(found.id), name };
  const created = createUnit(db, { propertyId: property.id, name, inventory, minStay: 2 });
  units.push({ id: created.id, name: created.name });
  return { id: created.id, name: created.name };
};

const suite = ensureUnit('Suíte Aurora', 1);
const loft = ensureUnit('Loft Maré', 2);

for (const unit of [suite, loft]) {
  const plans = db.prepare('SELECT COUNT(*) AS total FROM rate_plans WHERE unit_id = ?').get(unit.id) as { total: number };
  if (Number(plans.total) === 0) {
    createRatePlan(db, {
      unitId: unit.id,
      name: 'Tarifa flexível',
      basePriceCents: unit.name === 'Suíte Aurora' ? 48_000 : 32_000,
      weekendUpliftPct: 25,
      cleaningFeeCents: 15_000,
      minStay: 2,
    });
    console.log('rate plan criado para', unit.name);
  }
}

const connections = listConnections(db, org.id);
const ensureConnection = (channel: 'mock' | 'booking', label: string, status: 'active' | 'pending') => {
  const found = connections.find((c) => c.channel === channel && c.label === label);
  if (found) return found;
  const created = createConnection(db, { orgId: org.id, channel, label, status });
  connections.push(created);
  return created;
};

const mockConnection = ensureConnection('mock', 'Canal de desenvolvimento', 'active');
const bookingConnection = ensureConnection('booking', 'Booking.com (pendente)', 'pending');

const listings = db.prepare('SELECT * FROM listings WHERE unit_id IN (?, ?)').all(suite.id, loft.id) as Record<string, unknown>[];
const ensureListing = (unitId: string, connectionId: string) => {
  const found = listings.find((l) => String(l.unit_id) === unitId && String(l.connection_id) === connectionId);
  if (found) return { id: String(found.id), status: String(found.status), externalId: found.external_id ? String(found.external_id) : null };
  const created = createListing(db, { unitId, connectionId });
  listings.push({ id: created.id, unit_id: unitId, connection_id: connectionId, status: created.status, external_id: null });
  return { id: created.id, status: created.status, externalId: null };
};

const listingSuite = ensureListing(suite.id, mockConnection.id);
const bookingListing = ensureListing(suite.id, bookingConnection.id);
ensureListing(loft.id, mockConnection.id);

// Calendário de 60 dias com preço de alta temporada no fim de ano.
const start = todayUtc();
const days = Array.from({ length: 60 }, (_, i) => {
  const date = addDays(start, i + 1);
  const highSeason = date >= `${start.slice(0, 4)}-12-20` && date <= `${start.slice(0, 4)}-12-31`;
  return {
    date,
    rateCents: highSeason ? 92_000 : undefined,
    available: undefined,
    minStay: undefined,
    closed: false,
  };
});
setAri(db, { unitId: suite.id, days });
setAri(db, { unitId: loft.id, days });

if (listingSuite.status !== 'published') {
  const published = await publishListing(db, registry, listingSuite.id);
  console.log('anúncio publicado no canal mock:', published.externalId, `(${published.daysSynced} dias)`);
}
void bookingListing;

const dispatcher = new Dispatcher(db, registry, { maxAttempts: 6, baseBackoffMs: 500 });
const report = await dispatcher.runOnce();
console.log('outbox processado:', report);

const unitCount = db.prepare('SELECT COUNT(*) AS total FROM units WHERE property_id = ?').get(property.id) as { total: number };
const listingCount = db.prepare('SELECT COUNT(*) AS total FROM listings WHERE unit_id IN (?, ?)').get(suite.id, loft.id) as {
  total: number;
};

console.log('\n── cenário pronto ──');
console.log('orgId      ', org.id);
console.log('propertyId ', property.id);
console.log('unidades   ', Number(unitCount.total), '· anúncios', Number(listingCount.total));
console.log('conexões   ', connections.map((c) => `${c.channel}:${c.status}`).join(', '));
console.log('unidade1   ', suite.id, '(Suíte Aurora)');
console.log('unidade2   ', loft.id, '(Loft Maré)');
if (issued) {
  // Arquivo local para o smoke visual e para o navegador (nunca versionado).
  writeFileSync(join(config.databasePath, '..', '.dev-token'), issued.token, { mode: 0o600 });
  console.log('\n── token de acesso (aparece uma única vez) ──');
  console.log(issued.token);
  console.log('no navegador: abra http://127.0.0.1:' + config.port + ' e cole o token acima.');
} else {
  console.log('\ntoken já emitido anteriormente (label "seed"). Gere outro com POST /v1/tokens.');
}
console.log('\nuse `npm run smoke` para exercitar a API de ponta a ponta.');
db.close();
