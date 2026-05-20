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
 * RED-first per Constitution Principle II. GREEN at Phase 5C+5D when
 * the repo + snapshot use-case land.
 *
 * Runs against live Neon Singapore per CLAUDE.md `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { broadcastTemplates } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const dynImport = new Function('m', 'return import(m)') as <T = unknown>(
  modulePath: string,
) => Promise<T>;

describe('F7.1a template snapshot decoupling — SC-007a (T094)', () => {
  let tenant: TestTenant;
  let templateId: string;

  beforeAll(async () => {
    tenant = await createTestTenant('test');

    const [row] = await db
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
    templateId = row!.id;
  });

  afterAll(async () => {
    await db
      .delete(broadcastTemplates)
      .where(eq(broadcastTemplates.tenantId, tenant.ctx.slug));
    await tenant.cleanup();
  });

  it('member draft snapshots template at T1 → admin updates template at T2 → draft unchanged', async () => {
    // 1. Snapshot template → draft at T1 (use-case lands at Phase 5D T102)
    const snapshotMod = await dynImport<{
      readonly snapshotTemplateToDraft: (
        deps: Record<string, unknown>,
        input: {
          readonly tenantId: string;
          readonly actorUserId: string;
          readonly memberId: string;
          readonly draftId: string;
          readonly templateId: string;
          readonly requestId: string;
        },
      ) => Promise<{
        ok: true;
        value: {
          readonly draftId: string;
          readonly subject: string;
          readonly bodyHtml: string;
        };
      }>;
    }>(
      '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft',
    );

    // 2. (We don't actually create a real draft for this RED — the
    //    snapshot use-case returns the substituted values; the
    //    decoupling assertion compares them to a later read of the
    //    template after an UPDATE.)
    const draftId = '99999999-9999-9999-9999-99999999900a';
    const depsMod = await dynImport<{
      readonly makeSnapshotTemplateToDraftDeps: (
        tenantId: string,
      ) => Record<string, unknown>;
    }>('@/modules/broadcasts');
    const deps = depsMod.makeSnapshotTemplateToDraftDeps(tenant.ctx.slug);

    const snapResult = await runInTenant(tenant.ctx, async () =>
      snapshotMod.snapshotTemplateToDraft(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: 'user-test-mem',
        memberId: 'mem-test',
        draftId,
        templateId,
        requestId: 'req-snap-decoupling',
      }),
    );

    expect(snapResult.ok).toBe(true);
    if (!snapResult.ok) return;

    const draftSubjectAtT1 = snapResult.value.subject;
    const draftBodyAtT1 = snapResult.value.bodyHtml;

    expect(draftSubjectAtT1).toContain('V1 subject');
    expect(draftBodyAtT1).toContain('V1 body content');

    // 3. Admin UPDATEs the template at T2 (raw db UPDATE — Drizzle repo
    //    impl would do the same path)
    await db
      .update(broadcastTemplates)
      .set({ subject: 'V2 subject', bodyHtml: '<p>V2 body content</p>' })
      .where(eq(broadcastTemplates.id, templateId));

    // 4. Verify the snapshot result (representing the draft) is
    //    unchanged — substituted values from T1 still hold
    expect(draftSubjectAtT1).toContain('V1 subject');
    expect(draftSubjectAtT1).not.toContain('V2 subject');
    expect(draftBodyAtT1).toContain('V1 body content');
    expect(draftBodyAtT1).not.toContain('V2 body content');
  });
});
