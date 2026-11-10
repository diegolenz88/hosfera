import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildICal, parseICal, unfold } from '../../src/domain/ical.ts';

const wrap = (body: string): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;

test('evento de dia inteiro vira uma faixa de noites', () => {
  const feed = wrap(
    [
      'BEGIN:VEVENT',
      'UID:abc-123@airbnb.com',
      'DTSTART;VALUE=DATE:20261220',
      'DTEND;VALUE=DATE:20261223',
      'SUMMARY:Reserved',
      'END:VEVENT',
      '',
    ].join('\r\n'),
  );
  const [event] = parseICal(feed);
  assert.equal(event?.uid, 'abc-123@airbnb.com');
  assert.equal(event?.start, '2026-12-20');
  assert.equal(event?.end, '2026-12-23', 'DTEND é exclusivo: 3 noites');
  assert.equal(event?.cancelled, false);
});

test('evento com hora usa a data local, não o instante UTC', () => {
  const feed = wrap(
    [
      'BEGIN:VEVENT',
      'UID:timed@booking.com',
      'DTSTART;TZID=America/Sao_Paulo:20270105T150000',
      'DTEND;TZID=America/Sao_Paulo:20270108T110000',
      'SUMMARY:Reserva paga',
      'END:VEVENT',
      '',
    ].join('\r\n'),
  );
  const [event] = parseICal(feed);
  assert.equal(event?.start, '2027-01-05');
  assert.equal(event?.end, '2027-01-08');
});

test('sem DTEND o evento ocupa uma noite; DTEND igual ao início idem', () => {
  const semFim = wrap(['BEGIN:VEVENT', 'UID:s1', 'DTSTART;VALUE=DATE:20270110', 'END:VEVENT', ''].join('\r\n'));
  assert.equal(parseICal(semFim)[0]?.end, '2027-01-11');

  const mesmoDia = wrap(
    ['BEGIN:VEVENT', 'UID:s2', 'DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270110', 'END:VEVENT', ''].join(
      '\r\n',
    ),
  );
  assert.equal(parseICal(mesmoDia)[0]?.end, '2027-01-11');
});

test('linha dobrada do RFC 5545 é remontada', () => {
  const feed = wrap(
    [
      'BEGIN:VEVENT',
      'UID:fold@teste',
      'DTSTART;VALUE=DATE:20270201',
      'DTEND;VALUE=DATE:20270202',
      'SUMMARY:Reserva de um grupo grande que precisa de uma descrição bem longa para',
      '  dobrar a linha',
      'END:VEVENT',
      '',
    ].join('\r\n'),
  );
  const [event] = parseICal(feed);
  assert.match(event?.summary ?? '', /grupo grande.*dobrar a linha/);
});

test('evento cancelado é marcado, não descartado silenciosamente', () => {
  const feed = wrap(
    ['BEGIN:VEVENT', 'UID:c1', 'DTSTART;VALUE=DATE:20270301', 'STATUS:CANCELLED', 'END:VEVENT', ''].join('\r\n'),
  );
  assert.equal(parseICal(feed)[0]?.cancelled, true);
});

test('data inválida é ignorada em vez de virar bloqueio errado', () => {
  const feed = wrap(['BEGIN:VEVENT', 'UID:bad', 'DTSTART;VALUE=DATE:20270231', 'END:VEVENT', ''].join('\r\n'));
  assert.equal(parseICal(feed).length, 0);
});

test('feed gerado tem CRLF, DTEND exclusivo e UID estável', () => {
  const body = buildICal({
    calendarName: 'Suíte Aurora — hosfera',
    events: [{ uid: 'block-1@hosfera', start: '2026-12-20', end: '2026-12-23', summary: 'Indisponível' }],
    now: new Date('2026-11-10T12:00:00Z'),
  });
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(body.includes('DTSTART;VALUE=DATE:20261220'));
  assert.ok(body.includes('DTEND;VALUE=DATE:20261223'));
  assert.ok(body.includes('DTSTAMP:20261110T120000Z'));
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  // ida e volta: o que sai daqui é lido de volta igual
  const [parsed] = parseICal(body);
  assert.deepEqual(
    { start: parsed?.start, end: parsed?.end, uid: parsed?.uid },
    { start: '2026-12-20', end: '2026-12-23', uid: 'block-1@hosfera' },
  );
});

test('texto com vírgula e acento é escapado e sobrevive à volta', () => {
  const body = buildICal({
    calendarName: 'Casa, Suíte Ação',
    events: [{ uid: 'x@h', start: '2026-12-24', end: '2026-12-26', summary: 'Indisponível, manutenção' }],
  });
  assert.ok(body.includes('Casa\\, Suíte Ação'));
  assert.equal(parseICal(body)[0]?.summary, 'Indisponível, manutenção');
});

test('linhas longas são dobradas em 75 octetos sem quebrar acento', () => {
  const summary = 'Reserva '.repeat(20);
  const body = buildICal({ calendarName: 'x', events: [{ uid: 'y@h', start: '2026-12-01', end: '2026-12-02', summary }] });
  for (const line of body.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `linha com ${Buffer.byteLength(line, 'utf8')} octetos`);
  }
  assert.equal(parseICal(body)[0]?.summary?.trim(), summary.trim());
});

test('unfold remove continuação mas preserva conteúdo', () => {
  assert.deepEqual(unfold('SUMMARY:abc\r\n def\r\nEND:VEVENT'), ['SUMMARY:abcdef', 'END:VEVENT']);
});
