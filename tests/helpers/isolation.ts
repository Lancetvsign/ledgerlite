/**
 * The tenant-isolation contract — LL-014.
 *
 * Release-blocking for the life of the product. Every company-scoped entity
 * registers a descriptor here; the harness then attacks it uniformly as a user
 * with NO membership in the victim company and requires every attempt to fail
 * — and to fail CORRECTLY IN KIND. An empty list and a 500 are both
 * "failures", but only one of them is right: a denial must be the uniform
 * AuthorizationDenied, and a scoped listing must be provably empty rather than
 * erroring.
 *
 * Completeness is enforced structurally, not by convention: a test introspects
 * information_schema for tables carrying a company_id column and fails if any
 * lacks a registered descriptor. Adding a tenant-owned table in a later ticket
 * without isolation coverage does not slip through review — it fails CI.
 */
import { AuthorizationDenied } from '@/server/authorization';

export interface IsolationContext {
  /** The victim: Company A and its owner. */
  readonly companyId: string;
  readonly ownerUserId: string;
}

export type AttackOutcome = 'denied' | 'empty';

export interface IsolationAttempt {
  /** e.g. 'read by direct id', 'list', 'update', 'deactivate' */
  readonly operation: string;
  /** What a CORRECT failure looks like for this operation. */
  readonly expect: AttackOutcome;
  /**
   * Execute the operation as the attacker, THROUGH THE FRONT DOOR — the same
   * authorize-then-query path application code uses. Returns the result for
   * 'empty' expectations; throws AuthorizationDenied for 'denied' ones.
   */
  run(attackerUserId: string, victim: IsolationContext, recordId: string): Promise<unknown>;
}

export interface IsolationDescriptor {
  /** The table name, exactly as in information_schema — completeness keys on it. */
  readonly table: string;
  /** Create one representative record in the victim company; return its id. */
  seed(victim: IsolationContext): Promise<{ recordId: string }>;
  readonly attempts: readonly IsolationAttempt[];
}

export interface AttackResult {
  readonly table: string;
  readonly operation: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Run one descriptor's full attack set; every attempt must fail correctly. */
export async function attack(
  descriptor: IsolationDescriptor,
  attackerUserId: string,
  victim: IsolationContext,
): Promise<AttackResult[]> {
  const { recordId } = await descriptor.seed(victim);
  const results: AttackResult[] = [];

  for (const attempt of descriptor.attempts) {
    let result: AttackResult;
    try {
      const value = await attempt.run(attackerUserId, victim, recordId);
      if (attempt.expect === 'empty') {
        const emptiness =
          value === null ||
          value === undefined ||
          (Array.isArray(value) && value.length === 0);
        result = emptiness
          ? { table: descriptor.table, operation: attempt.operation, ok: true, detail: 'empty' }
          : {
              table: descriptor.table,
              operation: attempt.operation,
              ok: false,
              detail: `LEAKED: got ${JSON.stringify(value).slice(0, 120)}`,
            };
      } else {
        result = {
          table: descriptor.table,
          operation: attempt.operation,
          ok: false,
          detail: 'GRANTED: expected denial but the call succeeded',
        };
      }
    } catch (error) {
      if (attempt.expect === 'denied' && error instanceof AuthorizationDenied) {
        result = { table: descriptor.table, operation: attempt.operation, ok: true, detail: 'denied' };
      } else {
        // Wrong KIND of failure — a raw driver error is not a denial.
        result = {
          table: descriptor.table,
          operation: attempt.operation,
          ok: false,
          detail: `WRONG FAILURE KIND: ${error instanceof Error ? error.name : typeof error}`,
        };
      }
    }
    results.push(result);
  }
  return results;
}
