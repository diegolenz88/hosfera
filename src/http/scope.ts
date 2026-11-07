import type { Db } from '../db/database.ts';
import { getListing, getProperty, getReservation, getUnit } from '../db/repositories.ts';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import type { Listing } from '../domain/types.ts';
import type { UnitRow } from '../db/repositories.ts';

/**
 * Isolamento entre organizações.
 *
 * O `org_id` vem sempre do token. Recurso de outra organização responde 404 (e
 * não 403) para não revelar que o id existe.
 */
export function assertOrg(orgId: string, requested?: string | null): string {
  if (requested && requested !== orgId) throw new ForbiddenError('recurso pertence a outra organização');
  return orgId;
}

export function assertPropertyAccess(db: Db, orgId: string, propertyId: string): void {
  const property = getProperty(db, propertyId);
  if (!property || property.orgId !== orgId) throw new NotFoundError(`imóvel não encontrado: ${propertyId}`);
}

export function assertUnitAccess(db: Db, orgId: string, unitId: string): UnitRow {
  const unit = getUnit(db, unitId);
  if (!unit) throw new NotFoundError(`unidade não encontrada: ${unitId}`);
  const property = getProperty(db, unit.propertyId);
  if (!property || property.orgId !== orgId) throw new NotFoundError(`unidade não encontrada: ${unitId}`);
  return unit;
}

export function assertListingAccess(db: Db, orgId: string, listingId: string): Listing {
  const listing = getListing(db, listingId);
  if (!listing) throw new NotFoundError(`anúncio não encontrado: ${listingId}`);
  assertUnitAccess(db, orgId, listing.unitId);
  return listing;
}

export function assertReservationAccess(db: Db, orgId: string, reservationId: string): void {
  const reservation = getReservation(db, reservationId);
  if (!reservation || reservation.orgId !== orgId) throw new NotFoundError(`reserva não encontrada: ${reservationId}`);
}

export function assertConnectionAccess(db: Db, orgId: string, connectionId: string): void {
  const row = db.prepare('SELECT org_id FROM connections WHERE id = ?').get(connectionId) as { org_id?: string } | undefined;
  if (!row || row.org_id !== orgId) throw new NotFoundError(`conexão não encontrada: ${connectionId}`);
}
