/**
 * #408 — the READ_ONLY_MODE short-circuit for scheduled cron routes.
 *
 * `READ_ONLY_MODE=true` is the emergency write freeze
 * (`specs/001-auth-rbac/quickstart.md` § 7.3). `src/proxy.ts` enforces it only
 * for POST/PUT/PATCH/DELETE, and Vercel Cron invokes every `vercel.json` path
 * with GET — so without this guard a cron kept writing rows, sending E-Blasts
 * and calling Resend while the operator believed writes were stopped.
 *
 * Call it immediately AFTER the Bearer check (an unauthenticated caller still
 * gets 401, never the freeze state) and BEFORE any locking read, write or
 * external call:
 *
 *   ```ts
 *   const frozen = cronReadOnlyGuard(ROUTE);
 *   if (frozen) return frozen;
 *   ```
 *
 * Answers 200 (not 503) so the scheduler does not retry-storm through a
 * maintenance window. Skipped work runs on the next tick after the freeze
 * lifts. `tests/unit/architecture/cron-read-only-guard-coverage.test.ts`
 * fails when a scheduled route neither calls this nor carries a written
 * exemption. Runbook: `docs/runbooks/cron-jobs.md` § Read-only mode.
 */
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/** Returns the 200 skip response while the freeze is on; `null` otherwise. */
export function cronReadOnlyGuard(route: string): NextResponse | null {
  if (!env.flags.readOnlyMode) return null;
  logger.info({ route }, 'cron.read_only_mode.skipped');
  return NextResponse.json(
    { ok: true, skipped: true, reason: 'read_only_mode' },
    { status: 200 },
  );
}
