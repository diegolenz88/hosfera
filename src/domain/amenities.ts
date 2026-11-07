/**
 * Catálogo de comodidades.
 *
 * Código estável (usado no banco e na integração com canais) + rótulo humano.
 * Código livre é recusado: comodidade inventada não casa com o filtro do canal.
 */

export interface Amenity {
  code: string;
  label: string;
  /** Grupo para a UI de onboarding. */
  group: 'essencial' | 'conforto' | 'exterior' | 'familia';
}

export const AMENITIES: readonly Amenity[] = [
  { code: 'wifi', label: 'Wi-Fi', group: 'essencial' },
  { code: 'ar_condicionado', label: 'Ar-condicionado', group: 'essencial' },
  { code: 'cozinha', label: 'Cozinha equipada', group: 'essencial' },
  { code: 'estacionamento', label: 'Estacionamento', group: 'essencial' },
  { code: 'agua_quente', label: 'Água quente', group: 'essencial' },
  { code: 'tv', label: 'TV', group: 'conforto' },
  { code: 'maquina_lavar', label: 'Máquina de lavar', group: 'conforto' },
  { code: 'cafe_manha', label: 'Café da manhã', group: 'conforto' },
  { code: 'piscina', label: 'Piscina', group: 'exterior' },
  { code: 'churrasqueira', label: 'Churrasqueira', group: 'exterior' },
  { code: 'vista_mar', label: 'Vista para o mar', group: 'exterior' },
  { code: 'pet_friendly', label: 'Aceita animais', group: 'familia' },
  { code: 'berco', label: 'Berço', group: 'familia' },
  { code: 'acessivel', label: 'Acessível', group: 'familia' },
] as const;

export const AMENITY_CODES = new Set(AMENITIES.map((amenity) => amenity.code));

/** Grafias que aparecem em anúncio real e não são o código canônico. */
const ALIASES: Record<string, string> = {
  wi_fi: 'wifi',
  wifi_gratis: 'wifi',
  internet: 'wifi',
  ar: 'ar_condicionado',
  ar_condicionado_split: 'ar_condicionado',
  estacionamento_gratuito: 'estacionamento',
  maquina_de_lavar: 'maquina_lavar',
  lavanderia: 'maquina_lavar',
  churrasco: 'churrasqueira',
  pet: 'pet_friendly',
  pets: 'pet_friendly',
  bebe: 'berco',
};

export class AmenityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmenityError';
  }
}

/** Normaliza uma lista vinda da API: minúsculas, sem duplicata, só códigos válidos. */
export function normalizeAmenities(codes: unknown): string[] {
  if (codes === undefined || codes === null) return [];
  if (!Array.isArray(codes)) throw new AmenityError('comodidades devem ser uma lista de códigos');

  const normalized = new Set<string>();
  for (const raw of codes) {
    if (typeof raw !== 'string') throw new AmenityError('código de comodidade inválido');
    const cleaned = raw
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s-]+/g, '_');
    if (cleaned === '') continue;
    const code = ALIASES[cleaned] ?? cleaned;
    if (!AMENITY_CODES.has(code)) throw new AmenityError(`comodidade desconhecida: ${raw}`);
    normalized.add(code);
  }
  return [...normalized].sort();
}

export function amenityLabel(code: string): string {
  return AMENITIES.find((amenity) => amenity.code === code)?.label ?? code;
}
