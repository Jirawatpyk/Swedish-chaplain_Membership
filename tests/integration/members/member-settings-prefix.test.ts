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
});
