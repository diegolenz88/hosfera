# ADR 0006 — Migrations versionadas, nunca editar o passado

**Status:** aceito · **Data:** 2026-11-06

## Contexto

A fundação aplicava `schema.sql` inteiro com `CREATE TABLE IF NOT EXISTS` a cada
abertura do banco. Funciona enquanto o esquema só cresce e ninguém tem dado real:
no primeiro `ALTER TABLE` ou backfill, um arquivo idempotente passa a mentir —
bancos antigos não recebem a mudança e não há registro do que foi aplicado.

## Decisão

- `migrations/NNN_descricao.sql`, aplicados em ordem lexicográfica.
- Controle em `schema_migrations(version, applied_at)`.
- Cada arquivo roda em **transação**: falhou, nada é aplicado.
- Migrations aplicadas são **imutáveis**. Correção é um arquivo novo.
- `openDatabase()` aplica o que faltar; não existe passo manual de "rodar migration"
  em desenvolvimento.

## Consequências

- Um banco criado antes das migrations (só com `schema.sql`) continua funcionando:
  `001_init.sql` usa `IF NOT EXISTS`, então é aplicado sem erro e passa a ser
  registrado. A partir daí, todo mundo converge.
- Postgres exigirá um runner equivalente (mesma tabela de controle, `BEGIN/COMMIT`
  já isolado em `db/database.ts`). O SQL de 001/002 é compatível fora de `PRAGMA`.
- `PRAGMA` statements ficam no `openDatabase()`, não nas migrations.
- Rollback manual é responsabilidade de quem escreve a migration; o runner garante
  atomicidade, não desfazer.
