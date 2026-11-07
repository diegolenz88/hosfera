# ADR 0007 — Booking: protocolo implementado, homologação como gate

**Status:** aceito · **Data:** 2026-11-06

## Contexto

O Booking é o canal que destrava o piloto comercial. Implementar "quando tivermos
credencial" deixa o maior risco do projeto — o formato das mensagens e a
semântica de erro — para o fim, quando não há tempo de corrigir. Implementar
"como se estivesse pronto" é pior: um adaptador que devolve sucesso falso cria
confiança em dados que não chegaram ao canal.

## Decisão

Separar **protocolo** de **homologação**, e tratar os dois como artefatos
distintos:

1. **Protocolo implementado** (`src/connectivity/adapters/booking/`):
   - `messages.ts` monta e lê OTA 2003B: `OTA_HotelAvailNotifRQ`,
     `OTA_HotelRateAmountNotifRQ`, `OTA_HotelResNotifRQ/RS`, `OTA_CancelRQ`,
     `OTA_PingRQ`;
   - `transport.ts` isola HTTP (Basic auth, timeout, classificação de retry);
   - `adapter.ts` implementa `ChannelAdapter` sobre essas duas peças.
2. **Gate explícito**: `certified: false` (padrão, vindo de `BOOKING_CERTIFIED`)
   faz toda operação falhar com `channel_not_certified` e `retryable: false`.
   Sem homologação, nada é enviado — e o erro é terminal, não entra em retry.
3. **Transporte plugável**: `MemoryTransport` grava requisições e devolve
   respostas fixas. É o que permite testar XML, erro de negócio e 5xx sem rede.
4. **Webhook responde no formato do canal**: `confirmWebhook()` devolve
   `OTA_HotelResNotifRS` ecoando o `UniqueID`. JSON faria o Booking reenviar a
   reserva em loop.
5. **Catálogo distingue** `implemented` de "pronto": a UI mostra "protocolo
   implementado, homologação pendente", não "conectado".

## Consequências

- O que falta para ativar é **operacional**, não código: conta de máquina,
  HotelCode/RoomCode mapeados no extranet, certificação no Provider Portal e
  endpoint público com TLS. Está em `docs/booking-activation.md`.
- Erros de negócio (OTA `Type=3`, ex. rate plan inexistente) não são retentáveis;
  erros de sistema (`Type=4`, HTTP 5xx, timeout) são. Essa distinção alimenta o
  outbox e evita repetir para sempre um payload inválido.
- `verifyWebhook` exige segredo compartilhado. Quando o Booking passar a assinar
  o corpo, o segredo vira HMAC do corpo cru — o ponto de troca é uma função.
- Conteúdo/fotos (Content API), mensagens (Messaging) e pagamentos continuam
  fora: são escopos de conexão adicionais, não parte da venda e da reserva.
- Cancelamento iniciado pelo hotel usa o servidor PCI (`secure-supply-xml`)
  porque carrega dado de reserva; disponibilidade e tarifa usam o não-PCI.
