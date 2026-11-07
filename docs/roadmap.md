# Roadmap de desenvolvimento

Alinhado ao planejamento de 24 semanas (`propostas/hosfera/hosfera-plan`). Cada
onda só avança com os critérios de saída cumpridos — não por data.

## Onda 0 — fundação (concluída neste commit)

- [x] Domínio canônico: imóvel, unidade, tarifa, anúncio, reserva, tarefa, lançamento
- [x] Disponibilidade derivada com intervalo meio-aberto
- [x] Preço com acréscimo de fim de semana, limpeza e override por dia
- [x] Outbox com idempotência, backoff exponencial e dead-letter
- [x] Contrato de adaptador + canal `mock` assinado (HMAC)
- [x] Reserva idempotente, tarefas automáticas, financeiro e auditoria
- [x] API HTTP com erros semânticos e smoke de ponta a ponta
- [x] 65 testes + `tsc --noEmit` limpos

## Onda 1 — operação real (em andamento)

Concluído nesta rodada (v0.2.0):

- [x] **Identidade e multi-tenant**: token opaco (SHA-256 no banco), `org_id` e
      papel derivados do token, RBAC com 5 papéis, revogação auditada (ADR 0005)
- [x] **Migrations versionadas**: `migrations/001_init`, `002_auth` (ADR 0006)
- [x] **Calendário operacional**: grade de 8 semanas com preço, disponibilidade e
      bloqueio editáveis na própria célula
- [x] **Telas**: reservas com transições, tarefas por data, canais com capacidades
      e publicação de anúncio
- [x] **Guarda contra overbooking manual**: ARI recusa disponibilidade acima do
      inventário e o domínio limita o override

Próximo:

- [ ] **Onboarding**: fotos, comodidades, políticas, duplicar unidade
- [ ] **OIDC**: login humano (e-mail/senha ou SSO) substituindo o token colado
- [ ] **Adaptador Booking** (OTA 2003B + B.XML) com sandbox
- [ ] **Observabilidade**: logs com `correlation_id`, métricas de sincronização
      (sucesso, p95, dead-letter) e alerta
- [ ] **Rate limit por canal** no dispatcher (token bucket por conexão)
- [ ] **Inbox** de mensagens e financeiro na UI

## Onda 2 — operação e financeiro

- [ ] Inbox unificado (mensagens de Airbnb/Booking) com templates e SLA
- [ ] Tarefas com atribuição, checklist e app mobile (PWA primeiro)
- [ ] Conciliação: valor do canal × lançamento × repasse, com divergência explícita
- [ ] Repasse a proprietário e extrato por portfólio
- [ ] Adaptadores Airbnb e Decolar
- [ ] Relatórios: ocupação, ADR, RevPAR, margem líquida por canal

## Onda 3 — crescimento

- [ ] Motor de reservas diretas com domínio próprio e tracking
- [ ] Google Vacation Rentals (feed + booking link)
- [ ] Expedia e Vrbo (GraphQL supply, OAuth2, webhooks, pagamentos)
- [ ] Pricing assistido (sugestão por ocupação/gap, não automático)
- [ ] API pública versionada e webhooks para clientes

## Débitos técnicos registrados

| Débito | Por que não agora | Quando |
| --- | --- | --- |
| SQLite em produção | piloto cabe; Postgres exige infra | antes do 2º cliente |
| Token em `localStorage` | sem sessão de servidor ainda; risco de XSS | junto com OIDC |
| Escopo por imóvel inexistente | piloto com uma organização | quando houver portfólio compartilhado |
| Sem rate limit por canal | mock não tem limite | junto com Booking |
| Sem cache de disponibilidade | 50 imóveis é trivial | se p95 de calendário > 300 ms |
| Sem testes de carga | precisa de ambiente com dados | antes do go-live |
