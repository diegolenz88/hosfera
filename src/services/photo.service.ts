import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/database.ts';
import { transaction } from '../db/database.ts';
import {
  deletePhoto,
  getPhoto,
  getUnit,
  insertPhoto,
  listPhotos,
  nextPhotoPosition,
  type UnitRow,
} from '../db/repositories.ts';
import { photoStorageName, validatePhoto, PHOTO_MAX_BYTES } from '../domain/photos.ts';
import { logEvent } from '../db/repositories.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

export interface PhotoServiceOptions {
  storageDir: string;
}

export interface StoredPhoto {
  id: string;
  unitId: string;
  position: number;
  contentType: string;
  bytes: number;
  url: string;
}

/**
 * Guarda a foto no sistema de arquivos com nome derivado do conteúdo.
 *
 * Conteúdo idêntico não duplica arquivo nem registro (índice único por
 * unit + sha256): reenviar a mesma foto do celular é rotina, não erro.
 */
export function storePhoto(
  db: Db,
  options: PhotoServiceOptions,
  input: { orgId: string; unitId: string; dataBase64: string; declaredType?: string },
): StoredPhoto {
  const unit = requireUnitInOrg(db, input.orgId, input.unitId);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.dataBase64, 'base64');
  } catch {
    throw new ValidationError('foto em base64 inválida');
  }
  if (bytes.length === 0) throw new ValidationError('foto vazia');
  if (bytes.length > PHOTO_MAX_BYTES) {
    throw new ValidationError(`foto acima de ${Math.round(PHOTO_MAX_BYTES / 1024 / 1024)} MB`);
  }

  const validation = validatePhoto({ bytes, declaredType: input.declaredType });
  if (!validation.ok) throw new ValidationError(validation.error ?? 'foto inválida');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relative = photoStorageName(sha256, validation.extension ?? 'bin');
  const absolute = join(options.storageDir, relative);
  if (!existsSync(absolute)) {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes, { mode: 0o640 });
  }

  return transaction(db, () => {
    const { photo, created } = insertPhoto(db, {
      unitId: unit.id,
      position: nextPhotoPosition(db, unit.id),
      contentType: validation.contentType ?? 'application/octet-stream',
      bytes: bytes.length,
      sha256,
    });
    if (created) {
      logEvent(db, 'unit', unit.id, 'photo.added', { photoId: photo.id, bytes: bytes.length, contentType: photo.contentType });
    }
    return {
      id: photo.id,
      unitId: photo.unitId,
      position: photo.position,
      contentType: photo.contentType,
      bytes: photo.bytes,
      url: photoUrl(photo.id),
    };
  });
}

export function photoUrl(photoId: string): string {
  return `/v1/photos/${photoId}`;
}

export function readPhoto(db: Db, options: PhotoServiceOptions, photoId: string): { bytes: Buffer; contentType: string; sha256: string } {
  const photo = getPhoto(db, photoId);
  if (!photo) throw new NotFoundError(`foto não encontrada: ${photoId}`);
  const extension = photo.contentType === 'image/png' ? 'png' : photo.contentType === 'image/webp' ? 'webp' : 'jpg';
  const absolute = join(options.storageDir, photoStorageName(photo.sha256, extension));
  if (!existsSync(absolute)) throw new NotFoundError(`arquivo da foto ausente: ${photoId}`);
  return { bytes: readFileSync(absolute), contentType: photo.contentType, sha256: photo.sha256 };
}

export function removePhoto(db: Db, options: PhotoServiceOptions, input: { orgId: string; photoId: string }): void {
  const photo = getPhoto(db, input.photoId);
  if (!photo) throw new NotFoundError(`foto não encontrada: ${input.photoId}`);
  requireUnitInOrg(db, input.orgId, photo.unitId);

  transaction(db, () => {
    deletePhoto(db, photo.id);
    // O arquivo só sai do disco quando nenhuma unidade o referencia (dedupe).
    const stillUsed = db.prepare('SELECT COUNT(*) AS total FROM unit_photos WHERE sha256 = ?').get(photo.sha256) as {
      total: number;
    };
    if (Number(stillUsed.total) === 0) {
      const extension = photo.contentType === 'image/png' ? 'png' : photo.contentType === 'image/webp' ? 'webp' : 'jpg';
      const absolute = join(options.storageDir, photoStorageName(photo.sha256, extension));
      if (existsSync(absolute)) unlinkSync(absolute);
    }
    logEvent(db, 'unit', photo.unitId, 'photo.removed', { photoId: photo.id });
  });
}

export function listUnitPhotos(db: Db, orgId: string, unitId: string): StoredPhoto[] {
  requireUnitInOrg(db, orgId, unitId);
  return listPhotos(db, unitId).map((photo) => ({
    id: photo.id,
    unitId: photo.unitId,
    position: photo.position,
    contentType: photo.contentType,
    bytes: photo.bytes,
    url: photoUrl(photo.id),
  }));
}

export function requireUnitInOrg(db: Db, orgId: string, unitId: string): UnitRow {
  const unit = getUnit(db, unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${unitId}`);
  const row = db.prepare('SELECT org_id FROM properties WHERE id = ?').get(unit.propertyId) as { org_id?: string } | undefined;
  if (!row || row.org_id !== orgId) throw new NotFoundError(`unidade não encontrada: ${unitId}`);
  return unit;
}
