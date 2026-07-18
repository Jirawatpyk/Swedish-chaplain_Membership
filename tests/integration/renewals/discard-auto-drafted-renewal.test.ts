/**
 * 107-auto-invoice Task 14 — `discardAutoDraftedRenewal` integration test
 * (live Neon). The admin review-queue's manual "Discard" row action.
 *
 * Scenario map:
 *   (a) A genuine `origin='auto_renewal' status='draft'` invoice with a
 *       stamped cycle → HARD-DELETED from `invoices`, and
 *       `renewal_auto_draft_discarded { reason:'manual' }` is written with
 *       the correct `cycle_id` / `member_id` / `invoice_id`.
 *   (b) An already-ISSUED invoice → `not_draft`; the row is left intact
 *       (status, document number all unchanged) — the status-guarded DELETE
 *       never fires.
 *   (c) A random / non-existent id → `not_found`.
 *   (d) An ORPHANED draft (Task 7's "orphaned after commit" window — no
 *       cycle stamped with this invoice id) → still discarded
 *       (`auditEmitted:false`); no `renewal_auto_draft_discarded` row is
 *       written (there is no cycle to attach it to), but the row IS gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  discardAutoDraftedRenewal,
  issueAutoDraftedRenewal,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/** Every fixture cycle starts here → `deriveFiscalYear(periodFrom)` = 2025. */
const PERIOD_FROM = '2025-08-01T00:00:00Z';
const PLAN_YEAR = deriveFiscalYear(PERIOD_FROM);

let tenant: TestTenant;
let user: TestUser;
let planId: string;

function depsFor(t: TestTenant) {
  return makeRenewalsDeps(t.ctx.slug);
}

async function seedMember(t: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(t.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Auto-Discard T14 Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      taxId: '9999999999999',
      addressLine1: '99 Rama IV Road',
      city: 'Sathon',
      province: 'Bangkok',
      postalCode: '10120',
      planId,
      planYear: PLAN_YEAR,
      billingCycle: 'rolling',
      autoInvoiceEnrolledAt: new Date('2026-01-01T00:00:00Z'),
    });
    await tx.insert(contacts).values({
      tenantId: t.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Auto',
      lastName: 'Discard',
      email: `auto.${memberId.slice(0, 8)}@member.example`,
      isPrimary: true,
    });
  });
  return memberId;
}

async function seedCycle(t: TestTenant, memberId: string): Promise<string> {
  const cycleId = randomUUID();
  const periodFrom = new Date(PERIOD_FROM);
  const periodTo = new Date(periodFrom);
  periodTo.setUTCMonth(periodTo.getUTCMonth() + 12);
  await runInTenant(t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: t.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom,
      periodTo,
      expiresAt: periodTo,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: periodFrom,
    }),
  );
  return cycleId;
}

/** Creates a genuine `origin='auto_renewal'` draft via the T5 bridge and
 *  (optionally) stamps it onto a cycle. */
async function seedAutoDraft(
  t: TestTenant,
  memberId: string,
  cycleId: string | null,
): Promise<string> {
  const deps = depsFor(t);
  const drafted = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
    tenantId: t.ctx.slug,
    memberId,
    planId,
    planYear: PLAN_YEAR,
    frozenPlanPriceThb: '50000.00' as never,
    actorUserId: user.userId,
    requestId: null,
  });
  if (drafted.status !== 'drafted') {
    throw new Error(`fixture draft failed: ${JSON.stringify(drafted)}`);
  }
  if (cycleId !== null) {
    await runInTenant(t.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: drafted.invoiceId })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
  }
  return drafted.invoiceId;
}

async function invoiceRow(t: TestTenant, invoiceId: string) {
  const [row] = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, t.ctx.slug), eq(invoices.invoiceId, invoiceId))),
  );
  return row;
}

async function discardAuditRow(t: TestTenant, invoiceId: string) {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, t.ctx.slug),
          eq(auditLog.eventType, 'renewal_auto_draft_discarded' as never),
        ),
      ),
  );
  return rows
    .map((r) => r.payload as Record<string, unknown>)
    .find((p) => p['invoice_id'] === invoiceId);
}

describe('107-auto-invoice Task 14 — discardAutoDraftedRenewal (live Neon)', () => {
  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-t14-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: PLAN_YEAR,
        planName: { en: 'Auto-Discard T14 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('(a) discards a genuine draft — row deleted + renewal_auto_draft_discarded{reason:manual} written', async () => {
    const memberId = await seedMember(tenant);
    const cycleId = await seedCycle(tenant, memberId);
    const invoiceId = await seedAutoDraft(tenant, memberId, cycleId);

    const result = await discardAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBe(invoiceId);
    expect(result.value.auditEmitted).toBe(true);

    // Hard-deleted — the row no longer exists at all.
    expect(await invoiceRow(tenant, invoiceId)).toBeUndefined();

    const audit = await discardAuditRow(tenant, invoiceId);
    expect(audit).toMatchObject({
      cycle_id: cycleId,
      member_id: memberId,
      invoice_id: invoiceId,
      reason: 'manual',
    });
  }, 90_000);

  it('(b) an already-ISSUED invoice → not_draft, row left intact', async () => {
    const memberId = await seedMember(tenant);
    const cycleId = await seedCycle(tenant, memberId);
    const invoiceId = await seedAutoDraft(tenant, memberId, cycleId);

    const issued = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(issued.ok, issued.ok ? 'ok' : JSON.stringify(issued)).toBe(true);

    const result = await discardAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'not_draft' });

    // Untouched — still issued, not deleted.
    expect((await invoiceRow(tenant, invoiceId))?.status).toBe('issued');
  }, 90_000);

  it('(c) a non-existent id → not_found', async () => {
    const result = await discardAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId: randomUUID(),
      actorUserId: user.userId,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'not_found' });
  });

  it('(d) an orphaned draft (no stamped cycle) → still discarded, auditEmitted:false, no F8 audit row', async () => {
    const memberId = await seedMember(tenant);
    // No cycle stamped — Task 7's "orphaned after commit" window.
    const invoiceId = await seedAutoDraft(tenant, memberId, null);

    const result = await discardAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.auditEmitted).toBe(false);

    expect(await invoiceRow(tenant, invoiceId)).toBeUndefined();
    expect(await discardAuditRow(tenant, invoiceId)).toBeUndefined();
  }, 90_000);
});
