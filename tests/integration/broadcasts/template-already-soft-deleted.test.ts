/**
 * R6.3 M-7 — Live-Neon integration for R4.3 M-13 "already soft-deleted"
 * benign-no-op paths on `deleteBroadcastTemplate` + `updateBroadcastTemplate`.
 *
 * R5 Final 2 senior-tester flagged the M-13 contract tests covered
 * only the mock path. Per memory `feedback_integration_test_required.md`
 * every new use-case path needs ≥1 live-Neon integration test. R4.3 M-13
 * added a NEW branch in both delete + update flows (path (b): row exists
 * but deletedAt !== null). This test runs the use-case against a real
 * soft-deleted row + RLS-bound tx + verifies:
 *
 *   - Returns `{ok: false, error: {kind: 'not_found'}}`
 *   - NO `broadcast_cross_tenant_probe` audit row
 *   - NO `broadcast_template_deleted` / `broadcast_template_updated`
 *     second audit row
 *   - The row is still in soft-deleted state (deletedAt unchanged)
 *
 * Pattern adapted from `template-cross-tenant-probe.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { broadcastTemplates } from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  deleteBroadcastTemplate,
  updateBroadcastTemplate,
  makeDeleteBroadcastTemplateDeps,
  makeUpdateBroadcastTemplateDeps,
} from '@/modules/broadcasts';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import type { TenantSlug } from '@/modules/tenants';

describe('R4.3 M-13 / R6.3 M-7 — already-soft-deleted template integration', () => {
  let tenant: TestTenant;
  let softDeletedTemplateId: string;
  const FROZEN_DELETED_AT = new Date('2026-05-19T10:00:00Z');

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenant = pair.a;

    const [tpl] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'Already Soft Deleted',
        subject: 'Was deleted yesterday',
        bodyHtml: '<p>body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
        deletedAt: FROZEN_DELETED_AT,
      })
      .returning({ id: broadcastTemplates.id });
    softDeletedTemplateId = tpl!.id;
  });

  afterAll(async () => {
    // R8.6 L-1 (R7 senior-tester) — drop the auditLog DELETE.
    // The `audit_log` table carries an append-only trigger
    // (constitution-mandated immutability per Principle VIII +
    // tests/integration/helpers/test-tenant.ts L206-209 comment).
    // DELETE attempts are blocked + raise noise in CI logs without
    // actually cleaning anything. Tenant slug uniqueness via
    // `createTwoTestTenants` already isolates this run's audit
    // rows from other runs; tenant teardown handles them.
    await db
      .delete(broadcastTemplates)
      .where(
        inArray(broadcastTemplates.tenantId, [tenant.ctx.slug]),
      );
  });

  it('deleteBroadcastTemplate on soft-deleted row → not_found + NO new audit + softDelete NOT called', async () => {
    const r = await runInTenant(tenant.ctx, async () =>
      deleteBroadcastTemplate(makeDeleteBroadcastTemplateDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug as TenantSlug,
        actorUserId: 'integration-admin',
        templateId: softDeletedTemplateId,
        requestId: 'req-m13-delete',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');

    // No NEW audit rows for this template (path b is silent on audit).
    // We allow whatever rows were seeded historically; this query only
    // looks at the current request.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.requestId, 'req-m13-delete'),
        ),
      );
    expect(auditRows).toEqual([]);

    // Row STILL in soft-deleted state (deletedAt unchanged).
    const surviving = await db
      .select({ deletedAt: broadcastTemplates.deletedAt })
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.id, softDeletedTemplateId));
    expect(surviving[0]?.deletedAt?.toISOString()).toBe(
      FROZEN_DELETED_AT.toISOString(),
    );
  });

  it('updateBroadcastTemplate on soft-deleted row → not_found + NO new audit + update NOT called', async () => {
    const r = await runInTenant(tenant.ctx, async () =>
      updateBroadcastTemplate(makeUpdateBroadcastTemplateDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug as TenantSlug,
        actorUserId: 'integration-admin',
        templateId: softDeletedTemplateId,
        subject: 'Trying to edit a soft-deleted template',
        requestId: 'req-m13-update',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');

    // No NEW audit rows for this request.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.requestId, 'req-m13-update'),
        ),
      );
    expect(auditRows).toEqual([]);

    // Row UNCHANGED — subject stays "Was deleted yesterday".
    const surviving = await db
      .select({
        subject: broadcastTemplates.subject,
        deletedAt: broadcastTemplates.deletedAt,
      })
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.id, softDeletedTemplateId));
    expect(surviving[0]?.subject).toBe('Was deleted yesterday');
    expect(surviving[0]?.deletedAt?.toISOString()).toBe(
      FROZEN_DELETED_AT.toISOString(),
    );
  });
});
