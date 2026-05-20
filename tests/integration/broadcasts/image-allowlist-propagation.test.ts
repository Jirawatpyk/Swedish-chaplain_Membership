/**
 * Image-allowlist propagation — TA-M1 (PR-review verify-run closure).
 *
 * Acceptance Scenario 3 (spec.md:74): "subsequent submissions validate
 * against the new allowlist within ≤60 seconds of save". The Phase 4
 * implementation reads the allowlist on every submit via
 * `validateImageSourceAllowlist` → `findByTenantId` (no caching layer),
 * so propagation is effectively zero and trivially under 60s.
 *
 * This test pins the no-cache invariant against LIVE Neon Singapore.
 * If a future maintainer wraps `findByTenantId` in
 * `unstable_cache({ revalidate: 120 })`, the immediate-call assertion
 * here breaks — forcing the change author to either reduce the TTL or
 * invalidate on `manageImageAllowlist` mutation. The contract test
 * (image-source-allowlist.test.ts case 7) pins the same invariant at
 * the use-case layer via mocks; this integration test pins it at the
 * DB layer where the real cache slip would live.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenantImageSourceAllowlist } from '@/modules/broadcasts/infrastructure/schema';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { validateImageSourceAllowlist } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F7.1a image-allowlist propagation — TA-M1 (no-cache invariant)', () => {
  let tenant: TestTenant;
  const NEW_HOST = 'propagation-test.example.com';
  const ADMIN_USER = '00000000-0000-4000-8000-000000000071';

  beforeAll(async () => {
    tenant = await createTestTenant('test');
  });

  afterAll(async () => {
    // Cleanup our seeded rows (admin + platform-default 'resend.com'
    // also seeded by manageImageAllowlist via seedPlatformDefaults).
    await db
      .delete(tenantImageSourceAllowlist)
      .where(inArray(tenantImageSourceAllowlist.tenantId, [tenant.ctx.slug]));
  });

  it('admin add → next validate call sees the new hostname immediately (no cache)', async () => {
    const port = makeDrizzleImageAllowlistRepo();
    const deps = { port, audit: f7AuditAdapter };

    // Step 1: admin adds NEW_HOST.
    const addResult = await manageImageAllowlist(deps, {
      tenantId: tenant.ctx.slug as never,
      actorUserId: ADMIN_USER,
      action: 'add',
      hostname: NEW_HOST,
      requestId: 'req-propagation-add',
    });
    expect(addResult.ok).toBe(true);

    // Step 2: IMMEDIATELY validate a body referencing NEW_HOST.
    // If any caching layer slipped in between findByTenantId and the
    // mutation, this validation would fail (stale read).
    const validateResult = await validateImageSourceAllowlist(
      { allowlistPort: port, audit: f7AuditAdapter },
      {
        bodyHtml: `<p>Banner: <img src="https://${NEW_HOST}/banner.png" alt="banner"></p>`,
        tenantId: tenant.ctx.slug as never,
        actorUserId: ADMIN_USER,
        requestId: 'req-propagation-validate',
      },
    );
    expect(validateResult.ok).toBe(true);
  });

  it('admin remove → next validate call rejects the removed hostname immediately', async () => {
    const port = makeDrizzleImageAllowlistRepo();
    const deps = { port, audit: f7AuditAdapter };

    // Step 1: admin removes NEW_HOST (added in previous test).
    const removeResult = await manageImageAllowlist(deps, {
      tenantId: tenant.ctx.slug as never,
      actorUserId: ADMIN_USER,
      action: 'remove',
      hostname: NEW_HOST,
      requestId: 'req-propagation-remove',
    });
    expect(removeResult.ok).toBe(true);

    // Step 2: IMMEDIATELY validate the same body — must now reject.
    const validateResult = await validateImageSourceAllowlist(
      { allowlistPort: port, audit: f7AuditAdapter },
      {
        bodyHtml: `<p>Banner: <img src="https://${NEW_HOST}/banner.png" alt="banner"></p>`,
        tenantId: tenant.ctx.slug as never,
        actorUserId: ADMIN_USER,
        requestId: 'req-propagation-validate-after-remove',
      },
    );
    expect(validateResult.ok).toBe(false);
    if (!validateResult.ok) {
      expect(validateResult.error.unsafeImageSources).toContain(
        `https://${NEW_HOST}/banner.png`,
      );
    }
  });
});
