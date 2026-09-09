import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';

import { VendorError } from './errors';

import type { Vendor } from '@/db/schema';
import type { CreateVendorInput, UpdateVendorInput } from '@/validation/vendor';

/**
 * Vendor service — LL-060. The party a bill owes (Accounts Payable) — the mirror
 * of the customer service (LL-040).
 *
 * Every operation is company-scoped and passes through the LL-013 authorization
 * layer first (AGENTS §6). There is NO hard-delete path (ADR-006): vendors are
 * deactivated, never removed, and every mutation records an audit event inside its
 * own transaction so a rolled-back change leaves no audit row.
 *
 * Cross-company safety is structural, not remembered here: `journal_lines`
 * reference vendors through a composite `(company_id, vendor_id)` FK, so a line
 * can never point at another tenant's vendor (LL-060 migration).
 */

/**
 * The allow-list of vendor fields the audit log records (LL-069, AGENTS §9).
 *
 * The audit answers "who changed this vendor's identity or status, and when" — it is
 * NOT a copy of every contact field. The free-text fields (`email`, `phone`,
 * `address`, `notes`) can hold data §9 forbids in the log: a user may type a remit-to
 * bank account / routing number into `notes`, and `redact()` cannot reliably spot a
 * bare account number in prose (only credential-SHAPED values, or sensitive KEYS).
 * So this is default-deny — only these fields are ever audited; adding a field here is
 * a deliberate decision to log it. Mirrors the customer service (parity, A/R ⇔ A/P).
 */
function auditView(v: Vendor): Pick<Vendor, 'id' | 'name' | 'vendorNumber' | 'status'> {
  return { id: v.id, name: v.name, vendorNumber: v.vendorNumber, status: v.status };
}

async function loadInCompany(companyId: string, vendorId: string): Promise<Vendor | undefined> {
  const rows = await getDbTx()
    .select()
    .from(schema.vendors)
    .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, vendorId)))
    .limit(1);
  return rows[0];
}

export async function createVendor(
  actorUserId: string,
  companyId: string,
  input: CreateVendorInput,
): Promise<Vendor> {
  await requirePermission(actorUserId, companyId, 'vendor.manage');

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .insert(schema.vendors)
        .values({
          companyId,
          name: input.name,
          vendorNumber: input.vendorNumber,
          email: input.email,
          phone: input.phone,
          address: input.address,
          notes: input.notes,
        })
        .returning();
      const vendor = rows[0];
      if (vendor === undefined) throw new Error('vendor insert returned no row');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'VENDOR_CREATED',
        entityType: 'vendor',
        entityId: vendor.id,
        after: auditView(vendor),
      });
      return vendor;
    });
  } catch (error) {
    throw toDomainError(error);
  }
}

export async function updateVendor(
  actorUserId: string,
  companyId: string,
  vendorId: string,
  input: UpdateVendorInput,
): Promise<Vendor> {
  await requirePermission(actorUserId, companyId, 'vendor.manage');

  const existing = await loadInCompany(companyId, vendorId);
  if (existing === undefined) {
    throw new VendorError('VENDOR_NOT_FOUND', 'Vendor not found.');
  }

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .update(schema.vendors)
        .set({ ...input, updatedAt: sql`now()` })
        .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, vendorId)))
        .returning();
      const vendor = rows[0];
      if (vendor === undefined) throw new VendorError('VENDOR_NOT_FOUND', 'Vendor not found.');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'VENDOR_UPDATED',
        entityType: 'vendor',
        entityId: vendor.id,
        before: auditView(existing),
        after: auditView(vendor),
      });
      return vendor;
    });
  } catch (error) {
    throw toDomainError(error);
  }
}

/**
 * Deactivates a vendor. The ONLY removal-shaped operation — there is no hard
 * delete (ADR-006). An inactive vendor stays queryable for history and for the
 * bills that already reference it.
 */
export async function deactivateVendor(
  actorUserId: string,
  companyId: string,
  vendorId: string,
): Promise<Vendor> {
  await requirePermission(actorUserId, companyId, 'vendor.manage');

  const existing = await loadInCompany(companyId, vendorId);
  if (existing === undefined) {
    throw new VendorError('VENDOR_NOT_FOUND', 'Vendor not found.');
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .update(schema.vendors)
      .set({ status: 'INACTIVE', updatedAt: sql`now()` })
      .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, vendorId)))
      .returning();
    const vendor = rows[0];
    if (vendor === undefined) throw new VendorError('VENDOR_NOT_FOUND', 'Vendor not found.');
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'VENDOR_DEACTIVATED',
      entityType: 'vendor',
      entityId: vendor.id,
      before: auditView(existing),
      after: auditView(vendor),
    });
    return vendor;
  });
}

/** Company-scoped listing. `vendor.view` capability. Includes inactive by default. */
export async function listVendors(actorUserId: string, companyId: string): Promise<Vendor[]> {
  await requirePermission(actorUserId, companyId, 'vendor.view');
  return await getDbTx()
    .select()
    .from(schema.vendors)
    .where(eq(schema.vendors.companyId, companyId))
    .orderBy(schema.vendors.name);
}

/**
 * Drizzle carries the constraint name on the CAUSE chain, not the top-level
 * message — so matching `error.message` silently misses it (a lesson this codebase
 * keeps relearning). Walk the chain.
 */
function toDomainError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let text = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    text += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  if (/vendors_company_number_unique/.test(text)) {
    return new VendorError('DUPLICATE_VENDOR_NUMBER', 'That vendor number is already in use.');
  }
  return error;
}

export { VendorError } from './errors';
export type { VendorErrorCode } from './errors';
