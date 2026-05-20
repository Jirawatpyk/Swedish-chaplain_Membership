/**
 * T094 (F7.1a US7 / SC-007a) — Integration test for snapshot decoupling.
 *
 * Verifies that a draft started from a template at time T1 is
 * IMMUTABLE to subsequent template UPDATEs at time T2 — the draft body
 * + subject preserved verbatim from the snapshot moment per FR-019.
 *
 * Lives at integration level (not contract) because the invariant
 * depends on the actual UPDATE semantics of the Drizzle repo + DB
 * column independence (broadcasts.body_html is a separate column from
 * broadcast_templates.body_html — UPDATEs on one do NOT cascade).
 *
 * Runs against live Neon Singapore per CLAUDE.md `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastTemplates,
} from '@/modules/broadcasts/infrastructure/schema';
import { snapshotTemplateToDraft } from '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft';
import { makeSnapshotTemplateToDraftDeps } from '@/modules/broadcasts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F7.1a template snapshot decoupling — SC-007a (T094)', () => {
  let tenant: TestTenant;
  let templateId: string;
  let draftId: string;
  const memberId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test');
    draftId = randomUUID();

    // Seed template T1
    const [tpl] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'Decoupling Test',
        subject: 'V1 subject',
        bodyHtml: '<p>V1 body content</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    templateId = tpl!.id;

    // Seed an empty draft broadcast row (BYPASSRLS — test setup)
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
    await tenant.cleanup();
  });

  it('member draft snapshots template at T1 → admin updates template at T2 → draft unchanged', async () => {
    const deps = makeSnapshotTemplateToDraftDeps(tenant.ctx.slug);

    // 1. T1 snapshot — actor wraps in runInTenant so RLS-confined
    //    findById sees the tenant's row.
    const snapResult = await runInTenant(tenant.ctx, async () =>
      snapshotTemplateToDraft(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: userId,
        memberId,
        draftId,
        templateId,
        requestId: 'req-snap-decoupling',
      }),
    );
    expect(snapResult.ok).toBe(true);
    if (!snapResult.ok) return;

    // Capture T1 substituted snapshot values
    const draftSubjectAtT1 = snapResult.value.subject;
    const draftBodyAtT1 = snapResult.value.bodyHtml;
    expect(draftSubjectAtT1).toBe('V1 subject');
    expect(draftBodyAtT1).toBe('<p>V1 body content</p>');

    // 2. T2 admin UPDATEs template — BYPASSRLS to simulate admin
    //    action without spinning up a second runInTenant scope.
    await db
      .update(broadcastTemplates)
      .set({ subject: 'V2 subject', bodyHtml: '<p>V2 body content</p>' })
      .where(eq(broadcastTemplates.id, templateId));

    // 3. Read the draft row directly — verify its persisted body +
    //    subject are still the T1 snapshot values (NOT mutated by the
    //    template UPDATE).
    const draftRows = await db
      .select({
        subject: broadcasts.subject,
        bodyHtml: broadcasts.bodyHtml,
        startedFromTemplateId: broadcasts.startedFromTemplateId,
        templateNameSnapshot: broadcasts.templateNameSnapshot,
      })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, draftId));
    expect(draftRows).toHaveLength(1);
    const draft = draftRows[0]!;
    expect(draft.subject).toBe('V1 subject');
    expect(draft.bodyHtml).toBe('<p>V1 body content</p>');
    expect(draft.startedFromTemplateId).toBe(templateId);
    expect(draft.templateNameSnapshot).toBe('Decoupling Test');
  });

  it('R2.1 M-test-4: template soft-deleted at T2 → draft retains body + subject + templateNameSnapshot', async () => {
    // Setup: fresh draft + fresh template scoped to this test so the
    // delete doesn't bleed into other tests.
    const localTemplate = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'M-test-4 Soft-delete Survivor',
        subject: 'Survive subject',
        bodyHtml: '<p>Survive body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    const localTemplateId = localTemplate[0]!.id;

    const localDraftId = randomUUID();
    await db.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId: localDraftId,
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

    // T1 snapshot
    const snapResult = await runInTenant(tenant.ctx, async () =>
      snapshotTemplateToDraft(
        makeSnapshotTemplateToDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: userId,
          memberId,
          draftId: localDraftId,
          templateId: localTemplateId,
          requestId: 'req-m-test-4',
        },
      ),
    );
    expect(snapResult.ok).toBe(true);

    // T2 admin soft-deletes the template.
    await db
      .update(broadcastTemplates)
      .set({ deletedAt: new Date() })
      .where(eq(broadcastTemplates.id, localTemplateId));

    // Verify draft survives the template soft-delete.
    const draftRows = await db
      .select({
        subject: broadcasts.subject,
        bodyHtml: broadcasts.bodyHtml,
        startedFromTemplateId: broadcasts.startedFromTemplateId,
        templateNameSnapshot: broadcasts.templateNameSnapshot,
      })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, localDraftId));
    const draft = draftRows[0]!;
    expect(draft.subject).toBe('Survive subject');
    expect(draft.bodyHtml).toBe('<p>Survive body</p>');
    // The provenance pointer stays even though the template is now
    // soft-deleted — admins can still trace which template seeded this
    // draft via the audit log (broadcast_template_snapshotted) +
    // templateNameSnapshot string.
    expect(draft.startedFromTemplateId).toBe(localTemplateId);
    expect(draft.templateNameSnapshot).toBe('M-test-4 Soft-delete Survivor');
  });

  it('R2.1 M-test-5: template renamed at T2 → draft.templateNameSnapshot still reflects T1 name', async () => {
    const localTemplate = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'Original Name',
        subject: 'Rename test subject',
        bodyHtml: '<p>Rename test body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    const localTemplateId = localTemplate[0]!.id;

    const localDraftId = randomUUID();
    await db.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId: localDraftId,
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

    // T1 snapshot captures "Original Name" into templateNameSnapshot.
    const snapResult = await runInTenant(tenant.ctx, async () =>
      snapshotTemplateToDraft(
        makeSnapshotTemplateToDraftDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          actorUserId: userId,
          memberId,
          draftId: localDraftId,
          templateId: localTemplateId,
          requestId: 'req-m-test-5',
        },
      ),
    );
    expect(snapResult.ok).toBe(true);

    // T2 admin renames the template.
    await db
      .update(broadcastTemplates)
      .set({ name: 'Renamed At T2' })
      .where(eq(broadcastTemplates.id, localTemplateId));

    // Draft's templateNameSnapshot still reflects the T1 name (frozen).
    const draftRows = await db
      .select({
        templateNameSnapshot: broadcasts.templateNameSnapshot,
      })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, localDraftId));
    expect(draftRows[0]!.templateNameSnapshot).toBe('Original Name');
  });
});
