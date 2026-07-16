/**
 * 066 §4.4(2) (review C2) — the payment-on-terminated-member audit net at
 * the UNLINKED terminal_only exit (live Neon), fired through the REAL f8
 * on-paid callback chain (F4's record-payment callback loop, replicated):
 * a member with only terminal cycles + an unpaid membership invoice NOT
 * linked to any cycle → markCycleComplete finds no cycle → resolveUnlinked's
 * terminal_only branch → emits `payment_on_terminated_member` (retention 10y
 * via the migration-0257 trigger) + a metric + ONE open escalation task.
 *
 * The LINKED terminal-skip exit (a lapsed cycle's OWN linked invoice) is
 * covered deterministically at the unit level — see
 * `tests/unit/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.test.ts`
 * (the on-paid chain's reactivation logic makes the linked case awkward to
 * reproduce reliably end-to-end; the unit test pins the skip-branch net).
 * A non-terminal (upcoming) cycle must emit NO such event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalEscalationTasks } from '@/modules/renewals/infrastructure/schema-renewal-escalation-tasks';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Terminated Payer Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'net@example.com',
};

describe('066 payment_on_terminated_member net — both terminal exits (live Neon)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planId: string;
  let seq = 940_000;

  function membershipInvoice(memberId: string) {
    seq += 1;
    const invoiceId = randomUUID();
    return {
      invoiceId,
      row: {
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'issued' as const,
        dueDate: new Date(Date.now() - 70 * MS_PER_DAY).toISOString().slice(0, 10),
        pdfDocKind: 'invoice' as const,
        fiscalYear: 2026,
        sequenceNumber: seq,
        documentNumber: `INV-2026-${seq}`,
        issueDate: new Date(Date.now() - 100 * MS_PER_DAY).toISOString().slice(0, 10),
        currency: 'THB' as const,
        subtotalSatang: 5_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 350_000n,
        totalSatang: 5_350_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seq}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
      },
    };
  }

  function lapsedCycle(memberId: string, linkedInvoiceId: string | null) {
    return {
      tenantId: tenantA.ctx.slug,
      cycleId: randomUUID(),
      memberId,
      status: 'lapsed' as const,
      periodFrom: new Date(Date.now() - 400 * MS_PER_DAY),
      periodTo: new Date(Date.now() - 35 * MS_PER_DAY),
      expiresAt: new Date(Date.now() - 35 * MS_PER_DAY),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular' as const,
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB' as const,
      closedAt: new Date(Date.now() - 30 * MS_PER_DAY),
      closedReason: 'grace_expired' as const,
      ...(linkedInvoiceId ? { linkedInvoiceId } : {}),
    };
  }

  async function seedMember(companyName: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  function buildEvent(invoiceId: string, memberId: string, triggeredBy: F4InvoicePaidEvent['triggeredBy']): F4InvoicePaidEvent {
    return {
      tenantId: tenantA.ctx.slug,
      invoiceId,
      memberId,
      paidAt: '2026-09-30T09:00:00.000Z',
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy,
      invoiceSubject: 'membership',
      paymentDate: '2026-09-30',
    };
  }

  async function fireChain(evt: F4InvoicePaidEvent): Promise<void> {
    const callbacks = f8OnPaidCallbacks(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      for (const cb of callbacks) await cb(evt, tx);
    });
  }

  async function netAuditsFor(invoiceId: string) {
    return runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'payment_on_terminated_member'),
          ),
        ),
    ).then((rows) => rows.filter((r) => (r.payload as { invoice_id?: string }).invoice_id === invoiceId));
  }

  // retention_years is set by the migration-0257 DB trigger; it is not in
  // the drizzle audit_log schema, so read it via raw SQL.
  async function retentionOf(auditId: string): Promise<number> {
    const rows = await db.execute(
      sql`SELECT retention_years FROM audit_log WHERE id = ${auditId}`,
    );
    return Number((rows as unknown as Array<{ retention_years: number }>)[0]!.retention_years);
  }

  async function openTasksFor(memberId: string) {
    return runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalEscalationTasks)
        .where(
          and(
            eq(renewalEscalationTasks.tenantId, tenantA.ctx.slug),
            eq(renewalEscalationTasks.memberId, memberId),
            eq(renewalEscalationTasks.taskType, 'post_termination_payment_review'),
            eq(renewalEscalationTasks.status, 'open'),
          ),
        ),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    planId = `f8-net-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Net Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const table of [renewalEscalationTasks, invoices, renewalCycles, members, auditLog] as const) {
      await db.delete(table).where(eq(table.tenantId, tenantA.ctx.slug)).catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('UNLINKED terminal_only: emits payment_on_terminated_member (10y) + one open task', async () => {
    const memberId = await seedMember('Unlinked Terminal Co');
    const { invoiceId, row } = membershipInvoice(memberId);
    await runInTenant(tenantA.ctx, (tx) => tx.insert(invoices).values(row));
    // A terminal (lapsed) cycle NOT linked to this invoice.
    await runInTenant(tenantA.ctx, (tx) => tx.insert(renewalCycles).values(lapsedCycle(memberId, null)));

    await fireChain(buildEvent(invoiceId, memberId, 'webhook'));

    const audits = await netAuditsFor(invoiceId);
    expect(audits).toHaveLength(1);
    const payload = audits[0]!.payload as { heal_site: string; cycle_id: string | null };
    expect(payload.heal_site).toBe('terminal_only');
    expect(payload.cycle_id).toBeNull();
    expect(await retentionOf(audits[0]!.id)).toBe(10);
    expect(await openTasksFor(memberId)).toHaveLength(1);
  }, 120_000);

  it('non-terminal cycle (upcoming) → NO payment_on_terminated_member event', async () => {
    const memberId = await seedMember('Good Standing Co');
    const { invoiceId, row } = membershipInvoice(memberId);
    await runInTenant(tenantA.ctx, (tx) => tx.insert(invoices).values(row));
    // An OPEN (upcoming, unexpired) cycle → member in good standing.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        ...lapsedCycle(memberId, null),
        status: 'upcoming',
        periodFrom: new Date(Date.now() - 10 * MS_PER_DAY),
        periodTo: new Date(Date.now() + 355 * MS_PER_DAY),
        expiresAt: new Date(Date.now() + 355 * MS_PER_DAY),
        closedAt: null,
        closedReason: null,
      }),
    );

    await fireChain(buildEvent(invoiceId, memberId, 'webhook'));
    expect(await netAuditsFor(invoiceId)).toHaveLength(0);
  }, 120_000);
});
