/**
 * 107-auto-invoice Task 12 — §5.8a reminder-stream handoff (live Neon).
 *
 * STEP 0 finding: `listDueTrackCandidates`'s existing member-scoped
 * `oldestBillDueDate` subquery (drizzle-dispatch-candidate-repo.ts:422-433)
 * floors at `period_from − MAX_INVOICE_ISSUANCE_LEAD_DAYS(60)`. A freshly
 * auto-issued bill's `due_date = issueDate + tenant.default_net_days`
 * (issue-invoice.ts:643) is NOT guaranteed to clear that floor: a tenant may
 * configure `auto_invoice_lead_days_rolling/_calendar` up to 120 days
 * (`tenant_invoice_settings_auto_lead_days_ck`, schema-tenant-invoice-
 * settings.ts:159-166), and `default_net_days` down to 0
 * (update-tenant-invoice-settings.ts:76). A tenant with
 * lead=120/net=30 (both realistic, in-bounds configs — the lead knob
 * defaults to 30 but a chamber wanting "4 months' notice" can set 120) that
 * issues on the SAME day the cron drafted yields
 * `due_date = period_from − 120d + 30d = period_from − 90d`, which is BELOW
 * the −60d floor — so the existing arm silently excludes the cycle even
 * though it unambiguously carries a live issued bill (Task 9's tx2 CAS
 * always stamps `linked_invoice_id` + `status='awaiting_payment'` together).
 * This file pins the fix: an ISOLATED cycle-linked signal
 * (`renewal_cycles.linked_invoice_id IS NOT NULL` → a live `issued`
 * membership bill) that only ADDS cycles the floor-based arm misses, while
 * leaving the quiet window `[expiry, due+7)` untouched for cycles that hold
 * no bill at all (the converse pin, case NOBILL — mirrors
 * `due-track-dispatch.test.ts` case F).
 *
 * Geometry mirrors `due-track-dispatch.test.ts` case F/H: both cycles
 * expire TODAY so the ladder's `t+0.email` step is due — the only way to
 * observe "did due-track suppress the ladder email" on the SAME pass.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { dispatchRenewalCycle, makeRenewalsDeps } from '@/modules/renewals';
import { makeDrizzleDispatchCandidateRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function dateOnly(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString().slice(0, 10);
}

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Handoff Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'handoff@example.com',
};

interface CaseIds {
  memberId: string;
  cycleId: string;
}
function ids(): CaseIds {
  return { memberId: randomUUID(), cycleId: randomUUID() };
}

describe('107 Task 12 — §5.8a due-track handoff for a cycle-linked auto-issued bill (live Neon)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planId: string;

  // HANDOFF — auto-issued bill, due_date BELOW the period_from−60d floor
  // (mirrors case H's "expires today, bill past due+30" geometry).
  const caseHandoff = ids();
  // NOBILL — quiet-window converse (mirrors case F: no bill at all).
  const caseNoBill = ids();

  let seq = 930_000;
  function bill(memberId: string, dueDate: string) {
    seq += 1;
    return {
      tenantId: tenantA.ctx.slug,
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: 'issued' as const,
      dueDate,
      pdfDocKind: 'invoice' as const,
      fiscalYear: 2026,
      sequenceNumber: seq,
      documentNumber: `INV-2026-${seq}`,
      issueDate: dateOnly(-450 * MS_PER_DAY),
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
    };
  }

  function cycle(
    c: CaseIds,
    opts: { periodFromMs: number; expiresMs: number; linkedInvoiceId?: string },
  ) {
    return {
      tenantId: tenantA.ctx.slug,
      cycleId: c.cycleId,
      memberId: c.memberId,
      status: 'awaiting_payment' as const,
      periodFrom: new Date(Date.now() + opts.periodFromMs),
      periodTo: new Date(Date.now() + opts.expiresMs),
      expiresAt: new Date(Date.now() + opts.expiresMs),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular' as const,
      planIdAtCycleStart: randomUUID(),
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB' as const,
      ...(opts.linkedInvoiceId !== undefined
        ? { linkedInvoiceId: opts.linkedInvoiceId }
        : {}),
    };
  }

  async function seedMember(c: CaseIds, name: string) {
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: c.memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: name,
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: c.memberId,
        firstName: 'Anna',
        lastName: 'Handoff',
        email: `handoff-${randomUUID().slice(0, 8)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
    });
  }

  async function reminderRows(cycleId: string) {
    return runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalReminderEvents)
        .where(
          and(
            eq(renewalReminderEvents.tenantId, tenantA.ctx.slug),
            eq(renewalReminderEvents.cycleId, cycleId),
          ),
        ),
    );
  }

  // periodFrom −365d / expiresAt today — the F/H geometry: the t+0.email
  // ladder step is due on both cycles today, so suppression is observable.
  const PERIOD_FROM_MS = -365 * MS_PER_DAY;
  const EXPIRES_MS = 0;
  // Floor = period_from − 60d = now − 425d. This due_date sits BELOW it
  // (now − 430d < now − 425d) — the exact gap STEP 0 identified: a live,
  // cycle-linked issued bill the floor-based arm alone would miss.
  const HANDOFF_BILL_DUE = dateOnly(-430 * MS_PER_DAY);

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenantA.ctx);
    planId = `f8-handoff-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Handoff Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await seedMember(caseHandoff, 'Case Handoff Co');
    await seedMember(caseNoBill, 'Case No Bill Co');

    // Invoice MUST exist before the cycle FK-references it via
    // `linked_invoice_id` (renewal_cycles_linked_invoice_fk).
    const handoffInvoice = bill(caseHandoff.memberId, HANDOFF_BILL_DUE);
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values([handoffInvoice]),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values([
        cycle(caseHandoff, {
          periodFromMs: PERIOD_FROM_MS,
          expiresMs: EXPIRES_MS,
          linkedInvoiceId: handoffInvoice.invoiceId,
        }),
        // NOBILL deliberately has NO invoice and NO linked_invoice_id —
        // the quiet-window converse (case F's twin).
        cycle(caseNoBill, { periodFromMs: PERIOD_FROM_MS, expiresMs: EXPIRES_MS }),
      ]),
    );
  }, 120_000);

  afterAll(async () => {
    for (const table of [
      renewalReminderEvents,
      invoices,
      renewalCycles,
      contacts,
      members,
      auditLog,
    ] as const) {
      await db
        .delete(table)
        .where(eq(table.tenantId, tenantA.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('listDueTrackCandidates: includes the cycle-linked HANDOFF cycle (floor-based arm alone would miss it), excludes NOBILL', async () => {
    const repo = makeDrizzleDispatchCandidateRepo(tenantA.ctx);
    const items = [];
    let cursor: string | null = null;
    do {
      const page = await repo.listDueTrackCandidates(tenantA.ctx.slug, {
        pageSize: 50,
        cursor,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    const handoffHit = items.find((c) => c.cycle.cycleId === caseHandoff.cycleId);
    expect(handoffHit).toBeDefined();
    // The COALESCE fallback must surface the CYCLE'S OWN linked bill's
    // due_date — not null, not silently dropped by the −60d floor.
    expect(handoffHit!.billDueDate).toBe(HANDOFF_BILL_DUE);

    expect(items.map((c) => c.cycle.cycleId)).not.toContain(caseNoBill.cycleId);
  });

  it('dispatch pass: HANDOFF gets ONE stream (ladder t+0.email suppressed, due-track fires); NOBILL quiet window unchanged (ladder fires, no due-track send)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const gatewaySpy = vi
      .spyOn(deps.renewalGateway, 'sendRenewalEmail')
      .mockResolvedValue({
        ok: true,
        value: {
          deliveryId: `mock-${randomUUID().slice(0, 8)}`,
          dispatchedAt: new Date().toISOString(),
        },
      } as never);

    const r1 = await dispatchRenewalCycle(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // HANDOFF — due-track owns the stream: due+30.email fires (most-severe
    // unsent step, same no-spam supersede policy as case B/H), and the
    // ladder's t+0.email is ABSENT (suppressed by `dueTrackCycleIds`).
    const rowsHandoff = await reminderRows(caseHandoff.cycleId);
    const stepIdsHandoff = rowsHandoff.map((r) => r.stepId);
    expect(stepIdsHandoff).toContain('due+30.email');
    expect(stepIdsHandoff).not.toContain('t+0.email');
    expect(rowsHandoff.find((r) => r.stepId === 'due+30.email')!.templateId).toBe(
      'due-track',
    );

    // NOBILL — converse: quiet window `[expiry, due+7)` unchanged. No bill
    // at all ⇒ never enters `dueTrackCycleIds` ⇒ the ordinary ladder
    // t+0.email is NOT suppressed, and due-track sends nothing.
    const rowsNoBill = await reminderRows(caseNoBill.cycleId);
    const stepIdsNoBill = rowsNoBill.map((r) => r.stepId);
    expect(stepIdsNoBill).toContain('t+0.email');
    expect(stepIdsNoBill.some((s) => s.startsWith('due+'))).toBe(false);

    const dueTrackCalls = gatewaySpy.mock.calls.filter(([input]) =>
      String(input.stepId).startsWith('due+'),
    );
    // Exactly one due-track send this pass (HANDOFF only — NOBILL never
    // reaches the due-track arm).
    expect(dueTrackCalls).toHaveLength(1);
  }, 120_000);
});
