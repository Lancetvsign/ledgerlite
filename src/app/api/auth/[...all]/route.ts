import { getAuth } from '@/lib/auth';
import { log, newRequestId, withRequestContext } from '@/lib/logging';

/**
 * All Better Auth endpoints: sign-up, sign-in, sign-out, session.
 *
 * Node runtime, not Edge: the Pool database client speaks WebSocket, and
 * request-context logging uses AsyncLocalStorage (ADR-001, LL-004).
 *
 * Handlers stay lazy — getAuth() runs per request, never at module scope, so
 * importing this route during `next build` needs no environment.
 */
export const runtime = 'nodejs';

async function handler(request: Request): Promise<Response> {
  // First consumer of the LL-004 request context: every log line an auth flow
  // emits carries one correlation id. The logger redacts, so even a failure
  // deep in the driver cannot put a credential in the output.
  return await withRequestContext({ requestId: newRequestId() }, async () => {
    const response = await getAuth().handler(request);
    if (response.status >= 500) {
      log.error('auth endpoint failed', {
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
    }
    return response;
  });
}

export { handler as GET, handler as POST };
