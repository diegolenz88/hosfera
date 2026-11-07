/**
 * Validação de foto de imóvel.
 *
 * O tipo declarado pelo cliente não é confiável: decidimos pelos magic bytes.
 * Um `.jpg` renomeado para `image/png` seria servido com content-type errado e,
 * pior, abriria caminho para conteúdo ativo disfarçado de imagem.
 */

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

interface Signature {
  contentType: string;
  extension: string;
  matches: (bytes: Uint8Array) => boolean;
}

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const SIGNATURES: readonly Signature[] = [
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (b) => b.length > 8 && b[0] === 0x89 && ascii(b, 1, 'PNG'),
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    // RIFF....WEBP
    matches: (b) => b.length > 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  },
];

export interface PhotoValidation {
  ok: boolean;
  contentType?: string;
  extension?: string;
  error?: string;
}

export function validatePhoto(input: { bytes: Uint8Array; declaredType?: string }): PhotoValidation {
  const { bytes } = input;
  if (bytes.length === 0) return { ok: false, error: 'arquivo vazio' };
  if (bytes.length > PHOTO_MAX_BYTES) {
    return { ok: false, error: `foto acima do limite de ${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} MB` };
  }

  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (!signature) return { ok: false, error: 'formato não suportado (use JPEG, PNG ou WebP)' };

  if (input.declaredType && input.declaredType !== signature.contentType) {
    return {
      ok: false,
      error: `tipo declarado (${input.declaredType}) não confere com o conteúdo (${signature.contentType})`,
    };
  }

  return { ok: true, contentType: signature.contentType, extension: signature.extension };
}

/** Nome de arquivo determinístico: conteúdo igual não duplica armazenamento. */
export function photoStorageName(sha256: string, extension: string): string {
  return `${sha256.slice(0, 2)}/${sha256}.${extension}`;
}
