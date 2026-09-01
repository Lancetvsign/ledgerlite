import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context, carried implicitly so every log line from a request can
 * be tied together without threading a logger through every function signature.
 *
 * Explicit threading is the alternative, and it fails in exactly the place it
 * matters: deep inside LedgerService, several layers below the route handler,
 * where the interesting failures happen and where nobody wants to add a
 * parameter to six functions to get a correlation id.
 *
 * Requires the Node runtime. Financial paths already declare
 * `export const runtime = 'nodejs'` for the Pool client (ADR-001).
 */
export interface RequestContext {
  /** Ties every line from one request together. */
  readonly requestId: string;
  /** Present once authentication lands (LL-010). */
  readonly userId?: string;
  /** Present once company context lands (LL-013). Never trusted for authorization. */
  readonly companyId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with the given context attached to every log line it produces. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Add fields to the current context, e.g. attaching userId after authentication
 * resolves. Returns a new context rather than mutating the stored one.
 */
export function withAdditionalContext<T>(extra: Partial<RequestContext>, fn: () => T): T {
  const current = storage.getStore();
  const requestId = extra.requestId ?? current?.requestId ?? newRequestId();
  const merged: RequestContext = { ...current, ...extra, requestId };
  return storage.run(merged, fn);
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
