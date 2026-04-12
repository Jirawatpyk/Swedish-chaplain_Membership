/**
 * T026 — DEBUG_RLS_STATE dev-mode assertion integration test.
 *
 * The `assertTenantContextSet` helper in `src/lib/db.ts` exists to
 * catch the "I forgot runInTenant" class of bug during development.
 * When `DEBUG_RLS_STATE=true`, the helper throws a loud error if a
 * tenant-scoped query runs without `SET LOCAL ROLE chamber_app` +
 * `SET LOCAL app.current_tenant`. Critique E5, research.md § 2.5.
 *
 * This test exercises the helper directly against a live Neon
 * connection, bypassing `runInTenant` so we can assert each failure
 * mode:
 *
 *   1. Query outside any transaction context (no SET LOCAL ROLE,
 *      no SET LOCAL app.current_tenant) → throws with current_user
 *      mismatch message.
 *   2. Query inside a transaction with `SET LOCAL ROLE chamber_app`
 *      but WITHOUT `SET LOCAL app.current_tenant` → throws with
 *      tenant-null message.
 *   3. Query through `runInTenant(ctx, ...)` with DEBUG_RLS_STATE
 *      enabled → does NOT throw and returns the callback value.
 *
 * NOTE: DEBUG_RLS_STATE is captured in src/lib/db.ts at MODULE load
 * time from env.tenant.debugRlsState. This test toggles behaviour via
 * the ctx.slug the assertion checks — when the flag is OFF at module
 * load the assertion is a no-op and these tests will be SKIPPED with
 * a visible log line (not bypassed silently).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertTenantContextSet,
  db,
  runInTenant,
  TenantContextAssertionError,
} from '@/lib/db';
import { env } from '@/lib/env';
import { createTestTenant } from '../helpers/test-tenant';

const DEBUG_ENABLED = env.tenant.debugRlsState;

describe('DEBUG_RLS_STATE dev-mode assertion (T026)', () => {
  if (!DEBUG_ENABLED) {
    it.skip('DEBUG_RLS_STATE=false — suite skipped (set DEBUG_RLS_STATE=true in .env.local to exercise)', () => {
      // Visible skip — keeps CI output honest about what is not being
      // covered in the default configuration.
    });
    return;
  }

  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const c of cleanups) await c().catch(() => {});
  });

  it('throws when queries run without runInTenant', async () => {
    // A plain owner transaction never issues SET LOCAL ROLE chamber_app,
    // so `current_user` is `neondb_owner` and the helper trips on that.
    await expect(
      db.transaction(async (tx) => {
        await assertTenantContextSet(tx);
      }),
    ).rejects.toBeInstanceOf(TenantContextAssertionError);
  });

  it('throws when ROLE is set but app.current_tenant is not', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE chamber_app`);
        // intentionally skip SET LOCAL app.current_tenant
        await assertTenantContextSet(tx);
      }),
    ).rejects.toBeInstanceOf(TenantContextAssertionError);
  });

  it('does NOT throw when runInTenant has set both ROLE + current_tenant', async () => {
    const { ctx, cleanup } = await createTestTenant('test');
    cleanups.push(cleanup);

    // runInTenant itself invokes assertTenantContextSet at the tail of
    // its transaction when DEBUG_RLS_STATE is true — so a clean return
    // from runInTenant is the positive assertion here.
    const result = await runInTenant(ctx, async () => 42);
    expect(result).toBe(42);
  });
});
