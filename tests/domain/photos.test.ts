import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { photoStorageName, validatePhoto, PHOTO_MAX_BYTES } from '../../src/domain/photos.ts';
import { normalizeAmenities, AmenityError } from '../../src/domain/amenities.ts';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

test('tipo é decidido pelo conteúdo, não pelo que o cliente declara', () => {
  assert.equal(validatePhoto({ bytes: jpeg }).contentType, 'image/jpeg');
  assert.equal(validatePhoto({ bytes: png }).contentType, 'image/png');
  assert.equal(validatePhoto({ bytes: webp }).contentType, 'image/webp');
});

test('extensão declarada divergente do conteúdo é recusada', () => {
  const result = validatePhoto({ bytes: png, declaredType: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /não confere/);
});

test('formato não suportado é recusado com mensagem útil', () => {
  const result = validatePhoto({ bytes: gif });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /JPEG, PNG ou WebP/);
});

test('arquivo vazio e arquivo acima do limite são recusados', () => {
  assert.equal(validatePhoto({ bytes: new Uint8Array() }).ok, false);
  const huge = new Uint8Array(PHOTO_MAX_BYTES + 1);
  huge.set(jpeg);
  const result = validatePhoto({ bytes: huge });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /limite/);
});

test('nome de armazenamento é derivado do hash (conteúdo igual não duplica)', () => {
  const name = photoStorageName('abcdef0123456789', 'png');
  assert.equal(name, 'ab/abcdef0123456789.png');
  assert.equal(photoStorageName('abcdef0123456789', 'png'), name);
});

test('comodidades são normalizadas, sem duplicata e ordenadas', () => {
  assert.deepEqual(normalizeAmenities(['Wi-Fi', 'piscina', 'wifi', 'Ar-Condicionado']), [
    'ar_condicionado',
    'piscina',
    'wifi',
  ]);
});

test('comodidade inventada é recusada', () => {
  assert.throws(() => normalizeAmenities(['helicoptero']), AmenityError);
  assert.throws(() => normalizeAmenities('wifi'), AmenityError);
});

test('lista vazia ou ausente vira array vazio', () => {
  assert.deepEqual(normalizeAmenities(undefined), []);
  assert.deepEqual(normalizeAmenities([]), []);
});
