/**
 * Camada XML mínima para mensagens OTA 2003B.
 *
 * Não é um parser genérico: existe para que os builders e leitores falhem de
 * forma previsível quando o canal mudar o payload. Toda string que vai para o
 * XML passa por `escapeXml` — nome de hóspede com `&` não pode derrubar a
 * mensagem inteira.
 */
import { XMLParser } from 'fast-xml-parser';

const OTA_NS = 'http://www.opentravel.org/OTA/2003/05';

export const OTA_NAMESPACE = OTA_NS;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Atributos a partir de um objeto, omitindo `undefined` e escapando valores. */
export function attrs(map: Record<string, string | number | undefined | null>): string {
  return Object.entries(map)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(' ');
}

export function xmlDeclaration(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>';
}

/** Declaração + elemento raiz OTA com namespace, versão e EchoToken. */
export function otaRoot(tag: string, echoToken: string, timestamp: string, inner: string): string {
  return `${xmlDeclaration()}
<${tag} xmlns="${OTA_NS}" EchoToken="${escapeXml(echoToken)}" TimeStamp="${escapeXml(timestamp)}" Version="1.0">
${inner}
</${tag}>`;
}

/** Bloco POS/RequestorID obrigatório em toda mensagem enviada ao Booking. */
export function posBlock(machineAccount: string): string {
  return `  <POS>
    <Source>
      <RequestorID Type="1" ID="${escapeXml(machineAccount)}"/>
    </Source>
  </POS>`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

export type XmlNode = Record<string, unknown>;

export function parseXml(xml: string): XmlNode {
  const parsed = parser.parse(xml) as XmlNode;
  return parsed;
}

/** O parser devolve objeto para 1 elemento e array para N — normalize aqui. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function node(value: unknown): XmlNode | null {
  return value && typeof value === 'object' ? (value as XmlNode) : null;
}

export function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const obj = node(value);
  if (obj && '#text' in obj) return String(obj['#text']);
  return null;
}

export function attr(value: unknown, name: string): string | null {
  const obj = node(value);
  if (!obj) return null;
  const raw = obj[`@_${name}`];
  return raw === undefined || raw === null ? null : String(raw);
}

/** Dinheiro OTA vem como decimal com ponto ("1350.00") — converte para centavos. */
export function amountToCents(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/** Centavos → decimal com duas casas, como o Booking espera. */
export function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
