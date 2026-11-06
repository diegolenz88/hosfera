# ADR 0002 — SQLite no desenvolvimento, Postgres na produção

**Status:** aceito · **Data:** 2026-11-06

## Contexto

O piloto precisa de um banco que suba sem infraestrutura e sobreviva a
reconciliação de dados reais. A produção exige concorrência de escrita, backup
gerenciado e tipos como `jsonb`.

## Decisão

- Desenvolvimento e testes: SQLite via `node:sqlite` (embutido no runtime).
- Produção: Postgres. A migração é planejada, não espontânea.

Regras para não pagar caro na migração:

- Dinheiro sempre em **inteiros de centavos** — nunca `float`.
- Datas de calendário como `YYYY-MM-DD` (`TEXT`) e timestamps ISO-8601 em UTC.
- Nada de `AUTOINCREMENT`, `rowid` ou funções específicas de SQLite na lógica;
  ids são UUID gerados na aplicação.
- Upsert usa SQL padrão (`ON CONFLICT ... DO UPDATE`), suportado pelos dois.
- `transaction()` está isolado em `db/database.ts`: trocar por `BEGIN/COMMIT`
  do driver Postgres afeta um arquivo.

## Consequências

- Testes rodam em memória, sem container.
- `node:sqlite` é experimental no runtime: a versão do Node está fixada
  (`engines: >=24`) e o uso está restrito a `db/`.
- A migração exigirá: driver (`pg`), pooling, e uma revisão dos tipos `TEXT`
  usados como data.
