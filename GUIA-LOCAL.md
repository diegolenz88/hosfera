# Rodar a hosfera na sua máquina

Guia de 5 minutos. Você precisa de **Node.js 24 ou superior** — nada de banco,
Docker ou compilador.

---

## 1. Instalar o Node 24+

Verifique o que já tem:

```bash
node -v
```

Se aparecer `v24.x` ou maior, pule para o passo 2. Senão:

| Sistema | Como instalar |
| --- | --- |
| macOS (Homebrew) | `brew install node@24` |
| macOS/Linux (nvm) | `nvm install 24 && nvm use 24` |
| Windows | instalador oficial em https://nodejs.org (escolha 24 LTS ou Current) |

> Por que 24+? O projeto roda TypeScript direto (`node src/main.ts`) e usa o
> SQLite embutido do Node (`node:sqlite`). Em versões antigas o Node não entende
> a sintaxe e o erro aparece como `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

## 2. Descompactar e instalar

```bash
unzip hosfera-0.3.0.zip
cd hosfera
npm install
```

No Windows, use o Explorer/PowerShell (`Expand-Archive`) e depois `npm install`
dentro da pasta.

## 3. Verificar o ambiente

```bash
npm run doctor
```

Deve terminar com `ambiente pronto.`. Se reclamar de Node, volte ao passo 1.

## 4. Criar o cenário de demonstração

```bash
npm run seed
```

Saída esperada (o token aparece **uma única vez**):

```
organização criada ...
anúncio publicado no canal mock: MOCK-00001 (60 dias)

── token de acesso (aparece uma única vez) ──
hsk_xxxxxxxxxxxxxxxxxxxxxxxx
no navegador: abra http://127.0.0.1:3000 e cole o token acima.
```

O token também fica salvo em `data/.dev-token` (arquivo local, fora do Git).
**Copie o token** — a tela de login pede ele.

## 5. Subir a aplicação

```bash
npm start
```

Abra **http://127.0.0.1:3000**, cole o token e clique em *Entrar*.

Sem token? Na própria tela de login há o bloco **"Ambiente local: criar
organização demo"** — ele cria outra organização e entra direto.

---

## O que testar (roteiro de 10 minutos)

1. **Calendário** — escolha *Suíte Aurora*. A reserva `DEMO-1001` ocupa três
   noites (daqui a ~40 dias), mostradas em vermelho como *reservado*. Clique em um
   dia livre, mude o preço para `555` e **Aplicar**: a célula atualiza e aparece
   o aviso "... evento(s) no outbox".
2. **Reservas** — a reserva `Hóspede Demo` está lá com total e comissão.
   Clique em **Check-in** (transição válida) e depois tente voltar para
   `pendente` via API: deve dar 400.
3. **Onboarding** — preencha o formulário, crie o imóvel, marque comodidades e
   **envie uma foto** (JPEG/PNG/WebP até 8 MB). A miniatura aparece na hora.
   Depois clique em **Duplicar unidade**: a cópia já vem com tarifa.
4. **Financeiro** — veja bruto, líquido, repasse ao proprietário (70% do líquido)
   e a margem por canal. A reconciliação deve dizer "nada inconsistente".
5. **Canais** — o cartão do Booking mostra *protocolo implementado · homologação
   pendente*. Clique em **Publicar** num rascunho do canal *mock*: recebe id
   externo e 365 dias sincronizados.
6. **Token inválido** — saia e tente entrar com `hsk_invalido`: deve recusar.

## Testes automáticos (opcional)

```bash
npm run check    # doctor + typecheck + 140 testes + smoke 36 verificações
```

`npm run smoke` sobe a API numa porta aleatória, em memória, e percorre o fluxo
completo (publicação, ARI, retry, reserva, cancelamento, onboarding, repasse,
RBAC). Não toca no seu banco.

---

## Problemas comuns

| Sintoma | Causa e solução |
| --- | --- |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node < 24. `node -v` e reinstale. |
| `Cannot find module 'fastify'` | Faltou `npm install` na pasta certa. |
| `EADDRINUSE :::3000` | Porta ocupada: escolha outra com `PORT=8090 npm start` (Windows: `set PORT=8090&& npm start`). A porta vem da variável `PORT` no `.env`. |
| `ExperimentalWarning: SQLite` | Aviso normal do `node:sqlite`. Não é erro. |
| Login recusa o token | O token do seed foi impresso uma vez; use `cat data/.dev-token` ou crie outro em *Ambiente local*. |
| Quero recomeçar do zero | `npm run reset` (apaga `data/`) e rode `npm run seed` de novo. |
| Nada aparece no navegador | Confirme que `npm start` continua rodando no terminal. |

## Onde ficam os dados

```
data/hosfera.db      banco SQLite (apague para recomeçar)
data/uploads/        fotos enviadas (nome = hash do conteúdo)
data/.dev-token      token emitido pelo seed
```

Nada sai da sua máquina: não há serviço externo, telemetria ou chamada de rede
(exceto o Booking, que está desligado por `BOOKING_CERTIFIED=false`).

## Limites desta versão

- Canal **Booking** tem o protocolo pronto, mas está desligado sem homologação.
- Canais reais (Airbnb, Decolar, Expedia, Vrbo, Google) não estão implementados.
- Fotos não são enviadas para os canais; ficam na hosfera.
- Autenticação é por token colado — não há login com e-mail/senha nem SSO.
- Sem envio de e-mail, mensagens de hóspede ou conciliação bancária.
