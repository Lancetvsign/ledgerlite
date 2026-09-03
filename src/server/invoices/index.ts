import 'server-only';

import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';

import { InvoiceError } from './errors';

import type { PoolDatabase } from '@/db';
import type { Invoice, InvoiceLine } from '@/db/schema';
import type { CreateInvoiceInput, InvoiceLineInput, UpdateInvoiceInput } from '@/validation/invoice';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Invoice service — LL-041 (Accounts Receivable). Draft lifecycle only; finalize,
 * posting to the ledger, and void arrive in LL-042.
 *
 * Every operation is company-scoped and authorization-gated (AGENTS §6). Totals
 * (subtotal / tax / total) are ALWAYS recomputed from the lines with decimal.js
 * and stored (ADR-013) — no input carries a total. Money is a string at every
 * boundary and a `Decimal` only in computation (ADR-004). Tenancy is structural:
 * the customer and every line account are re-validated to be in this company, and
 * the composite FKs make a cross-tenant reference impossible even if that check
 * were wrong.
 */

export interface InvoiceWithLines {
  readonly invoice: Invoice;
  readonly lines: InvoiceLine[];
}

interface Totals {
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
}

/**
 * The one place invoice money is computed. Per line: amount = quantity × unit
 * price, tax = amount × rate ÷ 100, each rounded to NUMERIC(19,4) (ROUND_HALF_EVEN,
 * ADR-004). Totals are the sums. Pure — no I/O, exercised directly in tests.
 */
export function computeInvoiceTotals(
  lines: readonly { readonly quantity: string; readonly unitPrice: string; readonly taxRate: string }[],
): Totals {
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (const line of lines) {
    const amount = toMoney(line.quantity).times(toMoney(line.unitPrice)).toDecimalPlaces(4);
    const tax = amount.times(toMoney(line.taxRate)).dividedBy(100).toDecimalPlaces(4);
    subtotal = subtotal.plus(amount);
    taxTotal = taxTotal.plus(tax);
  }
  return {
    subtotal: subtotal.toFixed(4),
    taxTotal: taxTotal.toFixed(4),
    total: subtotal.plus(taxTotal).toFixed(4),
  };
}

/** Confirms the customer and every referenced account live in THIS company. */
async function validateReferences(
  tx: Tx,
  companyId: string,
  customerId: string,
  lines: readonly InvoiceLineInput[],
): Promise<void> {
  const customer = await tx
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
    .limit(1);
  if (customer[0] === undefined) {
    throw new InvoiceError('CUSTOMER_NOT_FOUND', 'That customer does not exist in this company.');
  }

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const found = await tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), inArray(schema.accounts.id, accountIds)));
  const foundIds = new Set(found.map((a) => a.id));
  for (const id of accountIds) {
    if (!foundIds.has(id)) {
      throw new InvoiceError('ACCOUNT_NOT_FOUND', 'A line references an account not in this company.');
    }
  }
}

async function insertLines(
  tx: Tx,
  companyId: string,
  invoiceId: string,
  lines: readonly InvoiceLineInput[],
): Promise<void> {
  await tx.insert(schema.invoiceLines).values(
    lines.map((line, index) => ({
      invoiceId,
      companyId,
      lineNumber: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxRate: line.taxRate,
    })),
  );
}

export async function createInvoice(
  actorUserId: string,
  companyId: string,
  input: CreateInvoiceInput,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.create');
  const totals = computeInvoiceTotals(input.lines);

  return await getDbTx().transaction(async (tx) => {
    await validateReferences(tx, companyId, input.customerId, input.lines);

    const rows = await tx
      .insert(schema.invoices)
      .values({
        companyId,
        customerId: input.customerId,
        status: 'DRAFT',
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        memo: input.memo,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdBy: actorUserId,
      })
      .returning();
    const invoice = rows[0];
    if (invoice === undefined) throw new Error('invoice insert returned no row');

    await insertLines(tx, companyId, invoice.id, input.lines);
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_CREATED',
      entityType: 'invoice',
      entityId: invoice.id,
      after: { status: 'DRAFT', total: totals.total, lineCount: input.lines.length },
    });
    return await loadInvoice(tx, companyId, invoice.id);
  });
}

export async function updateInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.create');
  const totals = computeInvoiceTotals(input.lines);

  return await getDbTx().transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
      .limit(1);
    const invoice = existing[0];
    if (invoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
    if (invoice.status !== 'DRAFT') {
      throw new InvoiceError('INVOICE_NOT_DRAFT', 'Only a draft invoice can be edited.');
    }

    await validateReferences(tx, companyId, input.customerId, input.lines);

    // Wholesale replace: header fields, then delete-and-reinsert the lines.
    await tx
      .update(schema.invoices)
      .set({
        customerId: input.customerId,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
    await insertLines(tx, companyId, invoiceId, input.lines);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_UPDATED',
      entityType: 'invoice',
      entityId: invoiceId,
      before: { total: invoice.total },
      after: { total: totals.total, lineCount: input.lines.length },
    });
    return await loadInvoice(tx, companyId, invoiceId);
  });
}

export async function getInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWithLines | null> {
  await requirePermission(actorUserId, companyId, 'invoice.view');
  const rows = await getDbTx()
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  if (rows[0] === undefined) return null; // cross-company id reads as a genuine miss
  return await loadInvoice(getDbTx(), companyId, invoiceId);
}

/** Company-scoped listing (headers + stored totals). `invoice.view`. */
export async function listInvoices(actorUserId: string, companyId: string): Promise<Invoice[]> {
  await requirePermission(actorUserId, companyId, 'invoice.view');
  return await getDbTx()
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.companyId, companyId))
    .orderBy(schema.invoices.invoiceDate, schema.invoices.createdAt);
}

async function loadInvoice(
  tx: Tx | PoolDatabase,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWithLines> {
  const invoiceRows = await tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  const invoice = invoiceRows[0];
  if (invoice === undefined) throw new Error('invoice vanished');
  const lines = await tx
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(schema.invoiceLines.lineNumber);
  return { invoice, lines };
}

export { InvoiceError } from './errors';
export type { InvoiceErrorCode } from './errors';
