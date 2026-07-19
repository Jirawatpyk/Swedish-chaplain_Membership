/**
 * 107-auto-invoice Task 9 — `issueAutoDraftedRenewal` integration test (live
 * Neon). THE tax-sensitive path: it mints a real §86/4-era membership bill
 * from a cron-created `origin='auto_renewal'` draft.
 *
 * Scenario map (each `it` names its brief item):
 *
 *   (a) Issue silently (`sendEmail:false`, tenant `auto_email_enabled=true`)
 *       → number minted, cycle `awaiting_payment` + `linked_invoice_id` set,
 *       ZERO outbox rows (the tenant default must NOT leak through).
 *   (b) Issue + Send → exactly ONE outbox row.
 *   (b2) Issue + Send for a member with NO primary contact → succeeds,
 *       skipped-with-warning, zero outbox (F4's empty-recipient guard).
 *   (c) Member terminated AFTER the draft → refused INSIDE the use-case
 *       (`member_terminated`); the draft is untouched.
 *   (d) ⛔ SHIP-BLOCKER — paid-race content guard. An orphan/unlinked bill
 *       B1 already `paid` for (member, planYear) → Issue REFUSED
 *       (`duplicate_live_bill`); no second §86/4 is minted.
 *   (e) HARD REQ #1 — shape checks. `origin='manual'` → refused; a draft
 *       whose stamped cycle belongs to a DIFFERENT member → refused; a
 *       `plan_year` that drifted from `deriveFiscalYear(cycle.periodFrom)`
 *       → refused. None of them ever issue.
 *   (f) Draft-discard — a sibling `origin='auto_renewal' status='draft'`
 *       for the same (member, planYear) is discarded on issue with a
 *       `renewal_auto_draft_discarded { reason:'superseded_on_issue' }`
 *       audit row; and the status-guarded delete refuses to clobber an
 *       already-promoted (issued) invoice.
 *   (g) Orphan recovery — the link step is forced to fail ONCE; the
 *       idempotent retry re-links, no duplicate invoice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  confirmRenewal,
  issueAutoDraftedRenewal,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const NOW = new Date('2026-07-15T00:00:00.000Z');
/** Every fixture cycle starts here → `deriveFiscalYear(periodFrom)` = 2025. */
const PERIOD_FROM = '2025-08-01T00:00:00Z';
const PLAN_YEAR = deriveFiscalYear(PERIOD_FROM);

let tenant: TestTenant;
let user: TestUser;
let planId: string;

function depsFor(t: TestTenant) {
  const real = makeRenewalsDeps(t.ctx.slug);
  return { ...real, clock: { now: () => NOW } };
}

async function seedMember(opts: {
  readonly t: TestTenant;
  readonly withContact?: boolean;
}): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(opts.t.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: opts.t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Auto-Issue T9 Co ${memberId.slice(0, 6)}`,
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
    if (opts.withContact !== false) {
      await tx.insert(contacts).values({
        tenantId: opts.t.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Auto',
        lastName: 'Issue',
        email: `auto.${memberId.slice(0, 8)}@member.example`,
        isPrimary: true,
      });
    }
  });
  return memberId;
}

async function seedCycle(opts: {
  readonly t: TestTenant;
  readonly memberId: string;
}): Promise<{ readonly cycleId: string; readonly periodTo: Date }> {
  const cycleId = randomUUID();
  const periodFrom = new Date(PERIOD_FROM);
  const periodTo = new Date(periodFrom);
  periodTo.setUTCMonth(periodTo.getUTCMonth() + 12);
  await runInTenant(opts.t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: opts.t.ctx.slug,
      cycleId,
      memberId: opts.memberId,
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
  return { cycleId, periodTo };
}

/** Creates a genuine `origin='auto_renewal'` draft via the T5 bridge (the
 *  exact call Task 7's cron makes) and stamps it onto the cycle. */
async function seedAutoDraft(opts: {
  readonly t: TestTenant;
  readonly memberId: string;
  readonly cycleId: string | null;
}): Promise<string> {
  const deps = depsFor(opts.t);
  const drafted = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
    tenantId: opts.t.ctx.slug,
    memberId: opts.memberId,
    planId,
    planYear: PLAN_YEAR,
    frozenPlanPriceThb: '50000.00' as never,
    actorUserId: user.userId,
    requestId: null,
  });
  if (drafted.status !== 'drafted') {
    throw new Error(`fixture draft failed: ${JSON.stringify(drafted)}`);
  }
  if (opts.cycleId !== null) {
    const cycleId = opts.cycleId;
    await runInTenant(opts.t.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: drafted.invoiceId })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
  }
  return drafted.invoiceId;
}

/** member + cycle + stamped auto-draft, the standard queue-row fixture. */
async function seedQueueRow(opts: {
  readonly t: TestTenant;
  readonly withContact?: boolean;
}): Promise<{
  readonly memberId: string;
  readonly cycleId: string;
  readonly invoiceId: string;
}> {
  const memberId = await seedMember({
    t: opts.t,
    ...(opts.withContact !== undefined ? { withContact: opts.withContact } : {}),
  });
  const { cycleId } = await seedCycle({ t: opts.t, memberId });
  const invoiceId = await seedAutoDraft({ t: opts.t, memberId, cycleId });
  return { memberId, cycleId, invoiceId };
}

async function invoiceRow(t: TestTenant, invoiceId: string) {
  const [row] = await runInTenant(t.ctx, (tx) =>
    tx
      .select({
        status: invoices.status,
        origin: invoices.origin,
        planYear: invoices.planYear,
        documentNumber: invoices.documentNumber,
        billDocumentNumberRaw: invoices.billDocumentNumberRaw,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, t.ctx.slug), eq(invoices.invoiceId, invoiceId))),
  );
  return row;
}

async function cycleRow(t: TestTenant, cycleId: string) {
  const [row] = await runInTenant(t.ctx, (tx) =>
    tx
      .select({
        status: renewalCycles.status,
        linkedInvoiceId: renewalCycles.linkedInvoiceId,
      })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId)),
  );
  return row;
}

async function outboxCountForInvoice(t: TestTenant, invoiceId: string): Promise<number> {
  const rows = await db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.tenantId, t.ctx.slug),
        eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
      ),
    );
  return rows.filter(
    (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
  ).length;
}

describe('107-auto-invoice Task 9 — issueAutoDraftedRenewal (live Neon)', () => {
  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-t9-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: PLAN_YEAR,
        planName: { en: 'Auto-Issue T9 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    // `auto_email_enabled=true` is the DEFAULT — scenario (a) proves the
    // explicit `sendEmail:false` intent OUTRANKS it (the T4 override gotcha).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(tenantInvoiceSettings)
        .set({ autoEmailEnabled: true, autoInvoiceEnabled: true })
        .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
    );
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('(a) issue silently → number minted, cycle awaiting_payment + linked, ZERO outbox', async () => {
    const { cycleId, invoiceId } = await seedQueueRow({ t: tenant });

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBe(invoiceId);
    expect(result.value.invoiceNumber).not.toBe('');
    expect(result.value.linkWarning).toBeNull();

    const inv = await invoiceRow(tenant, invoiceId);
    expect(inv?.status).toBe('issued');
    // Exactly one of the two number columns is populated (088 flag-dependent).
    expect(
      (inv?.documentNumber ?? null) !== null ||
        (inv?.billDocumentNumberRaw ?? null) !== null,
    ).toBe(true);

    const cyc = await cycleRow(tenant, cycleId);
    expect(cyc?.status).toBe('awaiting_payment');
    expect(cyc?.linkedInvoiceId).toBe(invoiceId);

    expect(await outboxCountForInvoice(tenant, invoiceId)).toBe(0);
  }, 90_000);

  it('(b) issue + send → exactly ONE outbox row', async () => {
    const { invoiceId } = await seedQueueRow({ t: tenant });

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: true,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    expect(await outboxCountForInvoice(tenant, invoiceId)).toBe(1);
  }, 90_000);

  it('(b2) issue + send, member has NO primary contact → succeeds, skipped, zero outbox', async () => {
    const { invoiceId } = await seedQueueRow({ t: tenant, withContact: false });

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: true,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    expect((await invoiceRow(tenant, invoiceId))?.status).toBe('issued');
    expect(await outboxCountForInvoice(tenant, invoiceId)).toBe(0);
  }, 90_000);

  it('(c) member terminated after the draft → member_terminated, draft untouched', async () => {
    const { memberId, invoiceId } = await seedQueueRow({ t: tenant });
    // A NEWER `lapsed` cycle makes `findLatestCycleForMember` resolve
    // `terminated` (the same shape Task 7's test (c) uses).
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'lapsed',
        periodFrom: new Date('2026-01-01T00:00:00Z'),
        periodTo: new Date('2027-01-01T00:00:00Z'),
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date('2026-06-01T00:00:00Z'),
        closedReason: 'grace_expired',
      }),
    );

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_terminated');
    expect((await invoiceRow(tenant, invoiceId))?.status).toBe('draft');
  }, 90_000);

  it('(d) ⛔ SHIP-BLOCKER — a PAID bill for (member, planYear) → duplicate_live_bill, no second §86/4', async () => {
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    // B1 — an orphan/unlinked membership bill for the SAME (member,
    // planYear) that has already been paid. Built through the real F4
    // issue path so it carries a real §87/bill number, then marked paid
    // directly (the settlement path itself is out of scope here).
    const b1 = await seedAutoDraft({ t: tenant, memberId, cycleId: null });
    const deps = depsFor(tenant);
    const issuedB1 = await deps.f4InvoicingBridge.issueExistingDraftForRenewal({
      tenantId: tenant.ctx.slug,
      invoiceId: b1,
      actorUserId: user.userId,
      autoEmailOnIssue: false,
      requestId: null,
    });
    expect(issuedB1.status).toBe('issued');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        // Satisfies the paid-row CHECKs: `invoices_paid_has_payment`
        // (paid_at + payment_method) and `invoices_paid_has_receipt_status`
        // (receipt_pdf_status NOT NULL).
        .set({
          status: 'paid',
          paidAt: new Date('2026-07-01T00:00:00Z'),
          paymentMethod: 'bank_transfer',
          receiptPdfStatus: 'pending',
        })
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, b1))),
    );

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('duplicate_live_bill');

    // The draft is STILL a draft — no number was burned, no second §86/4.
    const inv = await invoiceRow(tenant, invoiceId);
    expect(inv?.status).toBe('draft');
    expect(inv?.documentNumber).toBeNull();
    expect(inv?.billDocumentNumberRaw).toBeNull();
    // The cycle was NOT flipped/linked either.
    const cyc = await cycleRow(tenant, cycleId);
    expect(cyc?.status).toBe('upcoming');
    expect(cyc?.linkedInvoiceId).toBeNull();
  }, 120_000);

  it('(e) HARD REQ #1 — manual origin / cross-member / plan_year drift are all refused, never issued', async () => {
    // --- e1: origin='manual' (a treasurer's own draft) ------------------
    const manualMember = await seedMember({ t: tenant });
    const { cycleId: manualCycle } = await seedCycle({ t: tenant, memberId: manualMember });
    const deps = depsFor(tenant);
    const manualDraft = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId: manualMember,
      planId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '50000.00' as never,
      actorUserId: user.userId,
      requestId: null,
    });
    if (manualDraft.status !== 'drafted') throw new Error('fixture failed');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(invoices)
        .set({ origin: 'manual' })
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, manualDraft.invoiceId),
          ),
        );
      await tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: manualDraft.invoiceId })
        .where(eq(renewalCycles.cycleId, manualCycle));
    });

    const e1 = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId: manualDraft.invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(e1.ok).toBe(false);
    if (!e1.ok) expect(e1.error.kind).toBe('invalid_draft');
    expect((await invoiceRow(tenant, manualDraft.invoiceId))?.status).toBe('draft');

    // --- e2: the stamped cycle belongs to a DIFFERENT member -----------
    const ownerA = await seedQueueRow({ t: tenant });
    const strangerB = await seedMember({ t: tenant });
    const { cycleId: strangerCycle } = await seedCycle({ t: tenant, memberId: strangerB });
    // Point B's cycle at A's draft — the "wrong/stale invoiceId" shape.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: null })
        .where(eq(renewalCycles.cycleId, ownerA.cycleId));
      await tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: ownerA.invoiceId })
        .where(eq(renewalCycles.cycleId, strangerCycle));
    });

    const e2 = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId: ownerA.invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(e2.ok).toBe(false);
    if (!e2.ok) expect(e2.error.kind).toBe('invalid_draft');
    expect((await invoiceRow(tenant, ownerA.invoiceId))?.status).toBe('draft');

    // --- e3: plan_year drift (a post-draft re-anchor moved periodFrom) --
    const drift = await seedQueueRow({ t: tenant });
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        // periodFrom now derives fiscal year 2023, but the draft carries 2025.
        // Moved BACKWARD, not forward: `renewal_cycles_period_order_check`
        // requires period_from < period_to (which stays 2026-08-01).
        .set({ periodFrom: new Date('2023-03-01T00:00:00Z') })
        .where(eq(renewalCycles.cycleId, drift.cycleId)),
    );

    const e3 = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId: drift.invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(e3.ok).toBe(false);
    if (!e3.ok) expect(e3.error.kind).toBe('invalid_draft');
    expect((await invoiceRow(tenant, drift.invoiceId))?.status).toBe('draft');
  }, 120_000);

  it('(f) draft-discard — sibling auto_renewal draft discarded + audited; an issued invoice is NOT clobbered', async () => {
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    // A sibling auto-draft for the SAME (member, planYear) — the harmless
    // double-DRAFT shape design §5.4 tolerates and tx3 cleans up.
    const sibling = await seedAutoDraft({ t: tenant, memberId, cycleId: null });

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.discardedInvoiceIds).toContain(sibling);

    // The sibling is GONE; the issued one survives.
    expect(await invoiceRow(tenant, sibling)).toBeUndefined();
    expect((await invoiceRow(tenant, invoiceId))?.status).toBe('issued');

    const discardAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_auto_draft_discarded' as never),
          ),
        ),
    );
    const mine = discardAudits.filter(
      (r) => (r.payload as Record<string, unknown>).invoice_id === sibling,
    );
    expect(mine.length).toBe(1);
    expect(mine[0]?.payload).toMatchObject({
      cycle_id: cycleId,
      member_id: memberId,
      invoice_id: sibling,
      reason: 'superseded_on_issue',
    });

    // --- review Important 3: the sweep must NOT write a false intrusion ---
    // `invoice_cross_tenant_probe` is a cross-tenant INTRUSION signal wired to
    // alerting. The sweep enumerates ids from its own tenant-scoped read, so a
    // vanished row is benign and must never surface as a probe.
    const probeAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_cross_tenant_probe' as never),
          ),
        ),
    );
    const probesForSweptRows = probeAudits.filter((r) => {
      const p = r.payload as Record<string, unknown>;
      return p.attempted_invoice_id === sibling || p.attempted_invoice_id === invoiceId;
    });
    expect(probesForSweptRows.length).toBe(0);

    // --- the status-guarded delete must NOT clobber a promoted draft ----
    // (the concurrent-promotion case: by the time the discard runs, the
    // row is already `issued` and carries a burned document number).
    const deps = depsFor(tenant);
    const discardIssued = await deps.f4InvoicingBridge.discardAutoDraftForRenewal({
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      requestId: null,
    });
    expect(discardIssued.status).toBe('not_draft');
    expect((await invoiceRow(tenant, invoiceId))?.status).toBe('issued');
  }, 120_000);

  it('(h) ⛔ review Critical 1 — interleaved sibling issues mint at most ONE number', async () => {
    // The regression that the earlier (post-issue discard + draft excluded
    // from the blocking set) design allowed:
    //
    //   t0  Issue(D1) tx1: sees D2 as draft → not blocked → COMMIT
    //   t1  Issue(D2) tx1: sees D1 still draft → not blocked → COMMIT
    //   t2  Issue(D1) mints SC-0001   t3  Issue(D2) mints SC-0002  ← TWO §86/4
    //
    // Both tx1s are forced to complete BEFORE either is allowed to mint, via a
    // barrier on the issue call — so this fails loudly under that design and
    // passes only when the guard actually serialises the two.
    const { memberId, cycleId, invoiceId: d1 } = await seedQueueRow({ t: tenant });
    const d2 = await seedAutoDraft({ t: tenant, memberId, cycleId: null });
    // D2 needs its OWN cycle, otherwise it resolves `cycle_not_found` and the
    // race cannot be attempted at all (`auto_draft_invoice_id` is a single
    // column, so one cycle can carry only one draft).
    //
    // That second cycle must be `cancelled`: `renewal_cycles_active_member_uniq`
    // is UNIQUE (tenant_id, member_id) WHERE status NOT IN (lapsed, cancelled,
    // completed), so a member cannot hold two non-terminal cycles. This is the
    // genuine worst case — two issuable drafts for one (member, planYear)
    // sitting on DIFFERENT cycles, hence different advisory locks, so the lock
    // alone cannot serialise them and only the guard can.
    //
    // `expiresAt` stays in the future so `deriveMembershipAccess` on the
    // cancelled cycle resolves `full`, not `terminated` — otherwise the
    // membership gate would refuse first and the race would never be reached.
    const cycle2 = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycle2,
        memberId,
        status: 'cancelled',
        periodFrom: new Date(PERIOD_FROM),
        periodTo: new Date('2026-08-01T00:00:00Z'),
        expiresAt: new Date('2026-08-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date(PERIOD_FROM),
        autoDraftInvoiceId: d2,
        createdAt: new Date('2020-01-01T00:00:00Z'), // older, so it is not "latest"
        closedAt: new Date('2026-06-01T00:00:00Z'),
        closedReason: 'cancelled',
      }),
    );

    const real = makeRenewalsDeps(tenant.ctx.slug);
    let arrived = 0;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const barrieredBridge: typeof real.f4InvoicingBridge = {
      ...real.f4InvoicingBridge,
      issueExistingDraftForRenewal: async (args) => {
        // Hold the FIRST arrival until the second reaches the same point (or
        // the second is refused and never arrives — hence the timeout).
        arrived += 1;
        if (arrived >= 2) releaseBarrier();
        await Promise.race([
          barrier,
          new Promise<void>((r) => setTimeout(r, 3000)),
        ]);
        return real.f4InvoicingBridge.issueExistingDraftForRenewal(args);
      },
    };
    const deps = {
      ...real,
      f4InvoicingBridge: barrieredBridge,
      clock: { now: () => NOW },
    };

    const [r1, r2] = await Promise.all([
      issueAutoDraftedRenewal(deps, {
        tenantId: tenant.ctx.slug,
        invoiceId: d1,
        actorUserId: user.userId,
        sendEmail: false,
        requestId: null,
      }),
      issueAutoDraftedRenewal(deps, {
        tenantId: tenant.ctx.slug,
        invoiceId: d2,
        actorUserId: user.userId,
        sendEmail: false,
        requestId: null,
      }),
    ]);

    // THE invariant: across both attempts, at most one numbered §86/4 exists
    // for this (member, planYear). Which one wins is not specified.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
        })
        .from(invoices)
        .where(
          and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberId)),
        ),
    );
    const numbered = rows.filter(
      (r) => r.documentNumber !== null || r.billDocumentNumberRaw !== null,
    );
    expect(
      numbered.length,
      `expected ≤1 numbered bill, got ${numbered.length}: ${JSON.stringify(numbered)}`,
    ).toBeLessThanOrEqual(1);
    // And at most one call may report success.
    expect([r1.ok, r2.ok].filter(Boolean).length).toBeLessThanOrEqual(1);

    void cycleId;
  }, 180_000);

  it('(i) review Important 2 — confirmRenewal refuses once the queue issued a bill', async () => {
    // Task 9 makes "admin issues from the queue, THEN the member clicks
    // Confirm & Pay" a routine sequence. Without a write-path guard in
    // confirmRenewal, that mints a SECOND number, then fails to link, leaving
    // an orphan that must be voided — a phantom cancelled doc in ภ.พ.30.
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    const issue = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(issue.ok, issue.ok ? 'ok' : JSON.stringify(issue)).toBe(true);

    const before = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberId))),
    );

    const confirm = await confirmRenewal(depsFor(tenant) as never, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });

    expect(confirm.ok).toBe(false);
    if (!confirm.ok) {
      expect(confirm.error.kind).toBe('invoice_already_exists');
    }
    // No second document was created.
    const after = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberId))),
    );
    expect(after.length).toBe(before.length);
  }, 120_000);

  it('(j) review New-1 — a VOIDED bill must not wedge the member out of renewing', async () => {
    // The wedge an earlier revision of the confirmRenewal guard created: it
    // also blocked on `cycle.linkedInvoiceId !== null`, but voiding does NOT
    // clear that column (only `reanchorPeriodInTx` does) and there is no
    // void→renewals callback. A bill voided FOR CORRECTION therefore left the
    // member permanently unable to renew, and the route handed back the
    // VOIDED invoice's id — sending them to "pay" a cancelled document.
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    const issue = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });
    expect(issue.ok, issue.ok ? 'ok' : JSON.stringify(issue)).toBe(true);

    // Treasurer voids it for correction. `linked_invoice_id` deliberately
    // stays pointing at the voided row — that is the real-world state.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(invoices)
        .set({
          status: 'void',
          voidedAt: new Date('2026-07-16T00:00:00Z'),
          voidReason: 'issued in error — correction',
          voidedByUserId: user.userId,
        })
        .where(
          and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)),
        ),
    );
    const linked = await cycleRow(tenant, cycleId);
    expect(linked?.linkedInvoiceId).toBe(invoiceId); // the stale link persists

    // The member must now be able to renew again.
    const confirm = await confirmRenewal(depsFor(tenant) as never, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(
      confirm.ok,
      confirm.ok ? 'ok' : `wedged: ${JSON.stringify(confirm)}`,
    ).toBe(true);
  }, 120_000);

  it('(k) review New-3 — a refused confirm must not flip the cycle or emit entered_awaiting', async () => {
    // Returning `err(...)` from inside `runInTenant` does NOT throw, so tx1
    // COMMITS. A guard placed below the lazy `upcoming → awaiting_payment`
    // flip would therefore leave a refused confirm having still flipped the
    // cycle and emitted `renewal_entered_awaiting_payment { source:'confirm' }`
    // for a confirm that never happened.
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    // Park a live bill so confirm is refused, WITHOUT issuing (which would
    // itself flip the cycle) — the cycle stays `upcoming`.
    const rival = await seedAutoDraft({ t: tenant, memberId, cycleId: null });
    expect(rival).not.toBe(invoiceId);

    const before = await cycleRow(tenant, cycleId);
    expect(before?.status).toBe('upcoming');

    const confirm = await confirmRenewal(depsFor(tenant) as never, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.error.kind).toBe('invoice_already_exists');

    // The cycle must be untouched.
    const after = await cycleRow(tenant, cycleId);
    expect(after?.status).toBe('upcoming');
    expect(after?.linkedInvoiceId).toBeNull();

    // …and no untrue audit row for a confirm that never happened.
    const entered = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_entered_awaiting_payment' as never),
          ),
        ),
    );
    const forThisCycle = entered.filter(
      (r) => (r.payload as Record<string, unknown>).cycle_id === cycleId,
    );
    expect(forThisCycle.length).toBe(0);
  }, 120_000);

  it('(g) orphan recovery — link forced to fail once → idempotent retry re-links', async () => {
    const { cycleId, invoiceId } = await seedQueueRow({ t: tenant });

    const real = makeRenewalsDeps(tenant.ctx.slug);
    let failures = 0;
    const flakyCyclesRepo: typeof real.cyclesRepo = {
      ...real.cyclesRepo,
      transitionStatus: async (tx, tid, cid, args) => {
        if (cid === cycleId && failures === 0) {
          failures += 1;
          throw new Error('simulated link failure — orphan recovery test');
        }
        return real.cyclesRepo.transitionStatus(tx, tid, cid, args);
      },
    };
    const deps = { ...real, cyclesRepo: flakyCyclesRepo, clock: { now: () => NOW } };

    const result = await issueAutoDraftedRenewal(deps, {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(failures).toBe(1);
    // The retry succeeded — no warning, cycle correctly linked ONCE.
    expect(result.value.linkWarning).toBeNull();
    const cyc = await cycleRow(tenant, cycleId);
    expect(cyc?.status).toBe('awaiting_payment');
    expect(cyc?.linkedInvoiceId).toBe(invoiceId);

    // Exactly one invoice exists for this member — no duplicate was minted.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId))),
    );
    expect(rows.length).toBe(1);
  }, 120_000);

  it('(l) ⛔ GDPR Art.17 — an ERASED member is refused, ABOVE the sibling sweep', async () => {
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    // A sibling auto-draft for the same (member, planYear). Its survival is
    // what proves the erasure guard sits ABOVE `discardSupersededDrafts`:
    // `return err(...)` inside `runInTenant` does NOT roll the tx back, so a
    // guard placed below the sweep would COMMIT this row's deletion (and a
    // `renewal_auto_draft_discarded` audit row) for an issue that never
    // happened.
    const siblingId = await seedAutoDraft({ t: tenant, memberId, cycleId: null });

    // Erase. `scrubPiiInTx` keeps `status` and the cycle untouched ("erasure
    // is orthogonal to archive") and stamps only `erased_at`, scrubbing
    // `company_name` to '[erased]'. The cycle therefore stays `upcoming` with
    // a FUTURE `expires_at`, so `deriveMembershipAccess` still returns `full`
    // — the `member_terminated` gate provably does NOT catch this, which is
    // the entire reason this guard has to exist separately.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(members)
        .set({ erasedAt: new Date('2026-07-01T00:00:00Z'), companyName: '[erased]' })
        .where(
          and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId)),
        ),
    );

    const result = await issueAutoDraftedRenewal(depsFor(tenant), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_erased');

    // No §86/4 number was minted and the draft is untouched.
    const inv = await invoiceRow(tenant, invoiceId);
    expect(inv?.status).toBe('draft');
    expect(inv?.documentNumber).toBeNull();

    // The cycle was neither flipped nor linked.
    const cyc = await cycleRow(tenant, cycleId);
    expect(cyc?.status).toBe('upcoming');
    expect(cyc?.linkedInvoiceId).toBeNull();

    // GUARD-ORDERING ASSERTION — the sibling must still be a live draft.
    const sibling = await invoiceRow(tenant, siblingId);
    expect(sibling?.status).toBe('draft');

    // …and no supersede audit row was written for it.
    const discardRows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_auto_draft_discarded' as never),
        ),
      );
    const forSibling = discardRows.filter(
      (r) => (r.payload as Record<string, unknown> | null)?.invoice_id === siblingId,
    );
    expect(forSibling.length).toBe(0);
  }, 120_000);

  it('(m) ⛔ an UNREADABLE member row (null guards) fails CLOSED, not open', async () => {
    // `readReactivationGuardsInTx` documents `null` as "the member row is not
    // visible (RLS-hidden / absent)" — i.e. the erasure state is UNKNOWN, not
    // known-false. On this path unknown must refuse: the write it guards mints
    // a §86/4 tax document, and minting one for a member who may have been
    // erased is not an outcome a re-drive can undo.
    //
    // This is a DELIBERATE divergence from the port docstring's default caller
    // behaviour ("treats this the same as both-guards-false"), which is written
    // for the F4 invoice-paid auto-complete path where the benign outcome is to
    // proceed. It matches the sibling fail-closed default in
    // `bulk-enrol-auto-invoice.ts` (`?.access ?? 'terminated'`, "an unexpected
    // gap fails CLOSED rather than enrolling silently").
    //
    // Unreachable through the DB today (the cycle's FK keeps the member row
    // alive and the tenant GUC is set), so the null is injected at the port —
    // the point is that the DEFAULT is safe if that ever stops holding.
    const { memberId, cycleId, invoiceId } = await seedQueueRow({ t: tenant });
    const siblingId = await seedAutoDraft({ t: tenant, memberId, cycleId: null });

    const real = depsFor(tenant);
    const deps = {
      ...real,
      memberRenewalFlagsRepo: {
        ...real.memberRenewalFlagsRepo,
        readReactivationGuardsInTx: async () => null,
      },
    };

    const result = await issueAutoDraftedRenewal(deps, {
      tenantId: tenant.ctx.slug,
      invoiceId,
      actorUserId: user.userId,
      sendEmail: false,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_erased');

    // Same completion proof as case (l): no number minted, cycle untouched,
    // and the sibling draft survives — the guard is above the sweep.
    const inv = await invoiceRow(tenant, invoiceId);
    expect(inv?.status).toBe('draft');
    expect(inv?.documentNumber).toBeNull();

    const cyc = await cycleRow(tenant, cycleId);
    expect(cyc?.status).toBe('upcoming');
    expect(cyc?.linkedInvoiceId).toBeNull();

    const sibling = await invoiceRow(tenant, siblingId);
    expect(sibling?.status).toBe('draft');
  }, 120_000);
});
