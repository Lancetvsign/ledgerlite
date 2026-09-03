import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';

import { CustomerError } from './errors';

import type { Customer } from '@/db/schema';
import type { CreateCustomerInput, UpdateCustomerInput } from '@/validation/customer';

/**
 * Customer service — LL-040. The party an invoice bills.
 *
 * Every operation is company-scoped and passes through the LL-013 authorization
 * layer first (AGENTS §6). There is NO hard-delete path (ADR-006): customers are
 * deactivated, never removed, and every mutation records an audit event inside
 * its own transaction so a rolled-back change leaves no audit row.
 *
 * Cross-company safety is structural, not remembered here: `journal_lines`
 * reference customers through a composite `(company_id, customer_id)` FK, so a
 * line can never point at another tenant's customer (migration 0012).
 */

async function loadInCompany(companyId: string, customerId: string): Promise<Customer | undefined> {
  const rows = await getDbTx()
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
    .limit(1);
  return rows[0];
}

export async function createCustomer(
  actorUserId: string,
  companyId: string,
  input: CreateCustomerInput,
): Promise<Customer> {
  await requirePermission(actorUserId, companyId, 'customer.manage');

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .insert(schema.customers)
        .values({
          companyId,
          name: input.name,
          customerNumber: input.customerNumber,
          email: input.email,
          phone: input.phone,
          billingAddress: input.billingAddress,
          notes: input.notes,
        })
        .returning();
      const customer = rows[0];
      if (customer === undefined) throw new Error('customer insert returned no row');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'CUSTOMER_CREATED',
        entityType: 'customer',
        entityId: customer.id,
        after: customer,
      });
      return customer;
    });
  } catch (error) {
    throw toDomainError(error);
  }
}

export async function updateCustomer(
  actorUserId: string,
  companyId: string,
  customerId: string,
  input: UpdateCustomerInput,
): Promise<Customer> {
  await requirePermission(actorUserId, companyId, 'customer.manage');

  const existing = await loadInCompany(companyId, customerId);
  if (existing === undefined) {
    throw new CustomerError('CUSTOMER_NOT_FOUND', 'Customer not found.');
  }

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .update(schema.customers)
        .set({ ...input, updatedAt: sql`now()` })
        .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
        .returning();
      const customer = rows[0];
      if (customer === undefined) throw new CustomerError('CUSTOMER_NOT_FOUND', 'Customer not found.');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'CUSTOMER_UPDATED',
        entityType: 'customer',
        entityId: customer.id,
        before: existing,
        after: customer,
      });
      return customer;
    });
  } catch (error) {
    throw toDomainError(error);
  }
}

/**
 * Deactivates a customer. The ONLY removal-shaped operation — there is no hard
 * delete (ADR-006). An inactive customer stays queryable for history and for the
 * invoices that already reference it.
 */
export async function deactivateCustomer(
  actorUserId: string,
  companyId: string,
  customerId: string,
): Promise<Customer> {
  await requirePermission(actorUserId, companyId, 'customer.manage');

  const existing = await loadInCompany(companyId, customerId);
  if (existing === undefined) {
    throw new CustomerError('CUSTOMER_NOT_FOUND', 'Customer not found.');
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .update(schema.customers)
      .set({ status: 'INACTIVE', updatedAt: sql`now()` })
      .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
      .returning();
    const customer = rows[0];
    if (customer === undefined) throw new CustomerError('CUSTOMER_NOT_FOUND', 'Customer not found.');
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'CUSTOMER_DEACTIVATED',
      entityType: 'customer',
      entityId: customer.id,
      before: existing,
      after: customer,
    });
    return customer;
  });
}

/** Company-scoped listing. `customer.view` capability. Includes inactive by default. */
export async function listCustomers(actorUserId: string, companyId: string): Promise<Customer[]> {
  await requirePermission(actorUserId, companyId, 'customer.view');
  return await getDbTx()
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.companyId, companyId))
    .orderBy(schema.customers.name);
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
  if (/customers_company_number_unique/.test(text)) {
    return new CustomerError('DUPLICATE_CUSTOMER_NUMBER', 'That customer number is already in use.');
  }
  return error;
}

export { CustomerError } from './errors';
export type { CustomerErrorCode } from './errors';
