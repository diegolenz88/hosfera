# Ativar o Booking em produção

Checklist do que falta **depois** do código (o protocolo está implementado; ver
ADR 0007). Nenhum item é opcional: pular um deles deixa o canal em `pending` ou,
pior, vendendo inventário que a hosfera não controla.

## 1. Programa e credenciais

- [ ] Ser **Connectivity Partner** aprovado no Provider Portal do Booking.
      Sem isso não existe conta de máquina — e o programa está com entrada
      pausada para novos provedores, então isto é caminho crítico.
- [ ] Habilitar os **connection types** necessários: *Rates and Availability*,
      *Reservations*, *Content* (opcional), *Messaging* (opcional).
- [ ] Obter **conta de máquina** (usuário) e valor de autenticação.
- [ ] Confirmar em qual ambiente conectar: `supply-xml` (não-PCI) para
      disponibilidade/tarifa, `secure-supply-xml` (PCI) para reserva/cancelamento.

## 2. Configuração na hosfera

```bash
# .env — nunca commitar valores reais
BOOKING_ACCOUNT=<conta de máquina>
BOOKING_AUTH_VALUE=<valor de autenticação>
BOOKING_HOTEL_CODE=<HotelCode do extranet>
BOOKING_WEBHOOK_SECRET=<segredo combinado com o canal>
BOOKING_CERTIFIED=false      # vira true só no passo 5
```

Variáveis opcionais para sandbox: `BOOKING_BASE_URL`, `BOOKING_SECURE_BASE_URL`.

## 3. Mapeamento no extranet

- [ ] Criar **RoomCode** para cada tipo de unidade vendável.
- [ ] Criar **RatePlanCode** para cada plano tarifário.
- [ ] Na hosfera, o `externalId` do anúncio do canal Booking é o **RoomCode**
      (uma conexão por HotelCode). Sem isso, publicar falha com
      `mapping_required` — de propósito.

## 4. Exposição do webhook

- [ ] Endpoint público HTTPS: `https://<domínio>/v1/webhooks/booking/<connectionId>`
- [ ] Aceitar `POST` com `content-type: application/xml` (a API já guarda o corpo
      cru e responde `OTA_HotelResNotifRS`).
- [ ] Confirmar com o canal o cabeçalho de assinatura usado (`x-booking-signature`).
- [ ] Rate limit na borda coerente com o volume esperado (o Booking reenvia em
      caso de erro; a ingestão é idempotente por `UniqueID`).

## 5. Homologação (ordem recomendada)

1. `GET /v1/channels` → confirmar `booking.implemented: true`.
2. `healthCheck` do adaptador com `certified: true` em ambiente de teste
   (`OTA_PingRQ` deve responder `<Success/>`).
3. Enviar **um dia** de disponibilidade e conferir no extranet do Booking.
4. Enviar **uma tarifa** e conferir preço no extranet.
5. Criar reserva de teste no canal e conferir: reserva na hosfera, tarefas
   criadas, noites bloqueadas, ack XML devolvido.
6. Cancelar a reserva de teste no canal e conferir a liberação da disponibilidade.
7. Só então `BOOKING_CERTIFIED=true` em produção.

## 6. Critérios de aceite (não negociáveis)

- [ ] Reserva de teste aparece na hosfera com total e comissão corretos.
- [ ] Nenhuma noite fica vendável depois da reserva (consultar `/availability`).
- [ ] Ack em XML ecoa o `UniqueID`; reenvio do mesmo evento responde 200 e não duplica.
- [ ] Erro de negócio (`Type=3`) não entra em retry; `Type=4`/5xx entra com backoff.
- [ ] Logs sem PII: nome/e-mail do hóspede não aparecem em texto claro.
- [ ] Runbook escrito: o que fazer quando o canal recusa, quando o ping falha e
      como pausar o canal sem derrubar os outros.

## 7. Operação contínua

| Sinal | Ação |
| --- | --- |
| `channel_error` crescendo no outbox | verificar ping e credencial; pausar canal se persistir |
| eventos `dead` | inspecionar `last_error`, corrigir payload e reprocessar |
| reserva no extranet sem correspondente na hosfera | reconciliar por `UniqueID` (idempotência garante que reenviar é seguro) |
| divergência de preço | conferir se a tarifa foi enviada no plano certo (`RatePlanCode`) |

## Limites conhecidos desta implementação

- Conteúdo/fotos e mensagens não são enviados (escopos separados).
- Pagamentos by Booking não são geridos; a comissão vem no payload da reserva.
- Promoções e restrições avançadas (LOS, ocupação por adulto/criança) enviam o
  mínimo: `BookingLimit`, `SetMinLOS` e `RestrictionStatus`.
