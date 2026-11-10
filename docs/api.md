# API — hosfera v0.1

Base: `http://127.0.0.1:3000` · Autenticação: envie o token `hsk_...` no header
`Authorization` (esquema Bearer) ou em `x-api-key` — o alias existe para CLIs
simples. O token determina **organização e papel**; o cliente não informa de qual
organização é. `/health`, `/v1/bootstrap` e `/v1/webhooks/*` (assinatura própria)
são as únicas rotas sem token.

```bash
export H=http://127.0.0.1:3000
export K=$(cat data/.dev-token)     # emitido por `npm run seed`
```

## Obter o primeiro token

```bash
curl -s -X POST $H/v1/bootstrap \
  -H 'content-type: application/json' \
  -H 'x-bootstrap-key: dev-bootstrap' \
  -d '{"orgName":"Administradora Demo","userName":"Operador"}'
# → {"organization":{...},"user":{"role":"owner"},"token":"hsk_..."}
```

O token aparece **uma única vez**. Em produção o endpoint fica desabilitado se
`HOSFERA_BOOTSTRAP` não estiver definido.

## Papéis

| Papel | Pode |
| --- | --- |
| `owner` | tudo, incluindo emitir/revogar tokens |
| `manager` | inventário, tarifas, canais, publicação, reservas, financeiro (leitura) |
| `operations` | reservas, tarefas, calendário e bloqueios |
| `finance` | leitura de reservas e financeiro |
| `viewer` | leitura de reservas |

```bash
# emitir um token de operação
curl -s -X POST $H/v1/tokens -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"userName":"Equipe limpeza","role":"operations","label":"operacao"}'

curl -s $H/v1/me -H "x-api-key: $K"        # quem sou eu + permissões
curl -s -X DELETE $H/v1/tokens/<id> -H "x-api-key: $K"
```

Ação fora do papel responde **403**; recurso de outra organização responde **404**.

## Sistema

```bash
curl $H/health
curl -H "x-api-key: $K" $H/v1/channels
```

`/v1/channels` devolve, por canal, `capabilities`, `certification` e `docs` — é a
fonte da verdade sobre o que está homologado.

## Inventário

```bash
ORG=$(curl -s $H/v1/me -H "x-api-key: $K" | jq -r .organization.id)

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


## Onboarding

```bash
# imóvel + unidades + tarifa + comodidades em uma transação
curl -s -X POST $H/v1/onboarding -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "property": { "name": "Casa Nova", "city": "Porto Seguro", "ownerName": "Ana", "ownerSharePct": 70 },
  "units": [
    { "name": "Suíte", "capacity": 4, "basePriceCents": 45000, "cleaningFeeCents": 15000,
      "minStay": 2, "amenities": ["Wi-Fi", "piscina"] }
  ]}'

curl -s -X POST $H/v1/units/<id>/duplicate -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"name":"Suíte 2"}'
```

## Fotos

```bash
# conteúdo em base64; o tipo é decidido pelos magic bytes
curl -s -X POST $H/v1/units/<id>/photos -H "x-api-key: $K" -H 'content-type: application/json' \
  -d "{\"dataBase64\":\"$(base64 -w0 foto.jpg)\",\"contentType\":\"image/jpeg\"}"

curl -s $H/v1/units/<id>/photos -H "x-api-key: $K"
curl -s "$H/v1/photos/<photoId>?t=$K" -o foto.jpg    # <img> não envia header
```

Limite de 8 MB, JPEG/PNG/WebP. Conteúdo idêntico não duplica registro nem arquivo.

## Financeiro e reconciliação

```bash
curl -s "$H/v1/finance/payouts?from=2026-12-01&to=2026-12-31" -H "x-api-key: $K"
curl -s "$H/v1/reconciliation?from=2026-12-01&to=2026-12-31" -H "x-api-key: $K"
```

`payouts` devolve `totals`, uma linha por imóvel (bruto, comissão, líquido,
percentual, repasse) e `channels` com margem líquida por canal.
`reconciliation` devolve `{ counts, issues }`, com `severity` `critical` ou `warning`.


## Sincronização por iCal

```bash
# 1. cadastrar o feed que o canal exporta
curl -s -X POST $H/v1/units/<id>/ical-sources -H "x-api-key: $K" -H 'content-type: application/json' \
  -d '{"url":"https://www.airbnb.com.br/calendar/ical/12345.ics","label":"Airbnb — Suíte Aurora"}'

# 2. sincronizar (idempotente por UID; evento cancelado libera a noite)
curl -s -X POST $H/v1/ical-sources/<sourceId>/sync -H "x-api-key: $K"

# 3. pegar o endereço que o canal assina (público, sem login)
curl -s $H/v1/units/<id>/ical-feed -H "x-api-key: $K"
# → { "url": "/v1/ical/ifs_....ics", "token": "ifs_..." }
```

O feed exportado lista reservas ativas e bloqueios manuais. Bloqueio vindo de
iCal **não** volta no feed: reexportar criaria eco e, com dois canais, um loop de
bloqueios.
