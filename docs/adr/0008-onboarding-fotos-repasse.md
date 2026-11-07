# ADR 0008 — Onboarding, fotos e repasse

**Status:** aceito · **Data:** 2026-11-06

## Contexto

Três lacunas impediam operar sem suporte: cadastrar imóvel com foto e comodidade,
repassar ao proprietário, e descobrir inconsistência antes do fechamento do mês.
Cada uma tem uma decisão de modelagem que, se errada, volta como retrabalho caro.

## Decisão

### Fotos: arquivo fora do banco, endereçado por hash

- Bytes vão para o disco (`UPLOAD_DIR`), nome derivado do `sha256` do conteúdo.
- O banco guarda metadados (`unit_photos`) com índice único `(unit_id, sha256)`.
- Tipagem por **magic bytes**, não pelo `content-type` declarado: um `.exe`
  renomeado para `image/png` é recusado com 4xx, não servido.
- Leitura exige token na query (`/v1/photos/:id?t=...`) porque `<img src>` não
  envia header. O id é UUID; sem token, 401.
- Remover a foto só apaga o arquivo quando nenhuma outra unidade referencia o
  mesmo hash.

**Por que não `BLOB` no banco:** backup do banco passaria a pesar gigabytes e
cada leitura de imagem disputaria o mesmo pool de conexões da API.

### Onboarding: transação única, tarifa obrigatória

`POST /v1/onboarding` cria imóvel + unidades + tarifa + comodidades em uma
transação. Unidade sem tarifa **não existe**: é o anúncio que nunca vende, e o
erro mais comum ao cadastrar a segunda unidade. `duplicateUnit` copia tarifas e
comodidades pela mesma razão.

### Repasse: percentual sobre o líquido

`ownerPayable = round((bruto − comissão do canal) × ownerSharePct / 100)`.

Calcular sobre o bruto pagaria a comissão da OTA ao proprietário e comeria a
margem da administradora. O cálculo é função pura (`domain/finance.ts`) com
teste que fixa a diferença: 70% de 114.750 = 80.325; sobre o bruto daria 94.500.

Financeiro **não arredonda**: a UI usa `brlExact` (duas casas). Centavo perdido em
repasse vira disputa com proprietário.

### Reconciliação: checagens puras, severidade explícita

`reconcile()` recebe reservas, anúncios e ids com lançamento e devolve issues
com `critical`/`warning`:

| Checagem | Severidade | Por que importa |
| --- | --- | --- |
| duas reservas ativas na mesma unidade | crítica | overbooking já aconteceu |
| anúncio publicado sem id externo | crítica | canal não sabe o que vender |
| comissão maior que o total | crítica | erro de payload/integração |
| reserva sem lançamento financeiro | aviso | fecha o mês faltando receita |
| total zero em reserva confirmada | aviso | webhook parcial |

O recorte é por check-in no período — o que o proprietário reconhece como "as
estadias do mês", não a data de pagamento.

## Consequências

- Migração para S3/Cloudflare R2 é trocar a implementação de `storePhoto`/`readPhoto`;
  o hash já é a chave.
- `unit_amenities` usa código estável com catálogo fechado: comodidade inventada é
  recusada (400) para não quebrar filtro de canal depois.
- Reconciliação é idempotente e só lê — pode rodar em cron horário sem efeito colateral.
- Fica em aberto: replicação das fotos para os canais (Content API do Booking,
  upload do Airbnb) e revisão de qualidade/ordem das fotos pelo operador.
