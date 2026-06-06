/**
 * 055-member-number — member-settings prefix reader (live Neon).
 *
 * getPrefix returns the seeded per-tenant prefix, or the column DEFAULT
 * 'M' when no tenant_member_settings row exists.
 *
 * Schema-file reconciliation: the canonical Drizzle table object
 * `tenantMemberSettings` lives in `schema-member-settings.ts` (per-table
 * file naming by the Migration/Schema group). The repo impl uses raw SQL
 * against DB identifiers, so the file naming only affects this test's
 * seed-insert import.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { drizzleMemberSettingsRepo } from '@/modules/members/infrastructure/repos/drizzle-member-settings-repo';
import { resolveMemberNumberPrefix } from '@/modules/members';
import { tenantMemberSettings } from '@/modules/members/infrastructure/db/schema-member-settings';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('member-settings prefix reader (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    // Shared cleanup helper does not yet wipe member-number tables.
    await db
      .delete(tenantMemberSettings)
      .where(eq(tenantMemberSettings.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  });

  it('returns the column default "M" when no settings row exists', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const prefix = await runInTenant(ctx, (tx) =>
      drizzleMemberSettingsRepo.getPrefix(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(prefix).toBe('M');
  }, 30_000);

  it('returns the seeded prefix when a settings row exists', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    await runInTenant(ctx, (tx) =>
      tx.insert(tenantMemberSettings).values({
        tenantId: tenant.ctx.slug,
        memberNumberPrefix: 'SCCM',
      }),
    );

    const prefix = await runInTenant(ctx, (tx) =>
      drizzleMemberSettingsRepo.getPrefix(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(prefix).toBe('SCCM');
  }, 30_000);

  it('resolveMemberNumberPrefix applies runInTenant internally (RLS-safe, no caller wrapper)', async () => {
    // FIX-3: every other test mocks the resolver. This proves the SHARED helper
    // — which exists to apply runInTenant so the RLS GUC is set (F7.1a class) —
    // actually fires that wrapper itself: we call it with NO surrounding
    // runInTenant, pass the concrete drizzle settings port, and still read the
    // tenant's seeded prefix. If the helper failed to set app.current_tenant,
    // the FORCE-RLS read would return 0 rows → the column-default 'M', not 'SCCM'.
    const ctx = asTenantContext(tenant.ctx.slug);

    // Idempotently ensure the seeded prefix row exists (independent of test
    // ordering above). Upsert under a tenant tx so RLS WITH CHECK is satisfied.
    await runInTenant(ctx, (tx) =>
      tx
        .insert(tenantMemberSettings)
        .values({ tenantId: tenant.ctx.slug, memberNumberPrefix: 'SCCM' })
        .onConflictDoNothing(),
    );

    // No runInTenant wrapper here — the helper owns it.
    const prefix = await resolveMemberNumberPrefix(ctx, drizzleMemberSettingsRepo);
    expect(prefix).toBe('SCCM');
  }, 30_000);
});
