# ADR 0004 — Canal não certificado falha explícito, não simula

**Status:** aceito · **Data:** 2026-11-06

## Contexto

Booking, Airbnb, Decolar, Expedia, Vrbo e Google exigem programas de parceria,
contrato, revisão de segurança e homologação. Nenhum deles pode ser "integrado"
por vontade própria, e um adaptador que devolve sucesso falso é pior do que um
adaptador ausente: ele gera confiança em dados que não chegaram ao canal.

## Decisão

1. Todo canal previsto existe no catálogo (`CHANNEL_PROFILES`) com **capacidades
   declaradas** e o **pré-requisito de certificação** escrito.
2. Enquanto não homologado, o canal usa `PendingChannelAdapter`: toda operação
   lança `ChannelError` com `retryable: false` e código `channel_not_certified`.
   A API responde **409**, não 500 e não 200.
3. `healthCheck()` do canal pendente retorna `ok: false` com a pendência em texto.
4. O `mock` é um canal explícito, não um substituto silencioso: assina webhook
   com HMAC-SHA256, mantém estado e permite simular falha (`failNext`) para
   testar retry.
5. O contrato é verificado por teste (`tests/connectivity/contract.test.ts`):
   capacidades completas, publicação idempotente, normalização de reserva,
   recusa de payload inválido.

## Consequências

- O produto nunca promete disponibilidade em canal que não está homologado.
- Para ativar um canal real: implementar o adaptador, passar o contrato, passar
  no sandbox do canal e trocar a entrada no `AdapterRegistry` — sem tocar em
  serviço, rota ou banco.
- Retry não é usado para "esperar" certificação: falha de canal não certificado é
  terminal, para não poluir o outbox com eventos impossíveis.

## Referências

- Booking Connectivity APIs — https://developers.booking.com/connectivity/docs
- Airbnb API Terms — https://www.airbnb.com/help/article/3418
- Expedia Group supply APIs — https://developers.expediagroup.com/supply/lodging/documentation
- Google Vacation Rentals (parceiros) — https://support.google.com/hotelprices/answer/12567939
- Decolar / Despegar partners — https://www.us.despegar.com/information/partners
