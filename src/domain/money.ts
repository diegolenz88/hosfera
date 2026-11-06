/** Dinheiro em centavos: inteiros, nunca float. */

export function brl(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}R$ ${reais.toLocaleString('pt-BR')},${rest}`;
}

export function fromReais(value: number): number {
  if (!Number.isFinite(value)) throw new Error('valor monetário inválido');
  return Math.round(value * 100);
}

/** Aplica percentual inteiro (ex.: 25 = +25%) arredondando para o centavo. */
export function applyPct(cents: number, pct: number): number {
  return Math.round((cents * (100 + pct)) / 100);
}

export function splitCommission(totalCents: number, commissionPct: number): number {
  if (commissionPct < 0 || commissionPct > 100) throw new Error('comissão fora de faixa');
  return Math.round((totalCents * commissionPct) / 100);
}
