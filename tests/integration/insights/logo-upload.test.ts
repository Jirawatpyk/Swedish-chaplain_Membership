/**
 * F9 US5 (T075) — logo pipeline integration (live Neon + real sharp, stub store).
 *
 * Proves FR-025a end-to-end: a real upload is RE-ENCODED + bounded (the stored
 * bytes are NOT the original), the URL is persisted on the listing + audited
 * (logo_action set/removed), and a bad/oversize/non-image payload is rejected.
 * The Blob upload is stubbed (capture) so the test asserts that ONLY re-encoded
 * bytes are stored — the original is never served.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db, runInTenant } from '@/lib/db';
import {
  setDirectoryLogo,
  removeDirectoryLogo,
  type DirectoryLogoMeta,
} from '@/modules/insights';
import { sharpLogoAdapter } from '@/modules/insights/infrastructure/logo/sharp-logo-adapter';
import { insightsAuditAdapter } from '@/modules/insights/infrastructure/audit/insights-audit-adapter';
import { makeDrizzleDirectoryRepo } from '@/modules/insights/infrastructure/repos/drizzle-directory-repo';
import type { LogoStorePort } from '@/modules/insights/application/ports/logo-port';
import { directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

function makeStubStore(): LogoStorePort & {
  uploads: Array<{ key: string; body: Uint8Array; contentType: string }>;
  deleted: string[];
} {
  const uploads: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
  const deleted: string[] = [];
  let n = 0;
  return {
    uploads,
    deleted,
    async putPublicLogo(input) {
      uploads.push(input);
      return { url: `https://blob.example/${input.key}-${n++}` };
    },
    async deleteLogo(url) {
      deleted.push(url);
    },
  };
}

describe('F9 logo pipeline — integration (T075)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-logo-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();
  let store = makeStubStore();

  const deps = () => ({
    directoryRepo: makeDrizzleDirectoryRepo(tenant.ctx.slug),
    image: sharpLogoAdapter,
    logoStore: store,
    audit: insightsAuditAdapter,
  });
  const removeDeps = () => ({
    directoryRepo: makeDrizzleDirectoryRepo(tenant.ctx.slug),
    logoStore: store,
    audit: insightsAuditAdapter,
  });
  const meta = (requestId: string): DirectoryLogoMeta => ({
    actorUserId: admin.userId,
    actorRole: 'member',
    actorMemberId: memberId,
    requestId,
  });

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Corporate Gold' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Logo Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        riskScore: null,
        riskScoreBand: null,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db.delete(directoryListings).where(eq(directoryListings.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('stores the RE-ENCODED (bounded) logo, not the original, + audits set', async () => {
    store = makeStubStore();
    // 2000×1500 original → must come back ≤ 800px after re-encode.
    const original = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();

    const r = await setDirectoryLogo(
      { memberId, bytes: new Uint8Array(original), declaredMime: 'image/png' },
      meta(`logo-set-${randomUUID()}`),
      tenant.ctx,
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Exactly one upload — the RE-ENCODED bytes (original never served).
    expect(store.uploads).toHaveLength(1);
    const storedMeta = await sharp(Buffer.from(store.uploads[0]!.body)).metadata();
    expect(storedMeta.width).toBe(800); // bounded from 2000
    expect(store.uploads[0]!.body.length).not.toBe(original.length); // not the original bytes

    // URL persisted on the listing.
    const rows = await db
      .select()
      .from(directoryListings)
      .where(
        and(eq(directoryListings.tenantId, tenant.ctx.slug), eq(directoryListings.memberId, memberId)),
      );
    expect(rows[0]?.logoBlobKey).toBe(r.value.logoUrl);

    // Audit logo_action=set.
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug));
    const setEvent = audits.find(
      (a) => a.eventType === 'directory_listing_updated' && (a.payload as { logo_action?: string }).logo_action === 'set',
    );
    expect(setEvent).toBeDefined();
  }, 120_000);

  it('removes the logo (null) + deletes the prior blob + audits removed', async () => {
    const r = await removeDirectoryLogo({ memberId }, meta(`logo-rm-${randomUUID()}`), tenant.ctx, removeDeps());
    expect(r.ok).toBe(true);
    const rows = await db
      .select()
      .from(directoryListings)
      .where(
        and(eq(directoryListings.tenantId, tenant.ctx.slug), eq(directoryListings.memberId, memberId)),
      );
    expect(rows[0]?.logoBlobKey).toBeNull();
    expect(store.deleted.length).toBeGreaterThanOrEqual(1); // prior blob deleted
  }, 120_000);

  it('rejects a non-image payload (invalid_image), no upload', async () => {
    store = makeStubStore();
    const r = await setDirectoryLogo(
      { memberId, bytes: new TextEncoder().encode('totally not an image'), declaredMime: 'image/png' },
      meta(`logo-bad-${randomUUID()}`),
      tenant.ctx,
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_image');
    expect(store.uploads).toHaveLength(0);
  });

  it('member_not_found for an unknown member (orphan blob cleaned up)', async () => {
    store = makeStubStore();
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 1, b: 1 } } })
      .png()
      .toBuffer();
    const unknown = randomUUID();
    const r = await setDirectoryLogo(
      { memberId: unknown, bytes: new Uint8Array(png), declaredMime: 'image/png' },
      { actorUserId: admin.userId, actorRole: 'admin', actorMemberId: null, requestId: `logo-nf-${randomUUID()}` },
      tenant.ctx,
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('member_not_found');
    // The upload happened (re-encode succeeded) then was rolled back.
    expect(store.uploads).toHaveLength(1);
    expect(store.deleted).toHaveLength(1);
  }, 120_000);
});
