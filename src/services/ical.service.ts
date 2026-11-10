import type { Db } from '../db/database.ts';
import {
  createBlock,
  createIcalSource,
  deleteBlock,
  deleteIcalSource,
  ensureUnitFeedToken,
  getIcalSource,
  getUnit,
  listBlocks,
  listBlocksBySource,
  listReservationsByUnit,
  updateBlockDates,
  updateIcalSourceSync,
} from '../db/repositories.ts';
import { buildICal, parseICal } from '../domain/ical.ts';
import type { ICalSource } from '../domain/types.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

/**
 * Sincronização de calendário por iCal.
 *
 * É a integração de menor complexidade e a única que funciona hoje sem programa
 * de parceiro: os canais publicam um .ics por anúncio. Duas direções:
 *  - importação: reserva feita no canal vira bloqueio aqui (evita overbooking);
 *  - exportação: nossa agenda vira .ics para o canal assinar.
 *
 * O bloqueio importado não é reserva: não tem hóspede, valor nem comissão. Ele
 * existe para fechar a noite. Tratar como reserva poluiria financeiro e repasse.
 */

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const sourceKey = (sourceId: string): string => `ical:${sourceId}`;

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  removed: number;
}

/**
 * Aplica um feed sobre os bloqueios da fonte.
 *
 * Idempotente por UID: reimportar o mesmo feed não duplica nada, e reserva
 * cancelada no canal desaparece daqui — que é o efeito que o operador espera.
 */
export function importFeedText(
  db: Db,
  input: { unitId: string; sourceId: string; text: string },
): ImportResult {
  const unit = getUnit(db, input.unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);

  const events = parseICal(input.text).filter((event) => !event.cancelled);
  const key = sourceKey(input.sourceId);
  const existing = listBlocksBySource(db, input.unitId, key);
  const byUid = new Map(existing.map((block) => [block.externalUid ?? '', block]));

  let created = 0;
  let updated = 0;
  const seen = new Set<string>();

  db.exec('BEGIN');
  try {
    for (const event of events) {
      seen.add(event.uid);
      const summary = event.summary ? `iCal: ${event.summary}` : 'iCal: ocupado';
      const current = byUid.get(event.uid);
      if (current) {
        if (current.startDate !== event.start || current.endDate !== event.end) {
          updateBlockDates(db, current.id, { startDate: event.start, endDate: event.end, reason: summary });
          updated++;
        }
      } else {
        createBlock(db, {
          unitId: input.unitId,
          startDate: event.start,
          endDate: event.end,
          reason: summary,
          source: key,
          externalUid: event.uid,
        });
        created++;
      }
    }

    let removed = 0;
    for (const block of existing) {
      if (block.externalUid && !seen.has(block.externalUid)) {
        deleteBlock(db, block.id);
        removed++;
      }
    }

    db.exec('COMMIT');
    return { total: events.length, created, updated, removed };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function addIcalSource(
  db: Db,
  input: { orgId: string; unitId: string; url: string; label?: string | null },
): ICalSource {
  const unit = getUnit(db, input.unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${input.unitId}`);
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new ValidationError('URL do feed inválida');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError('o feed precisa ser http ou https');
  }
  return createIcalSource(db, {
    orgId: input.orgId,
    unitId: input.unitId,
    url: parsed.toString(),
    label: input.label?.trim() || parsed.hostname,
  });
}

export interface SyncOutcome {
  source: ICalSource;
  status: 'ok' | 'error';
  message: string | null;
  imported: ImportResult | null;
}

/**
 * Baixa e aplica o feed.
 *
 * Falha de rede não derruba o bloqueio existente: a agenda continua fechada com
 * o que já se sabia, e o erro fica registrado na fonte (o operador vê na tela).
 */
export async function syncIcalSource(
  db: Db,
  sourceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const source = getIcalSource(db, sourceId);
  if (!source) throw new NotFoundError(`fonte iCal não encontrada: ${sourceId}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(source.url, {
      signal: controller.signal,
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8' },
    });
    if (!response.ok) {
      const message = `feed respondeu ${response.status}`;
      updateIcalSourceSync(db, sourceId, { status: 'error', error: message });
      return { source, status: 'error', message, imported: null };
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_FEED_BYTES) {
      const message = 'feed maior que 2 MB — recusado';
      updateIcalSourceSync(db, sourceId, { status: 'error', error: message });
      return { source, status: 'error', message, imported: null };
    }

    const imported = importFeedText(db, { unitId: source.unitId, sourceId, text });
    updateIcalSourceSync(db, sourceId, { status: 'ok', error: null });
    return {
      source,
      status: 'ok',
      message: `${imported.total} evento(s): ${imported.created} novo(s), ${imported.updated} atualizado(s), ${imported.removed} removido(s)`,
      imported,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'falha ao buscar o feed';
    updateIcalSourceSync(db, sourceId, { status: 'error', error: message });
    return { source, status: 'error', message, imported: null };
  } finally {
    clearTimeout(timer);
  }
}

export function removeIcalSource(db: Db, sourceId: string): { removedBlocks: number } {
  const source = getIcalSource(db, sourceId);
  if (!source) throw new NotFoundError(`fonte iCal não encontrada: ${sourceId}`);
  const blocks = listBlocksBySource(db, source.unitId, sourceKey(sourceId));
  db.exec('BEGIN');
  try {
    for (const block of blocks) deleteBlock(db, block.id);
    deleteIcalSource(db, sourceId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { removedBlocks: blocks.length };
}

export function feedTokenFor(db: Db, unitId: string): string {
  const unit = getUnit(db, unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${unitId}`);
  return ensureUnitFeedToken(db, unitId);
}

/**
 * Agenda pública de uma unidade: reservas ativas + bloqueios manuais.
 *
 * Bloqueio vindo de iCal fica de fora — devolvê-lo ao feed de origem criaria eco
 * e, com dois canais, um loop de bloqueios.
 */
export function exportUnitFeed(db: Db, unitId: string): { body: string; calendarName: string } {
  const unit = getUnit(db, unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${unitId}`);

  const horizonStart = new Date();
  horizonStart.setUTCDate(horizonStart.getUTCDate() - 30);
  const from = horizonStart.toISOString().slice(0, 10);
  const horizonEnd = new Date();
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 730);
  const to = horizonEnd.toISOString().slice(0, 10);

  const events = [
    ...listReservationsByUnit(db, unitId, from, to)
      .filter((reservation) => ['pending', 'confirmed', 'checked_in'].includes(reservation.status))
      .map((reservation) => ({
        uid: `reservation-${reservation.id}@hosfera`,
        start: reservation.checkin,
        end: reservation.checkout,
        summary: 'Reservado',
      })),
    ...listBlocks(db, unitId, from, to)
      .filter((block) => block.source === 'manual')
      .map((block) => ({
        uid: `block-${block.id}@hosfera`,
        start: block.startDate,
        end: block.endDate,
        summary: block.reason ? `Indisponível: ${block.reason}` : 'Indisponível',
      })),
  ];

  return { body: buildICal({ calendarName: `${unit.name} — hosfera`, events }), calendarName: unit.name };
}
