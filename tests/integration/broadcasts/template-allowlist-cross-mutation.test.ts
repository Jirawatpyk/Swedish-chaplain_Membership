/**
 * R2.1 M-test-3 (Phase 5 Round 1 close-out) — template + allowlist
 * cross-mutation integration test.
 *
 * Scenario (per plan kind-tinkering-lantern.md R2.1-S8):
 *   1. Seed tenant image allowlist with `asset.example.com`
 *   2. Create an admin-authored template whose body has
 *      `<img src="https://asset.example.com/banner.png">`
 *   3. Snapshot the template into a draft (snapshotTemplateToDraft)
 *      — succeeds because allowlist still includes asset.example.com
 *   4. Admin removes `asset.example.com` from the allowlist
 *   5. Re-run `validateImageSourceAllowlist` against the FROZEN
 *      snapshot body → expects rejection with the removed-host URL
 *      in `unsafeImageSources`
 *
 * Forensic value: confirms the SNAPSHOT-DECOUPLING + ALLOWLIST-
 * MUTATION invariants compose correctly. The draft's body is FROZEN
 * (per T094) but allowlist validation is LIVE (per T103 / no cache),
 * so an admin who removes a host after a member starts a draft
 * blocks the eventual submit (per UX-C1 / FR-011 / AS2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastTemplates,
  tenantImageSourceAllowlist,
} from '@/modules/broadcasts/infrastructure/schema';
import {
  snapshotTemplateToDraft,
  makeSnapshotTemplateToDraftDeps,
} from '@/modules/broadcasts';
import { validateImageSourceAllowlist } from '@/modules/broadcasts/application/use-cases/validate-image-source-allowlist';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F7.1a template + allowlist cross-mutation — R2.1 M-test-3', () => {
  let tenant: TestTenant;
  let templateId: string;
  let draftId: string;
  const ALLOWED_HOST = 'asset.m-test-3.example.com';
  const memberId = randomUUID();
  const userId = randomUUID();
  const adminUserId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test');
    draftId = randomUUID();

    // Step 1 — seed allowlist with ALLOWED_HOST so the template
    // create + initial snapshot pass validation.
    const allowlistPort = makeDrizzleImageAllowlistRepo();
    await manageImageAllowlist(
      { port: allowlistPort, audit: f7AuditAdapter },
      {
        tenantId: tenant.ctx.slug as never,
        actorUserId: adminUserId,
        action: 'add',
        hostname: ALLOWED_HOST,
        requestId: 'req-m-test-3-allowlist-add',
      },
    );

    // Step 2 — create the template with an img tag pointing to the
    // allowed host. Direct insert (BYPASSRLS via global db) since
    // template fixtures are SETUP, not behaviour-under-test.
    const [tpl] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'Newsletter With Asset',
        subject: 'Q2 update',
        bodyHtml: `<p>Banner: <img src="https://${ALLOWED_HOST}/banner.png" alt="banner"></p>`,
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    templateId = tpl!.id;

    // Pre-fill the broadcast draft row that the snapshot use-case
    // will update. Same pattern as template-snapshot-decoupling.
    await db.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId: draftId,
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: 'corporate',
      submittedByUserId: userId,
      actorRole: 'member_self_service',
      subject: 'placeholder',
      bodyHtml: '<p>placeholder</p>',
      bodySource: 'placeholder',
      fromName: 'Member',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 1,
      status: 'draft' as const,
    });
  });

  afterAll(async () => {
    await db
      .delete(broadcasts)
      .where(eq(broadcasts.tenantId, tenant.ctx.slug));
    await db
      .delete(broadcastTemplates)
      .where(eq(broadcastTemplates.tenantId, tenant.ctx.slug));
    await db
      .delete(tenantImageSourceAllowlist)
      .where(eq(tenantImageSourceAllowlist.tenantId, tenant.ctx.slug));
    await tenant.cleanup();
  });

  it('snapshot template containing allowed img → draft body retains img → admin removes host → validate against snapshot rejects', async () => {
    const deps = makeSnapshotTemplateToDraftDeps(tenant.ctx.slug);

    // Step 3 — snapshot the template (allowlist still has ALLOWED_HOST).
    const snap = await runInTenant(tenant.ctx, async () =>
      snapshotTemplateToDraft(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: userId,
        memberId,
        draftId,
        templateId,
        requestId: 'req-m-test-3-snapshot',
      }),
    );
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    // Snapshot captures the body verbatim — img tag preserved.
    expect(snap.value.bodyHtml).toContain(
      `<img src="https://${ALLOWED_HOST}/banner.png"`,
    );

    // Read the persisted draft body for the cross-mutation step.
    const draftRows = await db
      .select({ bodyHtml: broadcasts.bodyHtml })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, draftId));
    const persistedBody = draftRows[0]!.bodyHtml;
    expect(persistedBody).toContain(
      `<img src="https://${ALLOWED_HOST}/banner.png"`,
    );

    // Step 4 — admin removes ALLOWED_HOST from the allowlist.
    const allowlistPort = makeDrizzleImageAllowlistRepo();
    const removeResult = await manageImageAllowlist(
      { port: allowlistPort, audit: f7AuditAdapter },
      {
        tenantId: tenant.ctx.slug as never,
        actorUserId: adminUserId,
        action: 'remove',
        hostname: ALLOWED_HOST,
        requestId: 'req-m-test-3-allowlist-remove',
      },
    );
    expect(removeResult.ok).toBe(true);

    // Step 5 — re-validate the SNAPSHOT body against the now-shrunk
    // allowlist. The image source is now unsafe.
    const validate = await validateImageSourceAllowlist(
      { allowlistPort, audit: f7AuditAdapter },
      {
        bodyHtml: persistedBody,
        tenantId: tenant.ctx.slug as never,
        actorUserId: userId,
        requestId: 'req-m-test-3-validate-after-remove',
      },
    );
    expect(validate.ok).toBe(false);
    if (!validate.ok) {
      expect(validate.error.unsafeImageSources).toContain(
        `https://${ALLOWED_HOST}/banner.png`,
      );
    }
  });
});
