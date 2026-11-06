# API — hosfera v0.1

Base: `http://127.0.0.1:3000` · Autenticação: `x-api-key: <valor de API_KEY>`
(`/health` e `/v1/webhooks/*` são públicos; webhook se autentica por assinatura).

```bash
export H=http://127.0.0.1:3000
export K=$(grep '^API_KEY=' .env | cut -d= -f2)
```

## Sistema

```bash
curl $H/health
curl -H "x-api-key: $K" $H/v1/channels
```

`/v1/channels` devolve, por canal, `capabilities`, `certification` e `docs` — é a
fonte da verdade sobre o que está homologado.

## Inventário

```bash
ORG=$(curl -s -X POST $H/v1/organizations -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"name":"Administradora Demo"}' | jq -r .id)

PROP=$(curl -s -X POST $H/v1/properties -H "x-api-key: $K" -H 'content-type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"name\":\"Casa Praia\",\"city\":\"Mata de São João\"}" | jq -r .id)

UNIT=$(curl -s -X POST $H/v1/properties/$PROP/units -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"name":"Suíte Aurora","inventory":1,"minStay":2}' | jq -r .id)

curl -s -X POST $H/v1/units/$UNIT/rate-plans -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"name":"Flexível","basePriceCents":48000,"weekendUpliftPct":25,"cleaningFeeCents":15000,"minStay":2}'
```

## Calendário e preço

```bash
# preço e disponibilidade por dia (ARI)
curl -s -X PUT $H/v1/units/$UNIT/ari -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "days":[
    {"date":"2026-12-27","rateCents":92000,"available":1,"minStay":3},
    {"date":"2026-12-28","rateCents":92000,"available":1,"minStay":3}
  ]}'
# → {"daysWritten":2,"events":1}

curl -s -H "x-api-key: $K" "$H/v1/units/$UNIT/availability?from=2026-12-20&to=2027-01-05"
curl -s -H "x-api-key: $K" "$H/v1/units/$UNIT/quote?checkin=2026-12-27&checkout=2026-12-30"

# bloqueio manual (manutenção, uso do proprietário)
curl -s -X POST $H/v1/units/$UNIT/blocks -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"startDate":"2027-01-10","endDate":"2027-01-12","reason":"manutenção"}'
```

`events` é o número de anúncios publicados que receberam evento no outbox.

## Canais e anúncios

```bash
CONN=$(curl -s -X POST $H/v1/connections -H "x-api-key: $K" -H 'content-type: application/json' \
  -d "{\"orgId\":\"$ORG\",\"channel\":\"mock\",\"label\":\"Dev\",\"status\":\"active\"}" | jq -r .id)

LIST=$(curl -s -X POST $H/v1/listings -H "x-api-key: $K" -H 'content-type: application/json' \
  -d "{\"unitId\":\"$UNIT\",\"connectionId\":\"$CONN\"}" | jq -r .id)

curl -s -X POST $H/v1/listings/$LIST/publish -H "x-api-key: $K"
# → {"listing":{...},"externalId":"MOCK-00001","daysSynced":365}
```

Publicar dispara a sincronização da janela de 365 dias com disponibilidade
derivada. Canal não homologado responde:

```json
{"error":"channel_not_certified","message":"canal booking não certificado para publicação de anúncio: ...","retryable":false}
```

## Outbox

```bash
curl -s -H "x-api-key: $K" "$H/v1/outbox?status=pending"
curl -s -X POST $H/v1/outbox/dispatch -H "x-api-key: $K"
# → {"processed":2,"sent":2,"retried":0,"dead":0,"skipped":0}
```

Em produção o dispatcher roda sozinho (`DISPATCH_INTERVAL_MS`); o endpoint existe
para teste e para forçar sincronização depois de incidente.

## Reservas

Webhook real (assinatura obrigatória):

```bash
BODY='{"externalId":"BK-9912","externalListingId":"MOCK-00001","checkin":"2027-02-10","checkout":"2027-02-13","guests":4,"status":"confirmed","totalCents":135000,"commissionCents":20250,"currency":"BRL"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'mock-shared-secret' -hex | awk '{print $2}')

curl -s -X POST $H/v1/webhooks/mock/$CONN \
  -H 'content-type: application/json' -H "x-mock-signature: $SIG" -d "$BODY"
```

Simulador de OTA (apenas fora de produção):

```bash
curl -s -X POST $H/v1/dev/mock/reservations -H "x-api-key: $K" -H 'content-type: application/json' -d "{
  \"connectionId\":\"$CONN\",\"externalListingId\":\"MOCK-00001\",\"externalId\":\"SMOKE-1\",
  \"checkin\":\"2027-03-10\",\"checkout\":\"2027-03-13\",\"guests\":4,
  \"totalCents\":135000,\"commissionCents\":20250}"
```

Resposta: `{reservationId, status, created, tasksCreated, republished}`.
`created: false` em reenvio do mesmo `externalId` — o upsert é idempotente.

```bash
curl -s -H "x-api-key: $K" "$H/v1/reservations?orgId=$ORG"
curl -s -H "x-api-key: $K" "$H/v1/reservations/<id>"          # reserva + lançamentos + líquido
curl -s -X POST $H/v1/reservations/<id>/status -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"status":"checked_in"}'
```

Transições válidas: `pending → confirmed → checked_in → checked_out`, com
`cancelled`/`no_show` a partir de `pending`/`confirmed`. Fora disso: 400.

## Operação e auditoria

```bash
curl -s -H "x-api-key: $K" "$H/v1/tasks?orgId=$ORG&status=pending"
curl -s -H "x-api-key: $K" "$H/v1/summary?orgId=$ORG"
curl -s -H "x-api-key: $K" "$H/v1/audit?scope=reservation&refId=<id>"
```

## Erros

| HTTP | `error` | Quando |
| --- | --- | --- |
| 400 | `bad_request` | payload inválido, transição inválida, data malformada |
| 401 | `unauthorized` | falta `x-api-key` ou chave errada |
| 404 | `not_found` | recurso inexistente |
| 409 | `invalid_state` | publicar com conexão não ativa |
| 409 | `channel_not_certified` | canal sem homologação |
| 422 | `pricing_error` | estadia abaixo do mínimo |
| 502 | `channel_error` | falha retentável do canal |
