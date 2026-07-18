/**
 * 107-auto-invoice Task 2 — F8 audit completeness for the two new
 * auto-draft event types (`renewal_auto_drafted` +
 * `renewal_auto_draft_discarded`).
 *
 * Why a live-Neon test and not a unit/mock test: the drizzle adapter's
 * `F8_ENUM_SHIPPED_TUPLE` allowlist decides, at RUNTIME, whether an
 * emit persists to `audit_log` or falls through to `pinoFallback`
 * (which throws in production per the module's documented contract —
 * see `drizzle-renewal-audit-emitter.ts`). A mocked emitter can't
 * observe that branch; only a real `emitInTx` call against a real
 * Postgres `audit_event_type` pgEnum proves BOTH of the following
 * simultaneously:
 *   1. the pgEnum has the new labels (migration 0260 applied), and
 *   2. `F8_ENUM_SHIPPED_TUPLE` actually lists both new event types
 *      (omitting this step is the exact class of prod incident this
 *      repo has hit before — an event type present in the catalogue
 *      + pgEnum but absent from the shipped-tuple allowlist crashes
 *      every emit of that type in production).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import { asMemberId } from '@/modules/members';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('107-auto-invoice Task 2 — F8 auto-draft audit completeness', () => {
  let tenant: TestTenant;

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('both new F8 events persist via emitInTx (pgEnum + F8_ENUM_SHIPPED)', async () => {
    tenant = await createTestTenant('test');
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const cycleId = asCycleId(randomUUID());
    const memberId = asMemberId(randomUUID());

    await runInTenant(tenant.ctx, (tx) =>
      deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_auto_drafted',
          payload: {
            cycle_id: cycleId,
            member_id: memberId,
            plan_year: 2027,
            frozen_price_thb: '12000.00',
            coverage_from: '2027-01-01',
            coverage_to: '2027-12-31',
          },
        },
        {
          tenantId: tenant.ctx.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: 'test',
          requestId: 'test',
        },
      ),
    );

    const [draftedRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_auto_drafted'),
          ),
        ),
    );
    expect(draftedRow).toBeDefined();

    await runInTenant(tenant.ctx, (tx) =>
      deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_auto_draft_discarded',
          payload: {
            cycle_id: cycleId,
            member_id: memberId,
            invoice_id: randomUUID(),
            reason: 'manual',
          },
        },
        {
          tenantId: tenant.ctx.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: 'test',
          requestId: 'test',
        },
      ),
    );

    const [discardedRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_auto_draft_discarded'),
          ),
        ),
    );
    expect(discardedRow).toBeDefined();
  }, 60_000);
});
