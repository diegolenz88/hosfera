/**
 * Mensagens OTA 2003B usadas na integração com Booking.com.
 *
 * Escopo implementado (o que a operação precisa para vender e receber reserva):
 *   OTA_HotelAvailNotifRQ      → disponibilidade, bloqueio e mínimo de noites
 *   OTA_HotelRateAmountNotifRQ → tarifas por tipo de quarto e plano
 *   OTA_PingRQ                 → health check
 *   OTA_HotelResNotifRQ        → reserva recebida (parse)
 *   OTA_HotelResNotifRS        → confirmação devolvida ao canal (ack)
 *   OTA_CancelRQ               → cancelamento iniciado pelo hotel
 *
 * Fora de escopo por ora: conteúdo/fotos (Content API), mensagens (Messaging),
 * pagamentos (Payments by Booking) e promoções.
 */
import {
  amountToCents,
  asArray,
  attr,
  attrs,
  centsToAmount,
  escapeXml,
  node,
  otaRoot,
  parseXml,
  posBlock,
  text,
  type XmlNode,
} from './xml.ts';
import { normalizeStatus } from '../../../domain/reservation.ts';
import type { DateString } from '../../../domain/types.ts';

// ───────────────────────────── disponibilidade ─────────────────────────────

export interface AvailabilityMessageDay {
  date: DateString;
  /** Quantidade vendável (= inventário disponível naquele dia). */
  available: number;
  closed: boolean;
  minStay: number;
}

export interface AvailabilityMessageInput {
  hotelCode: string;
  roomCode: string;
  ratePlanCode: string;
  days: AvailabilityMessageDay[];
  echoToken: string;
  timestamp: string;
  machineAccount: string;
}

/** Agrupa dias consecutivos com a mesma disponibilidade/restrição em um range. */
export function groupConsecutive<T extends { date: string; available: number; closed: boolean; minStay: number }>(
  days: T[],
): T[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const groups: T[] = [];
  let cursor: string | null = null; // último dia já coberto por um grupo

  for (const day of sorted) {
    const last = groups[groups.length - 1];
    const contiguous = cursor !== null && nextDate(cursor) === day.date;
    const sameValues =
      last !== undefined && last.available === day.available && last.closed === day.closed && last.minStay === day.minStay;
    if (!last || !contiguous || !sameValues) groups.push({ ...day });
    cursor = day.date;
  }
  return groups;
}

export function buildAvailabilityNotif(input: AvailabilityMessageInput): string {
  if (input.days.length === 0) throw new Error('availability: nenhum dia informado');
  const groups = groupConsecutive(input.days);

  const messages = groups
    .map((group) => {
      const end = lastDateOfRange(input.days, group);
      const control = attrs({
        Start: group.date,
        End: end,
        InvTypeCode: input.roomCode,
        RatePlanCode: undefined, // disponibilidade é por tipo de quarto
        Mon: 'true', Tue: 'true', Wed: 'true', Thu: 'true', Fri: 'true', Sat: 'true', Sun: 'true',
      });
      const los =
        group.minStay > 1
          ? `
        <LengthsOfStay>
          <LengthOfStay ${attrs({ Time: group.minStay, TimeUnit: 'Day', MinMaxMessageType: 'SetMinLOS' })}/>
        </LengthsOfStay>`
          : '';
      return `    <AvailStatusMessage ${attrs({ BookingLimit: group.closed ? 0 : group.available })}>
      <StatusApplicationControl ${control}/>${los}
      <RestrictionStatus ${attrs({ Status: group.closed ? 'Close' : 'Open' })}/>
    </AvailStatusMessage>`;
    })
    .join('\n');

  const inner = `${posBlock(input.machineAccount)}
  <AvailStatusMessages ${attrs({ HotelCode: input.hotelCode })}>
${messages}
  </AvailStatusMessages>`;
  return otaRoot('OTA_HotelAvailNotifRQ', input.echoToken, input.timestamp, inner);
}

/** Último dia contíguo do grupo (o range do OTA é inclusivo). */
function lastDateOfRange(days: AvailabilityMessageDay[], group: AvailabilityMessageDay): DateString {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const startIndex = sorted.findIndex((day) => day.date === group.date);
  let end = group.date;
  for (let i = startIndex + 1; i < sorted.length; i++) {
    const day = sorted[i];
    if (!day) break;
    if (day.date !== nextDate(end)) break;
    if (day.available !== group.available || day.closed !== group.closed || day.minStay !== group.minStay) break;
    end = day.date;
  }
  return end;
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────── tarifas ─────────────────────────────

export interface RateMessageDay {
  date: DateString;
  rateCents: number;
}

export interface RateMessageInput {
  hotelCode: string;
  roomCode: string;
  ratePlanCode: string;
  currency: string;
  days: RateMessageDay[];
  /** Ocupação base do preço (Booking exige NumberOfGuests). */
  guests?: number;
  echoToken: string;
  timestamp: string;
  machineAccount: string;
}

export function buildRateAmountNotif(input: RateMessageInput): string {
  if (input.days.length === 0) throw new Error('rates: nenhum dia informado');
  const guests = input.guests ?? 1;

  const messages = [...input.days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const amount = centsToAmount(day.rateCents);
      return `    <RateAmountMessage>
      <StatusApplicationControl ${attrs({
        Start: day.date,
        End: day.date,
        InvTypeCode: input.roomCode,
        RatePlanCode: input.ratePlanCode,
      })}/>
      <Rates>
        <Rate>
          <BaseByGuestAmts>
            <BaseByGuestAmt ${attrs({
              AmountAfterTax: amount,
              AmountBeforeTax: amount,
              CurrencyCode: input.currency,
              NumberOfGuests: guests,
              AgeQualifyingCode: '10',
            })}/>
          </BaseByGuestAmts>
        </Rate>
      </Rates>
    </RateAmountMessage>`;
    })
    .join('\n');

  const inner = `${posBlock(input.machineAccount)}
  <RateAmountMessages ${attrs({ HotelCode: input.hotelCode })}>
${messages}
  </RateAmountMessages>`;
  return otaRoot('OTA_HotelRateAmountNotifRQ', input.echoToken, input.timestamp, inner);
}

// ───────────────────────────── ping ─────────────────────────────

export function buildPing(machineAccount: string, echoToken: string, timestamp: string): string {
  return otaRoot('OTA_PingRQ', echoToken, timestamp, `${posBlock(machineAccount)}\n  <EchoData>ping</EchoData>`);
}

// ───────────────────────────── cancelamento (hotel → canal) ─────────────────────────────

export function buildCancelRequest(input: {
  machineAccount: string;
  reservationId: string;
  hotelCode: string;
  echoToken: string;
  timestamp: string;
  reason?: string;
}): string {
  const inner = `${posBlock(input.machineAccount)}
  <UniqueID ${attrs({ Type: '14', ID: input.reservationId })}/>
  <HotelReservations>
    <HotelReservation ${attrs({ ResStatus: 'Cancelled' })}>
      <UniqueID ${attrs({ Type: '14', ID: input.reservationId })}/>
      <BasicPropertyInfo ${attrs({ HotelCode: input.hotelCode })}/>
      ${input.reason ? `<Comments><Comment>${escapeXml(input.reason)}</Comment></Comments>` : ''}
    </HotelReservation>
  </HotelReservations>`;
  return otaRoot('OTA_CancelRQ', input.echoToken, input.timestamp, inner);
}

// ───────────────────────────── reserva recebida ─────────────────────────────

export interface ParsedReservation {
  reservationId: string;
  hotelCode: string;
  roomCode: string;
  ratePlanCode: string;
  checkin: DateString;
  checkout: DateString;
  guests: number;
  guestName: string | null;
  guestEmail: string | null;
  status: 'confirmed' | 'cancelled' | 'pending' | 'no_show' | 'checked_in' | 'checked_out';
  totalCents: number | null;
  commissionCents: number | null;
  currency: string;
}

export class BookingMessageError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_message') {
    super(message);
    this.name = 'BookingMessageError';
    this.code = code;
  }
}

/** Lê OTA_HotelResNotifRQ e devolve a reserva canônica. */
export function parseReservationNotification(xml: string): ParsedReservation {
  const doc = parseXml(xml);
  const root = node(doc.OTA_HotelResNotifRQ);
  if (!root) throw new BookingMessageError('raiz OTA_HotelResNotifRQ ausente');

  const hotelReservations = node(root.HotelReservations);
  const reservation = asArray(hotelReservations?.HotelReservation)
    .map((item) => node(item))
    .find((item): item is XmlNode => item !== null);
  if (!reservation) throw new BookingMessageError('HotelReservation ausente');

  const uniqueIdNode = reservation.UniqueID;
  const reservationId = attr(uniqueIdNode, 'ID');
  if (!reservationId) throw new BookingMessageError('UniqueID Type=14 (id da reserva) ausente');

  const roomStay = asArray(node(reservation.RoomStays)?.RoomStay)
    .map((item) => node(item))
    .find((item): item is XmlNode => item !== null);
  if (!roomStay) throw new BookingMessageError('RoomStay ausente');

  const roomType = asArray(node(roomStay.RoomTypes)?.RoomType).map((item) => node(item))[0];
  const ratePlan = asArray(node(roomStay.RatePlans)?.RatePlan).map((item) => node(item))[0];
  const timeSpan = node(roomStay.TimeSpan);
  const checkin = attr(timeSpan, 'Start');
  const checkout = attr(timeSpan, 'End');
  if (!checkin || !checkout) throw new BookingMessageError('TimeSpan Start/End ausente');

  const guests = asArray(node(roomStay.GuestCounts)?.GuestCount)
    .map((item) => Number(attr(item, 'Count') ?? 0))
    .reduce((sum, count) => sum + count, 0);

  const total = node(roomStay.Total);
  const totalCents = amountToCents(attr(total, 'AmountAfterTax'));
  const currency = attr(total, 'CurrencyCode') ?? 'BRL';

  const customer = findCustomer(reservation);
  const personName = node(customer?.PersonName);
  const given = text(personName?.GivenName);
  const surname = text(personName?.Surname);
  const guestName = [given, surname].filter(Boolean).join(' ') || null;

  const resStatus = attr(reservation, 'ResStatus') ?? 'Commit';
  return {
    reservationId,
    hotelCode: attr(roomStay.BasicPropertyInfo, 'HotelCode') ?? attr(node(root.HotelReservations), 'HotelCode') ?? '',
    roomCode: attr(roomType, 'RoomTypeCode') ?? attr(roomType, 'InvTypeCode') ?? '',
    ratePlanCode: attr(ratePlan, 'RatePlanCode') ?? '',
    checkin,
    checkout,
    guests: guests || 1,
    guestName,
    guestEmail: customer ? readEmail(customer) : null,
    status: normalizeStatus('booking', resStatus),
    totalCents,
    commissionCents: readCommission(reservation),
    currency,
  };
}

function findCustomer(reservation: XmlNode): XmlNode | null {
  const guests = asArray(node(reservation.ResGuests)?.ResGuest).map((item) => node(item));
  for (const guest of guests) {
    if (!guest) continue;
    const profiles = asArray(node(guest.Profiles)?.ProfileInfo).map((item) => node(item));
    for (const profileInfo of profiles) {
      const customer = node(node(profileInfo?.Profile)?.Customer);
      if (customer) return customer;
    }
  }
  return null;
}

function readEmail(customer: XmlNode): string | null {
  const direct = text(customer.Email);
  if (direct) return direct;
  const emails = asArray(customer.Email);
  for (const item of emails) {
    const value = text(item);
    if (value) return value;
  }
  return null;
}

/** Comissão pode vir em Commission/CommissionPayableAmount ou em AmountPercent. */
function readCommission(reservation: XmlNode): number | null {
  const roomStay = asArray(node(reservation.RoomStays)?.RoomStay).map((item) => node(item))[0];
  const commission = node(roomStay?.Commission);
  if (!commission) return null;
  const payable = node(commission.CommissionPayableAmount);
  const amount = amountToCents(attr(payable, 'AmountAfterTax') ?? text(payable));
  if (amount !== null) return amount;
  const percent = Number(attr(commission.AmountPercent, 'Percent') ?? NaN);
  const total = amountToCents(attr(node(roomStay?.Total), 'AmountAfterTax'));
  if (Number.isFinite(percent) && total !== null) return Math.round((total * percent) / 100);
  return null;
}

// ───────────────────────────── respostas ─────────────────────────────

export interface ParsedAck {
  ok: boolean;
  errors: { code: string; type: string; message: string; retryable: boolean }[];
}

/** Lê o RS de qualquer mensagem enviada e classifica erros. */
export function parseAck(xml: string): ParsedAck {
  const doc = parseXml(xml);
  const rootKey = Object.keys(doc).find((key) => key.startsWith('OTA_'));
  const root = rootKey ? node(doc[rootKey]) : null;
  const errorsNode = node(root?.Errors);
  const errors = asArray(errorsNode?.Error)
    .map((item) => node(item))
    .filter((item): item is XmlNode => item !== null)
    .map((item) => {
      const type = attr(item, 'Type') ?? '0';
      // Type 3 = erro de negócio (payload inválido): repetir não resolve.
      return {
        code: attr(item, 'Code') ?? 'unknown',
        type,
        message: text(item) ?? 'erro sem descrição',
        retryable: type !== '3',
      };
    });
  const success = node(root?.Success);
  return { ok: errors.length === 0 || success !== null, errors };
}

/** Resposta OTA que o Booking espera ao entregar uma reserva. */
export function buildReservationAck(input: {
  reservationId: string;
  hotelCode: string;
  echoToken: string;
  timestamp: string | null;
}): string {
  const inner = `  <Success/>
  <HotelReservations>
    <HotelReservation ${attrs({ ResStatus: 'Commit' })}>
      <UniqueID ${attrs({ Type: '14', ID: input.reservationId })}/>
      <BasicPropertyInfo ${attrs({ HotelCode: input.hotelCode })}/>
    </HotelReservation>
  </HotelReservations>`;
  return otaRoot('OTA_HotelResNotifRS', input.echoToken, input.timestamp ?? new Date().toISOString(), inner);
}

/** Resposta de erro: o Booking reenvia? Só quando `retryable`. */
export function buildErrorAck(input: {
  echoToken: string;
  timestamp: string | null;
  code: string;
  message: string;
  type?: '3' | '4';
}): string {
  const inner = `  <Errors>
    <Error ${attrs({ Type: input.type ?? '3', Code: input.code })}>${escapeXml(input.message)}</Error>
  </Errors>`;
  return otaRoot('OTA_HotelResNotifRS', input.echoToken, input.timestamp ?? new Date().toISOString(), inner);
}
