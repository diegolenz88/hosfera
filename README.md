# hosfera

PMS + channel manager para aluguel por temporada. Este repositório é o início da
plataforma descrita em `propostas/hosfera/` (benchmark, brief, especificação e
planejamento): o **núcleo canônico** e a **camada de conectividade** funcionando
de ponta a ponta, com um canal de desenvolvimento que exercita o fluxo completo
sem depender de credencial de OTA.

```
                    ┌────────────────────┐
   Booking  ◀──────▶│                    │◀──────▶  Airbnb
   Decolar  ◀──────▶│   channel manager  │◀──────▶  Expedia / Vrbo
   Google   ◀──────▶│  (adapters + outbox)│◀──────▶  Decolar
                    └─────────┬──────────┘
                              │ eventos canônicos
                    ┌─────────▼──────────┐
                    │      PMS           │  imóveis · unidades · tarifas
                    │  (domínio + API)   │  reservas · tarefas · financeiro
                    └─────────┬──────────┘
                    ┌─────────▼──────────┐
                    │ SQLite (dev)       │  → Postgres (produção)
                    └────────────────────┘
```

## Status

| Área | Estado |
| --- | --- |
| Domínio (disponibilidade, preço, reserva, tarefas) | funcional, 65 testes |
| Persistência | SQLite via `node:sqlite`, esquema canônico |
| Channel manager (outbox, retry, dead-letter, auditoria) | funcional |
| Canal `mock` (desenvolvimento) | funcional, com webhook assinado |
| Booking, Airbnb, Decolar, Expedia, Vrbo, Google | catálogo + capacidades; **pendentes de certificação** (ver ADR 0004) |
| Identidade | token opaco + RBAC por organização (5 papéis), 77 testes |
| Persistência de esquema | migrations versionadas (`migrations/`) |
| API HTTP | fastify, `Authorization: Bearer` |
| UI operacional | calendário editável, reservas, tarefas e canais (sem build) |

## Requisitos

- Node.js >= 24 (usa `node:sqlite` e executa TypeScript nativamente — sem build).
- Nenhum banco externo para desenvolvimento.

## Rodando

```bash
npm install
cp .env.example .env        # opcional: ajuste porta e caminho do banco
npm run seed                # cria organização, casa, 2 unidades, conexões e calendário
npm start                   # API + interface em http://127.0.0.1:3000
```

O seed imprime o **token de acesso** (`hsk_...`) uma única vez e grava uma cópia em
`data/.dev-token` (fora do versionamento). Abra `http://127.0.0.1:3000`, cole o
token e a operação abre no calendário. Sem token, a tela oferece "criar organização
demo" usando a chave de bootstrap do `.env`.

```bash
npm test          # 65 testes (domínio, contrato dos adaptadores, fluxo HTTP)
npm run typecheck # tsc --noEmit
npm run smoke     # sobe a API em porta efêmera e percorre o fluxo completo
```

O `smoke` é o teste que importa antes de qualquer commit: ele exercita
publicação → ARI → dispatch → reserva de canal → disponibilidade → tarefas →
financeiro → fan-out entre canais → autenticação.

## Fluxo principal

1. **Publicar** um anúncio (`POST /v1/listings/:id/publish`): o adaptador devolve
   o id externo e a **janela de 365 dias com disponibilidade derivada** é enviada
   ao canal — um anúncio novo nasce já bloqueado nas noites reservadas.
2. **Publicar ARI** (`PUT /v1/units/:id/ari`): grava preço/disponibilidade/
   restrições e enfileira um evento por anúncio publicado.
3. **Dispatcher** consome o outbox com backoff exponencial e dead-letter; a
   disponibilidade é **recalculada no envio** (entre enfileirar e enviar pode ter
   chegado outra reserva).
4. **Reserva** chega por webhook assinado: assinatura → normalização → upsert
   idempotente por `(conexão, id externo)` → tarefas → lançamentos → republicação
   da disponibilidade **nos demais canais**.

## Endpoints

Autenticação: `Authorization: Bearer <token>`. O token carrega organização e papel
— **o cliente nunca informa de qual organização é**. `/health`, `/v1/bootstrap` e
`/v1/webhooks/*` (assinatura) são as únicas rotas sem token. Referência com
exemplos: [`docs/api.md`](docs/api.md).

| Método | Rota | Função |
| --- | --- | --- |
| POST | `/v1/bootstrap` | cria organização + primeiro token (chave de ambiente) |
| GET | `/v1/me` | usuário, papel, organização e permissões |
| GET/POST/DELETE | `/v1/tokens` | emissão e revogação de tokens |
| GET | `/health` | status, canais, contadores do outbox |
| GET | `/v1/channels` | catálogo com capacidades e pendência de certificação |
| POST | `/v1/organizations` | criar organização |
| POST/GET | `/v1/properties`, `/v1/properties/:id/units` | inventário |
| POST | `/v1/units/:id/rate-plans` | tarifa (preço base, fim de semana, limpeza) |
| PUT | `/v1/units/:id/ari` | preço/disponibilidade/restrições por dia |
| POST | `/v1/units/:id/blocks` | bloqueio manual |
| GET | `/v1/units/:id/availability` | calendário derivado |
| GET | `/v1/units/:id/quote` | cotação de estadia |
| POST | `/v1/connections` | conexão de canal |
| POST | `/v1/listings`, `/v1/listings/:id/publish` | anúncios |
| POST | `/v1/webhooks/:channel/:connectionId` | reserva vinda do canal |
| GET/POST | `/v1/reservations`, `/v1/reservations/:id/status` | reservas e transições |
| GET | `/v1/tasks` | operação (limpeza, check-in/out) |
| GET/POST | `/v1/outbox`, `/v1/outbox/dispatch` | fila de saída |
| GET | `/v1/audit` | trilha de eventos |
| GET | `/v1/summary` | KPIs consolidados |

## Estrutura

```
migrations/      001_init, 002_auth (versionadas, imutáveis)
src/
  domain/        regras puras: datas, disponibilidade, preço, ciclo de reserva
  auth/          tokens (hash SHA-256) e matriz de permissões
  db/            migrations runner + repositórios (SQL único, prepared statements)
  connectivity/  contrato de adaptador, registry, adapters (mock + pendentes)
  services/      casos de uso: ARI, publicação, reserva, dispatcher
  http/          fastify: rotas, autenticação, tratamento de erro
  cli/           seed e smoke
public/          interface operacional (HTML/CSS/JS, sem build)
tests/
  domain/        regras de negócio
  connectivity/  contrato que todo adaptador precisa cumprir
  api/           fluxo completo via injeção HTTP
docs/
  adr/           decisões de arquitetura
  api.md         referência com curl
  roadmap.md     próximas ondas
```

## Decisões que valem ler antes de mexer

- [ADR 0001 — arquitetura modular](docs/adr/0001-arquitetura-modular.md)
- [ADR 0002 — SQLite agora, Postgres na produção](docs/adr/0002-sqlite-agora-postgres-depois.md)
- [ADR 0003 — disponibilidade derivada, não armazenada](docs/adr/0003-disponibilidade-derivada.md)
- [ADR 0004 — canal não certificado falha explícito](docs/adr/0004-canais-nao-certificados.md)
- [ADR 0005 — identidade por token e RBAC](docs/adr/0005-identidade-token-rbac.md)
- [ADR 0006 — migrations versionadas](docs/adr/0006-migrations-versionadas.md)

## O que ainda não existe (honestamente)

- Inbox de mensagens e financeiro na UI: existem na API, não na tela.
- OIDC (login humano com e-mail/senha ou SSO): hoje é token por usuário.
- Escopo por imóvel: um `manager` enxerga todo o portfólio da organização.
- Pagamentos: `ledger_entries` registram valores, não processam cobrança.
- Preço dinâmico (revenue management): só tarifa base + override por dia.
- Os seis canais reais: contrato e matriz de capacidades prontos; implementação
  depende de homologação (ADR 0004).
