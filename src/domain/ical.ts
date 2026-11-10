import type { DateString } from './types.ts';

/**
 * iCal (RFC 5545) — o mínimo que um feed de canal usa.
 *
 * Escopo deliberado: datas (não horas), sem recorrência. Airbnb, Booking, Vrbo e
 * Google exportam eventos de dia inteiro por anúncio; RRULE não aparece nesses
 * feeds. Implementar recorrência aqui seria código sem uso.
 */

export interface ICalEvent {
  uid: string;
  /** Primeira noite ocupada. */
  start: DateString;
  /** Primeira noite livre (fim exclusivo, como no resto do domínio). */
  end: DateString;
  summary: string | null;
  cancelled: boolean;
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})/;
const PROP_RE = /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/;

/** Desfaz a dobra de linha do RFC 5545 (continuação começa com espaço ou tab). */
export function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** `20261220` ou `20261220T150000` ou `20261220T150000Z` → `2026-12-20`. */
function toDateString(value: string): DateString | null {
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  // Valida calendário de verdade: 20260231 não pode virar 2026-02-31.
  const probe = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) return null;
  return date;
}

function addDays(date: DateString, days: number): DateString {
  const probe = new Date(`${date}T00:00:00Z`);
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}

/**
 * Lê um feed e devolve os eventos ocupantes.
 *
 * Evento sem `DTEND` vira uma noite; `DTEND` igual ou anterior ao início também —
 * é o que os canais fazem com reserva de uma diária.
 */
export function parseICal(text: string): ICalEvent[] {
  const lines = unfold(text);
  const events: ICalEvent[] = [];
  let current: Record<string, string> | null = null;
  let inEvent = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.toUpperCase() === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line.toUpperCase() === 'END:VEVENT') {
      if (inEvent && current) {
        const event = buildEvent(current);
        if (event) events.push(event);
      }
      inEvent = false;
      current = null;
      continue;
    }
    if (!inEvent || !current) continue;

    const match = PROP_RE.exec(line);
    if (!match) continue;
    const [, name, , value] = match;
    if (!name) continue;
    current[name.toUpperCase()] = value ?? '';
  }

  return events;
}

function buildEvent(props: Record<string, string>): ICalEvent | null {
  const start = props.DTSTART ? toDateString(props.DTSTART) : null;
  if (!start) return null;

  const rawEnd = props.DTEND ? toDateString(props.DTEND) : null;
  // Fim exclusivo: sem DTEND, ou DTEND no mesmo dia, o evento cobre uma noite.
  const end = !rawEnd || rawEnd <= start ? addDays(start, 1) : rawEnd;

  const status = (props.STATUS ?? '').toUpperCase();
  const summary = props.SUMMARY ? unescapeText(props.SUMMARY) : null;
  const uid = props.UID?.trim() || `${start}/${end}/${summary ?? 'evento'}`;

  return {
    uid,
    start,
    end,
    summary,
    cancelled: status === 'CANCELLED' || (props.METHOD ?? '').toUpperCase() === 'CANCEL',
  };
}

export interface FeedEvent {
  uid: string;
  start: DateString;
  end: DateString;
  summary: string;
}

/** Dobra em 75 octetos, respeitando UTF-8 (não corta acento no meio). */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // continuação gasta 1 com o espaço
    if (currentBytes + size > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

function stamp(iso: string): string {
  return `${iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

/** Gera o feed que o canal assina. `DTEND` é exclusivo, como no domínio. */
export function buildICal(options: { calendarName: string; events: FeedEvent[]; now?: Date }): string {
  const now = options.now ?? new Date();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//hosfera//PMS//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
  ];

  for (const event of options.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp(now.toISOString())}`,
      `DTSTART;VALUE=DATE:${event.start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${event.end.replace(/-/g, '')}`,
      `SUMMARY:${escapeText(event.summary)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
