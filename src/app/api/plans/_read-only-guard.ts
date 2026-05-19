/**
 * R2 Batch 3j (R2-S8) — shared `READ_ONLY_MODE` guard for F2 plan
 * mutation routes.
 *
 * When the operator flips `READ_ONLY_MODE=true` (emergency maintenance
 * freeze documented in `specs/001-auth-rbac/quickstart.md § 7.3`), every
 * state-changing route should return 503 + `Retry-After: 5` so admin
 * clients can retry intelligently and bug reports clearly state the
 * cause. Read endpoints (GET) are unaffected; they continue to serve.
 *
 * For F8 cron routes the convention is 200 + skipped (so cron-job.org
 * doesn't retry-storm during the maintenance window). User-facing API
 * routes use 503 + Retry-After instead because the client UI expects
 * to handle the retry, not silently succeed.
 *
 * Usage:
 *   ```ts
 *   import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
 *
 *   export async function POST(request: NextRequest) {
 *     const ctx = await requireAdminContext(...);
 *     if ('response' in ctx) return ctx.response;
 *
 *     const roResp = readOnlyModeResponse();
 *     if (roResp) return roResp;
 *
 *     // ... rest of mutation handler
 *   }
 *   ```
 */
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

/**
 * Returns a 503 response when READ_ONLY_MODE is on; null otherwise.
 * Call this AFTER RBAC (admin-context) but BEFORE idempotency-guard
 * + use-case invocation. The order matters:
 *   1. Auth first (don't leak 503 to unauthenticated callers)
 *   2. Then read-only check (skip idempotency reservation when frozen)
 */
export function readOnlyModeResponse(): NextResponse | null {
  if (!env.flags.readOnlyMode) return null;
  return NextResponse.json(
    {
      error: {
        code: 'read_only_mode',
        message:
          'Service is in read-only maintenance mode. Mutations are temporarily unavailable. Retry shortly.',
      },
    },
    { status: 503, headers: { 'Retry-After': '5' } },
  );
}
