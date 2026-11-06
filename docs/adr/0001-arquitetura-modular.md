# ADR 0001 — Arquitetura modular em um único deployable

**Status:** aceito · **Data:** 2026-11-06

## Contexto

A especificação da hosfera descreve PMS, channel manager, motor de reservas e
financeiro. O time é pequeno e o primeiro marco é o piloto com 20–50 imóveis.
Separar serviços desde o início multiplicaria operação (deploy, observabilidade,
rede) sem resolver nenhum problema real dessa escala.

## Decisão

Um pacote (`hosfera`), um processo Node, camadas com fronteiras explícitas:

```
domain/         funções puras, sem I/O
db/             persistência; único lugar com SQL
connectivity/   contrato de adaptador + implementações de canal
services/       casos de uso que orquestram domínio + banco + adapters
http/           transporte; nenhuma regra de negócio
```

Regras que sustentam a decisão:

- `domain/` não importa `db/`, `http/` nem adapters.
- Adapter não conhece o domínio inteiro: recebe payload canônico e devolve
  `PushResult` / `NormalizedReservation`.
- Nenhuma rota fala com adaptador diretamente; `services/` faz a orquestração.
- SQL só em `db/repositories.ts`.

## Consequências

- Extrair o channel manager para um serviço separado depois é mover `connectivity/`
  e `services/dispatcher` para outro processo — as fronteiras já existem.
- Um deploy, um log, um teste de integração.
- Exige disciplina de revisão: se `domain/` começar a importar `db/`, a decisão
  morre silenciosamente. O `tsc --noEmit` não detecta isso; é convenção revisada.
