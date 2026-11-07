# ADR 0005 — Identidade por token opaco com RBAC por organização

**Status:** aceito · **Data:** 2026-11-06

## Contexto

Na fundação a API usava uma chave única global (`x-api-key`) e o `org_id` vinha
da query string. Isso não distingue usuários, não tem papéis e permite que um
cliente leia dados de outro trocando um parâmetro — inaceitável antes de qualquer
piloto com dado real.

OIDC completo (authorization code + PKCE, refresh, sessão) é a direção, mas exige
provedor de identidade, e o piloto ainda não tem. Precisamos de isolamento e
papéis **agora**, sem travar a UI.

## Decisão

1. **Token opaco** (`hsk_` + 24 bytes aleatórios) entregue uma única vez; o banco
   guarda apenas SHA-256. Vazamento de banco não vaza credencial.
2. O token carrega `org_id` e `role`; **o cliente nunca informa a organização**.
   `orgId` na query é aceito só quando igual ao do token (senão 403).
3. **RBAC em matriz** (`src/auth/permissions.ts`): `owner`, `manager`,
   `operations`, `finance`, `viewer`. Ação fora da matriz → 403, sem "admin
   implícito".
4. Recurso de outra organização responde **404**, não 403: não confirma que o id
   existe.
5. Autorização vem **antes** de validar existência (`guard` no início do handler),
   para não vazar estrutura por mensagem de erro.
6. Bootstrap (`POST /v1/bootstrap`) é o único caminho sem token, protegido por
   segredo de ambiente; em produção fica desabilitado se a variável não existir.
7. Revogação é `revoked_at`, nunca `DELETE`: auditoria em `auth_events`.

## Consequências

- A UI guarda o token em `localStorage` e envia `Authorization: Bearer`. É um
  cliente não confiável: toda decisão é refeita no servidor.
- Trocar para OIDC depois é substituir `resolveToken()` por validação de JWT +
  mapeamento de claim para `org_id`/`role`; rotas e matriz de permissões não mudam.
- Sem escopo por imóvel: um `manager` vê todo o portfólio da organização. Suficiente
  para o piloto; vira `property_ids` no token quando houver cliente com portfólio
  compartilhado entre gestores.
- Token em `localStorage` é vulnerável a XSS. Mitigação: nenhuma dependência de
  terceiro no front, `Content-Security-Policy` e, no futuro, cookie `HttpOnly`
  com CSRF token quando houver sessão de servidor.
