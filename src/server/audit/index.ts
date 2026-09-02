import 'server-only';

import { getDbTx, schema } from '@/db';
import { getRequestContext } from '@/lib/logging';
import { redact } from '@/lib/logging';

import type { PoolDatabase } from '@/db';
import type { AuditAction, AuditEvent } from '@/db/schema';

/**
 * Audit write API — LL-021.
 *
 * The audit row for a financial action must commit or roll back WITH that
 * action, or the log describes something that never happened. So the default
 * and intended path takes the caller's transaction:
 *
 *   await getDbTx().transaction(async (tx) => {
 *     const account = await tx.insert(...).returning();
 *     await recordAuditEvent({ tx, ... });   // same tx — atomic with the insert
 *   });
 *
 * Calling it WITHOUT a tx opens its own single-statement transaction, which is
 * correct only for a standalone event with no accompanying state change. When
 * an action and its audit belong together, they MUST share a tx.
 */

export interface AuditEventInput {
  /** The transaction the audited action runs in. Omit ONLY for a standalone event. */
  readonly tx?: Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];
  readonly companyId: string;
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  /** Redacted before write — never store a raw secret. */
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * The redactor is the SAME one the logger uses (LL-004), so an audit payload and
 * a log line can never disagree about what counts as a secret. JSON is redacted
 * even though the entity "shouldn't" carry secrets — the entities being audited
 * will eventually include EIN and similar, and the log must be safe by default.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
  const executor = input.tx ?? getDbTx();

  const rows = await executor
    .insert(schema.auditEvents)
    .values({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeJson: input.before === undefined ? null : redact(input.before),
      afterJson: input.after === undefined ? null : redact(input.after),
      // Captured automatically from the request context (LL-004) — no caller
      // needs to thread it through.
      requestId: getRequestContext()?.requestId ?? null,
    })
    .returning();

  const event = rows[0];
  if (event === undefined) throw new Error('audit event insert returned no row');
  return event;
}
