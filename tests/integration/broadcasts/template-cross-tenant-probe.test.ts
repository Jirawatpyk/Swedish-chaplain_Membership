/**
 * T093 (F7.1a US7 / Principle I Review-Gate) — Cross-tenant probe for
 * `broadcast_templates`.
 *
 * Validates DB-layer RLS+FORCE (migration 0166) prevents tenant B from
 * reading, writing, or removing tenant A's template rows when running
 * under `runInTenant(tenantB.ctx)`. Mirrors the F7.1a US2 image-
 * allowlist probe pattern (T065).
 *
 * 4 probe cases per data-model.md § 6:
 *   READ      — tenant B cannot SELECT tenant A rows
 *   UPDATE    — tenant B cannot UPDATE tenant A rows
 *   DELETE    — tenant B cannot DELETE tenant A rows
 *   INSERT    — tenant B cannot INSERT a row with tenantId=tenantA
 *
 * Runs against live Neon Singapore per CLAUDE.md `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { broadcastTemplates } from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { deleteBroadcastTemplate } from '@/modules/broadcasts/application/use-cases/delete-broadcast-template';
import { makeDeleteBroadcastTemplateDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

describe('F7.1a templates cross-tenant probe — REVIEW-GATE BLOCKER (T093)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let templateAId: string;
  let templateBId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed one template per tenant via schema-owner `db` (BYPASSES
    // RLS — required for cross-tenant test setup).
    const [tplA] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenantA.ctx.slug,
        name: 'TenantA Private',
        subject: 'A subject',
        bodyHtml: '<p>tenant A body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    const [tplB] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenantB.ctx.slug,
        name: 'TenantB Private',
        subject: 'B subject',
        bodyHtml: '<p>tenant B body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    templateAId = tplA!.id;
    templateBId = tplB!.id;
  });

  afterAll(async () => {
    await db
      .delete(broadcastTemplates)
      .where(
        inArray(broadcastTemplates.tenantId, [
          tenantA.ctx.slug,
          tenantB.ctx.slug,
        ]),
      );
  });

  it('READ: tenant B cannot SELECT tenant A template rows', async () => {
    const rows = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select()
        .from(broadcastTemplates)
        .where(eq(broadcastTemplates.tenantId, tenantA.ctx.slug)),
    );
    expect(rows).toEqual([]);
  });

  it('READ by id: tenant B cannot fetch tenant A template by id', async () => {
    const rows = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select()
        .from(broadcastTemplates)
        .where(eq(broadcastTemplates.id, templateAId)),
    );
    expect(rows).toEqual([]);
  });

  it('UPDATE: tenant B UPDATE on tenant A row affects ZERO rows', async () => {
    const updated = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .update(broadcastTemplates)
        .set({ name: 'COMPROMISED' })
        .where(eq(broadcastTemplates.id, templateAId))
        .returning({ id: broadcastTemplates.id }),
    );
    expect(updated).toEqual([]);
    // BYPASSRLS verify the row is intact + unchanged
    const surviving = await db
      .select({ name: broadcastTemplates.name })
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.id, templateAId));
    expect(surviving[0]?.name).toBe('TenantA Private');
  });

  it('DELETE: tenant B DELETE on tenant A row affects ZERO rows', async () => {
    const deleted = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .delete(broadcastTemplates)
        .where(eq(broadcastTemplates.id, templateAId))
        .returning({ id: broadcastTemplates.id }),
    );
    expect(deleted).toEqual([]);
    // BYPASSRLS verify the row still exists
    const surviving = await db
      .select({ id: broadcastTemplates.id })
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.id, templateAId));
    expect(surviving).toHaveLength(1);
  });

  it('INSERT: tenant B INSERT with tenantId=tenantA is rejected by RLS WITH CHECK', async () => {
    // Match US2 image-allowlist probe pattern — `.rejects.toThrow()`
    // without regex. The Drizzle error message wraps the underlying
    // Postgres "new row violates row-level security policy" inside its
    // own "Failed query: insert into ..." prefix; matching the bare
    // throw is sufficient (the BYPASSRLS verification below proves the
    // spoofed row never landed).
    await expect(
      runInTenant(tenantB.ctx, async (tx) =>
        tx.insert(broadcastTemplates).values({
          tenantId: tenantA.ctx.slug, // spoof
          name: 'Injected',
          subject: 'X',
          bodyHtml: '<p>X</p>',
          locale: 'en',
          isSeeded: false,
          createdByUserId: null,
        }),
      ),
    ).rejects.toThrow();
    // BYPASSRLS verify no forged row landed in tenant A's namespace
    const forged = await db
      .select()
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.name, 'Injected'));
    expect(forged).toHaveLength(0);
  });

  // T129 (F7.1a Phase 6) — audit-emit probe expansion.
  //
  // Data-model § 6 + Constitution Principle I sub-clause 4: every
  // cross-tenant probe MUST emit `broadcast_cross_tenant_probe`. The
  // template-use-cases already wire the emit via
  // `emitTemplateCrossTenantProbeAudit` (see
  // `src/modules/broadcasts/application/use-cases/_emit-cross-tenant-probe.ts`)
  // — called when a use-case lookup returns null under RLS.
  //
  // This test drives `deleteBroadcastTemplate` from tenant B's
  // context targeting tenant A's templateId → RLS filters A's row →
  // use-case emits `broadcast_cross_tenant_probe` with
  // `payload.resourceKind='template'` BEFORE returning `not_found`.
  //
  // Filter by `requestId` (unique per probe) + `tenantId` (the actor's
  // own tenant — `emitTemplateCrossTenantProbeAudit` uses the actor's
  // tenant for the audit row because the actor was querying INTO its
  // OWN namespace). eventType asserted in JS to dodge Drizzle's narrow
  // enum-inferred type for `audit_event_type`.
  it('AUDIT: tenant B delete probe of tenant A template emits broadcast_cross_tenant_probe', async () => {
    const probeRequestId = `t129-probe-${randomUUID()}`;
    const actorUserId = randomUUID();

    const result = await runInTenant(tenantB.ctx, async () =>
      deleteBroadcastTemplate(makeDeleteBroadcastTemplateDeps(tenantB.ctx.slug), {
        tenantId: tenantB.ctx.slug as never,
        templateId: templateAId, // cross-tenant probe target
        actorUserId,
        requestId: probeRequestId,
      }),
    );

    // Step 1: result is `not_found` (RLS hid A's template from B)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
    }

    // Step 2: probe audit row committed via schema-owner bypass-RLS
    const probeRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.requestId, probeRequestId),
          eq(auditLog.tenantId, tenantB.ctx.slug),
        ),
      );

    expect(probeRows).toHaveLength(1);
    const row = probeRows[0];
    expect(row?.eventType).toBe('broadcast_cross_tenant_probe');
    expect(row?.actorUserId).toBe(actorUserId);
    expect(row?.payload).toMatchObject({
      probedTenantId: tenantB.ctx.slug,
      probedTemplateId: templateAId,
      resourceKind: 'template',
    });

    // Step 3: tenant A's template is untouched (defence-in-depth)
    const aRows = await db
      .select({ id: broadcastTemplates.id, name: broadcastTemplates.name })
      .from(broadcastTemplates)
      .where(eq(broadcastTemplates.id, templateAId));
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.name).toBe('TenantA Private');
  });

  it('tenant A still sees its own row + tenant B still sees its own row', async () => {
    const aRows = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select({ id: broadcastTemplates.id, name: broadcastTemplates.name })
        .from(broadcastTemplates)
        .where(eq(broadcastTemplates.id, templateAId)),
    );
    expect(aRows).toEqual([
      { id: templateAId, name: 'TenantA Private' },
    ]);
    const bRows = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select({ id: broadcastTemplates.id, name: broadcastTemplates.name })
        .from(broadcastTemplates)
        .where(eq(broadcastTemplates.id, templateBId)),
    );
    expect(bRows).toEqual([
      { id: templateBId, name: 'TenantB Private' },
    ]);
  });
});
