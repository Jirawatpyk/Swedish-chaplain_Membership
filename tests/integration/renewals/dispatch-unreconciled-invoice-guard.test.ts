/**
 * Rolling-anchor refactor rev 2 (design 2026-07-08 §4) — Task 10
 * integration test (live Neon) for the dispatcher's Gate 7.5 skip-guard
 * `unreconciled_paid_membership_invoice`.
 *
 * Belt-and-suspenders safety net for the deploy→backfill gap: if a
 * member has a paid membership invoice from the last 12 months that is
 * neither linked to any cycle (`linked_invoice_id`) nor recorded as any
 * cycle's forensic anchor (`anchor_invoice_id`), the member's cycle
 * state may be stale — `dispatchOneCycle` refuses to fire a reminder
 * and instead emits a LOUD skip (logger.error + `renewal_reminder_skipped`
 * audit) so staff can reconcile manually.
 *
 * Scenario (mirrors `dispatch-cron-idempotency.test.ts`'s harness):
 *   1. Seed an upcoming cycle whose T-30 step is due exactly at the
 *      dispatcher's pinned `nowIso`, PLUS a paid membership invoice that
 *      is deliberately left unlinked/unanchored → dispatch MUST skip
 *      with `unreconciled_paid_membership_invoice`, zero gateway calls,
 *      zero `reminder_events` rows.
 *   2. Reconcile the invoice onto the cycle's `anchor_invoice_id` →
 *      re-running the SAME dispatch pass (same `nowIso`) now proceeds
 *      normally and sends the reminder.
 *
 * The guard's own SQL filters `paid_at > NOW() - INTERVAL '12 months'`
 * using the REAL database wall-clock (not the dispatcher's injected
 * `nowIso` test-clock), so the seeded invoice's `paidAt` is anchored to
 * the actual test-execution time, not the fictional 2026-06-15 cron
 * date used for the cycle's period/schedule matching.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Fictional dispatcher clock (unrelated to the guard's own `NOW()`-based
// 12-month window) — Regular tier T-30 step due exactly at NOW_ISO.
const NOW_ISO = '2026-06-15T08:00:00.000Z';
const EXPIRES_AT = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-07-15T00:00:00.000Z');

describe('dispatchOneCycle Gate 7.5 — unreconciled paid membership invoice guard (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let invoiceId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);

    planId = `f8-unrec-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();
    invoiceId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Unreconciled Guard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Unreconciled Guard Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Anna',
        lastName: 'Adm',
        email: `unrec-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      // Paid membership invoice, deliberately UNLINKED + UNANCHORED — the
      // guard's own `paid_at > NOW() - INTERVAL '12 months'` filter uses
      // the REAL wall-clock, so anchor paidAt to actual test-run time
      // (30 days ago), independent of the fictional NOW_ISO cron clock.
      const realPaidAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Unreconciled Guard Co',
          country: 'TH',
          legal_name: 'Unreconciled Guard Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'unrec@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'UNREC-TEST-PAY',
        paymentRecordedByUserId: user.userId,
        paymentDate: realPaidAt.toISOString().slice(0, 10),
        paidAt: realPaidAt,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalReminderEvents)
      .where(eq(renewalReminderEvents.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('unreconciled paid invoice → dispatch skips (unreconciled_paid_membership_invoice), zero gateway calls, zero reminder_events rows', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-delivery-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    const r1 = await dispatchRenewalCycle(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.summary.candidatesProcessed).toBe(1);
    expect(r1.value.summary.emailsSent).toBe(0);
    expect(r1.value.summary.skipped.unreconciled_paid_membership_invoice).toBe(1);
    expect(gatewaySpy).not.toHaveBeenCalled();

    const reminderRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenant.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRows).toHaveLength(0);

    const skippedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_reminder_skipped' as never),
        ),
      );
    expect(skippedAudits).toHaveLength(1);
    expect(
      (skippedAudits[0]?.payload as Record<string, unknown> | undefined)
        ?.reason,
    ).toBe('unreconciled_paid_membership_invoice');

    gatewaySpy.mockRestore();

    // ---- Reconcile: anchor the invoice onto the cycle -------------------
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ anchorInvoiceId: invoiceId })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );

    // ---- Re-run the SAME dispatch pass (same nowIso) → proceeds --------
    const gatewaySpy2 = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-delivery-${randomUUID().slice(0, 8)}`,
          dispatchedAt: NOW_ISO,
        },
      } as never);

    const r2 = await dispatchRenewalCycle(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
      nowIso: NOW_ISO,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.summary.emailsSent).toBe(1);
    expect(r2.value.summary.skipped.unreconciled_paid_membership_invoice ?? 0).toBe(0);
    expect(gatewaySpy2).toHaveBeenCalledTimes(1);

    const reminderRowsAfter = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenant.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
    expect(reminderRowsAfter).toHaveLength(1);
    expect(reminderRowsAfter[0]?.status).toBe('sent');
    expect(reminderRowsAfter[0]?.stepId).toBe('t-30.email');

    gatewaySpy2.mockRestore();
  }, 120_000);
});
