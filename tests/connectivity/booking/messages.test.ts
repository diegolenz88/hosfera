import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BookingMessageError,
  buildAvailabilityNotif,
  buildRateAmountNotif,
  buildReservationAck,
  groupConsecutive,
  parseAck,
  parseReservationNotification,
} from '../../../src/connectivity/adapters/booking/messages.ts';

const base = {
  hotelCode: 'HOTEL-1',
  roomCode: 'ROOM-1',
  ratePlanCode: 'RATE-1',
  echoToken: 'echo-1',
  timestamp: '2026-11-06T12:00:00Z',
  machineAccount: 'MACHINE-ACCOUNT',
};

test('disponibilidade agrupa dias consecutivos idênticos em um único range', () => {
  const xml = buildAvailabilityNotif({
    ...base,
    days: [
      { date: '2026-12-20', available: 2, closed: false, minStay: 2 },
      { date: '2026-12-21', available: 2, closed: false, minStay: 2 },
      { date: '2026-12-22', available: 2, closed: false, minStay: 2 },
      { date: '2026-12-23', available: 0, closed: true, minStay: 2 },
    ],
  });

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<OTA_HotelAvailNotifRQ[^>]*EchoToken="echo-1"/);
  assert.match(xml, /<RequestorID Type="1" ID="MACHINE-ACCOUNT"\/>/);
  assert.match(xml, /<AvailStatusMessages HotelCode="HOTEL-1">/);

  // o primeiro range cobre 20→22 com BookingLimit 2...
  assert.match(xml, /<AvailStatusMessage BookingLimit="2">\s*<StatusApplicationControl Start="2026-12-20" End="2026-12-22"/);
  // ...e o dia fechado vira outro range, com limite 0 e Status Close
  assert.match(xml, /<AvailStatusMessage BookingLimit="0">\s*<StatusApplicationControl Start="2026-12-23" End="2026-12-23"/);
  assert.match(xml, /<RestrictionStatus Status="Close"\/>/);
  assert.equal((xml.match(/<AvailStatusMessage /g) ?? []).length, 2, 'dois ranges, não quatro dias');
  assert.match(xml, /<LengthsOfStay>/, 'mínimo de noites presente');
  assert.match(xml, /MinMaxMessageType="SetMinLOS"/);
});

test('mínimo de uma noite não gera bloco de LengthsOfStay', () => {
  const xml = buildAvailabilityNotif({
    ...base,
    days: [{ date: '2026-12-20', available: 1, closed: false, minStay: 1 }],
  });
  assert.ok(!xml.includes('<LengthsOfStay>'));
});

test('tipos e caracteres especiais são escapados', () => {
  const xml = buildAvailabilityNotif({
    ...base,
    hotelCode: 'HOTEL & CIA "1"',
    days: [{ date: '2026-12-20', available: 1, closed: false, minStay: 1 }],
  });
  assert.ok(xml.includes('HotelCode="HOTEL &amp; CIA &quot;1&quot;"'));
  assert.ok(!xml.includes('HOTEL & CIA'));
});

test('tarifas usam decimal com duas casas por dia', () => {
  const xml = buildRateAmountNotif({
    ...base,
    currency: 'BRL',
    days: [
      { date: '2026-12-20', rateCents: 48_000 },
      { date: '2026-12-21', rateCents: 92_050 },
    ],
  });
  assert.match(xml, /<OTA_HotelRateAmountNotifRQ/);
  assert.equal((xml.match(/<RateAmountMessage>/g) ?? []).length, 2);
  assert.match(xml, /AmountAfterTax="480.00"[^>]*CurrencyCode="BRL"[^>]*NumberOfGuests="1"/);
  assert.match(xml, /AmountAfterTax="920.50"/);
  assert.match(xml, /RatePlanCode="RATE-1"/);
});

test('agrupamento não junta dias com lacuna', () => {
  const groups = groupConsecutive([
    { date: '2026-12-20', available: 1, closed: false, minStay: 1 },
    { date: '2026-12-22', available: 1, closed: false, minStay: 1 },
  ]);
  assert.equal(groups.length, 2);
});

const reservationXml = `<?xml version="1.0" encoding="UTF-8"?>
<OTA_HotelResNotifRQ xmlns="http://www.opentravel.org/OTA/2003/05" EchoToken="echo-res" TimeStamp="2026-11-06T12:00:00Z" Version="1.0">
  <HotelReservations>
    <HotelReservation ResStatus="Commit" CreateDateTime="2026-11-01T10:00:00Z">
      <UniqueID Type="14" ID="BK-998877"/>
      <RoomStays>
        <RoomStay>
          <RoomTypes><RoomType RoomTypeCode="ROOM-1"/></RoomTypes>
          <RatePlans><RatePlan RatePlanCode="RATE-1"/></RatePlans>
          <GuestCounts><GuestCount AgeQualifyingCode="10" Count="2"/><GuestCount AgeQualifyingCode="8" Count="1"/></GuestCounts>
          <TimeSpan Start="2026-12-20" End="2026-12-23"/>
          <Total AmountAfterTax="1350.00" CurrencyCode="BRL"/>
          <BasicPropertyInfo HotelCode="HOTEL-1"/>
          <Commission><CommissionPayableAmount AmountAfterTax="202.50"/></Commission>
        </RoomStay>
      </RoomStays>
      <ResGuests>
        <ResGuest>
          <Profiles><ProfileInfo><Profile><Customer>
            <PersonName><GivenName>Maria</GivenName><Surname>Silva</Surname></PersonName>
            <Email>maria.silva@example.com</Email>
          </Customer></Profile></ProfileInfo></Profiles>
        </ResGuest>
      </ResGuests>
    </HotelReservation>
  </HotelReservations>
</OTA_HotelResNotifRQ>`;

test('reserva OTA é normalizada com hóspede, período, valores e comissão', () => {
  const parsed = parseReservationNotification(reservationXml);
  assert.equal(parsed.reservationId, 'BK-998877');
  assert.equal(parsed.hotelCode, 'HOTEL-1');
  assert.equal(parsed.roomCode, 'ROOM-1');
  assert.equal(parsed.ratePlanCode, 'RATE-1');
  assert.equal(parsed.checkin, '2026-12-20');
  assert.equal(parsed.checkout, '2026-12-23');
  assert.equal(parsed.guests, 3, 'soma adultos + crianças');
  assert.equal(parsed.guestName, 'Maria Silva');
  assert.equal(parsed.guestEmail, 'maria.silva@example.com');
  assert.equal(parsed.status, 'confirmed');
  assert.equal(parsed.totalCents, 135_000);
  assert.equal(parsed.commissionCents, 20_250);
  assert.equal(parsed.currency, 'BRL');
});

test('ResStatus Cancelled vira reserva cancelada', () => {
  const cancelled = reservationXml.replace('ResStatus="Commit"', 'ResStatus="Cancelled"');
  assert.equal(parseReservationNotification(cancelled).status, 'cancelled');
});

test('reserva sem UniqueID é recusada com erro de mensagem', () => {
  const broken = reservationXml.replace('<UniqueID Type="14" ID="BK-998877"/>', '');
  assert.throws(() => parseReservationNotification(broken), BookingMessageError);
});

test('ack classifica erro de negócio como não retentável e erro de sistema como retentável', () => {
  const business = parseAck(`<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05">
    <Errors><Error Type="3" Code="392">Rate plan not found</Error></Errors>
  </OTA_HotelAvailNotifRS>`);
  assert.equal(business.ok, false);
  assert.equal(business.errors[0]?.retryable, false);

  const system = parseAck(`<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05">
    <Errors><Error Type="4" Code="500">Internal error</Error></Errors>
  </OTA_HotelAvailNotifRS>`);
  assert.equal(system.ok, false);
  assert.equal(system.errors[0]?.retryable, true);

  const ok = parseAck(`<OTA_HotelAvailNotifRS xmlns="http://www.opentravel.org/OTA/2003/05"><Success/></OTA_HotelAvailNotifRS>`);
  assert.equal(ok.ok, true);
});

test('confirmação devolve o mesmo UniqueID que o canal enviou', () => {
  const ack = buildReservationAck({ reservationId: 'BK-998877', hotelCode: 'HOTEL-1', echoToken: 'echo-res', timestamp: null });
  assert.match(ack, /<OTA_HotelResNotifRS[^>]*EchoToken="echo-res"/);
  assert.match(ack, /<Success\/>/);
  assert.match(ack, /<UniqueID Type="14" ID="BK-998877"\/>/);
  assert.match(ack, /HotelCode="HOTEL-1"/);
});
