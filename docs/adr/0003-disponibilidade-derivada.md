# ADR 0003 — Disponibilidade é derivada, não armazenada

**Status:** aceito · **Data:** 2026-11-06

## Contexto

A causa número um de overbooking em channel manager é a divergência entre o
"saldo de disponibilidade" guardado em tabela e a realidade das reservas. Quando
uma reserva é cancelada, um bloqueio é removido ou um webhook chega fora de
ordem, o contador armazenado precisa ser corrigido por todos os caminhos — e
basta um caminho esquecido para vender o mesmo imóvel duas vezes.

## Decisão

`disponibilidade = inventário da unidade − reservas ativas − bloqueios`.

- A tabela `calendar_days` guarda **apenas exceções**: preço do dia, fechamento
  manual, mínimo de noites. Nunca "quantas unidades restam".
- Reservas ocupam o intervalo meio-aberto `[checkin, checkout)`: quem sai dia 12
  libera a noite do dia 12.
- Status que ocupam: `pending`, `confirmed`, `checked_in`. `cancelled`,
  `no_show` e `checked_out` não ocupam.
- O dispatcher **recalcula no envio**, não confia no payload enfileirado.

## Consequências

- Consulta de calendário é um cálculo sobre reservas do período — O(reservas),
  não O(1). Para 50 imóveis do piloto é irrelevante; se virar gargalo, entra
  cache por unidade invalidado por evento.
- Cancelamento, no-show e remoção de bloqueio ficam corretos por construção: não
  existe contador para dessincronizar.
- Todo caminho que altera reserva precisa republicar a disponibilidade nos canais
  do mesmo imóvel. Isso está centralizado em `republishAvailability()` e não deve
  ser duplicado.
- O invariante tem teste próprio: `tests/domain/availability.test.ts` cobre
  intervalo meio-aberto, inventário > 1, bloqueio e override.
