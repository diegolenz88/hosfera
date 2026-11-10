# ADR 0009 — iCal como primeira integração real

**Status:** aceito · **Data:** 2026-11-11

## Contexto

Os canais prioritários (Booking, Airbnb, Decolar, Expedia/Vrbo, Google) exigem
programa de parceiro: contrato, certificação e, no caso do Booking, fila de
homologação fechada para novos provedores. Enquanto isso não destrava, o produto
ficava sem nenhuma integração — e uma agenda que não conversa com o canal vende
a mesma noite duas vezes, que é o erro mais caro do setor.

## Decisão

Implementar **sincronização por iCal** antes de qualquer protocolo proprietário.

- **Importação**: cada anúncio que o canal exporta como `.ics` (Airbnb, Booking,
  Vrbo, Google) vira bloqueio na unidade. Reserva feita no canal fecha a noite aqui.
- **Exportação**: cada unidade tem um feed público `/v1/ical/<token>.ics` que o
  canal assina ao cadastrar "importar calendário". O feed entrega apenas noites
  ocupadas — nunca hóspede, valor ou documento.
- **Modelo**: evento importado é `Block`, não `Reservation`. Ele não tem hóspede,
  valor nem comissão; aparecer no financeiro e no repasse seria dado falso.

### Detalhes que sustentam o funcionamento

| Decisão | Por que |
| --- | --- |
| `DTEND` é exclusivo | É o padrão do iCal e o mesmo do domínio: 20→23 = 3 noites. Tratar como inclusivo criaria uma noite fantasma a cada reserva. |
| `UID` como chave, índice único `(unit, source, uid)` | Reimportar o mesmo feed é rotina (a cada hora). Sem isso, o calendário viraria uma pilha de duplicatas. |
| Evento ausente do feed é removido | Cancelamento no canal precisa liberar a noite; senão o inventário encolhe para sempre. |
| Evento sem `DTEND`, ou `DTEND` igual ao início, ocupa 1 noite | É o que os canais fazem com diária única. |
| Data decidida pelo calendário local (`TZID`), não pelo instante UTC | Reserva das 15h em São Paulo não pode cair no dia anterior. |
| Falha de rede preserva os bloqueios existentes | Agenda fechada com o último dado conhecido é melhor que agenda aberta por erro de rede. Erro fica registrado na fonte e visível na tela. |
| Bloqueio importado **não** é reexportado | Devolver ao feed de origem criaria eco; com dois canais, um loop de bloqueios. |
| Token de feed é opaco e por unidade | O canal precisa de um endereço estável sem credencial de usuário; o token não dá acesso a mais nada. |

## Consequências

- Overbooking deixa de ser possível entre hosfera e qualquer canal que exporte
  iCal — sem contrato, sem certificação.
- A granularidade é de **dia**, não de hora: iCal não informa horário de
  check-in, então o bloqueio cobre a noite inteira. Para inventário por período
  (day-use, meia-diária) o caminho é o protocolo do canal.
- Sincronização é sob demanda (`POST /v1/ical-sources/:id/sync`); agendar de hora
  em hora é trabalho de operação, não de código novo.
- Quando a homologação do Booking sair (ADR 0007), os dois caminhos coexistem:
  o protocolo dá disponibilidade e tarifa em tempo real; o iCal continua como
  rede de segurança e para os canais sem API aberta.
- Próximo passo natural: sincronizar também **tarifa** e **mínimo de noites**,
  que iCal não transporta — isso só existe no protocolo do canal.
