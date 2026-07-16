/**
 * 059-membership-suspension Task 12 — `InvoiceDueBridge` port + Drizzle
 * adapter. Live Neon.
 *
 * Answers "does this member have an unpaid (status='issued') MEMBERSHIP
 * invoice that is NOT yet past its due date (due_date >= todayBkk)?" —
 * feeds Task 13's grace-window guard on the lapse cron so a member still
 * inside a fresh invoice's credit window is never suspended for
 * non-payment. NOT the Gate 7.5 query (`hasUnreconciledPaidMembershipInvoice`,
 * which selects the OPPOSITE statuses — paid/partially_credited).
 *
 * Constitution Principle II (test-first) + Principle I (RLS via
 * runInTenant — cross-tenant probe at the bottom is a Review-Gate
 * blocker).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { bangkokLocalDate, addDays } from '@/lib/fiscal-year';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Invoice Due Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

describe('InvoiceDueBridge — integration (059 Task 12)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let todayBkk: string;
  let futureDueDate: string;
  let pastDueDate: string;
  let seq = 1;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-due-${randomUUID().slice(0, 8)}`;
    todayBkk = bangkokLocalDate(new Date().toISOString());
    futureDueDate = addDays(todayBkk, 30);
    pastDueDate = addDays(todayBkk, -30);
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Invoice-Due Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  function nextSeq(): number {
    return seq++;
  }

  async function seedMember(t: TestTenant = tenant): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Invoice Due Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  interface SeedInvoiceOpts {
    readonly memberId: string;
    readonly status: 'draft' | 'issued' | 'paid' | 'void';
    readonly dueDate: string | null;
  }

  /**
   * Seeds a MEMBERSHIP invoice. `draft` needs only the minimal identity
   * fields; `issued`/`paid`/`void` are non-draft and must satisfy the
   * `invoices_non_draft_has_snapshots` CHECK (full snapshot + pdf set),
   * plus the status-specific CHECKs (`invoices_void_has_reason`,
   * `invoices_paid_has_payment`, `invoices_paid_has_receipt_status`).
   */
  async function seedMembershipInvoice(opts: SeedInvoiceOpts): Promise<string> {
    const invoiceId = randomUUID();
    const n = nextSeq();
    const base = {
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId: opts.memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: opts.status,
      dueDate: opts.dueDate,
    };
    if (opts.status === 'draft') {
      await runInTenant(tenant.ctx, (tx) => tx.insert(invoices).values(base));
      return invoiceId;
    }
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        ...base,
        pdfDocKind: 'invoice',
        fiscalYear: 2025,
        sequenceNumber: n,
        documentNumber: `INV-2025-${String(n).padStart(6, '0')}`,
        issueDate: '2025-01-15',
        currency: 'THB',
        subtotalSatang: 5_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 350_000n,
        totalSatang: 5_350_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2025/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        ...(opts.status === 'void'
          ? {
              voidedAt: new Date(),
              voidReason: 'test void',
              voidedByUserId: user.userId,
            }
          : {}),
        ...(opts.status === 'paid'
          ? {
              paidAt: new Date(),
              paymentMethod: 'bank_transfer',
              receiptPdfStatus: 'rendered',
            }
          : {}),
      }),
    );
    return invoiceId;
  }

  /**
   * Seeds an EVENT-subject invoice carrying `memberId` (structurally
   * legal per `invoices_subject_fields_ck` — the event branch of that
   * CHECK does not forbid `member_id`). Proves the bridge's
   * `invoice_subject = 'membership'` filter, not just a memberId match,
   * is what excludes it.
   */
  async function seedEventInvoiceForMember(memberId: string, dueDate: string): Promise<string> {
    const invoiceId = randomUUID();
    const eventId = randomUUID();
    const regId = randomUUID();
    const n = nextSeq();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt_due_${n}`,
        name: 'Invoice-Due Test Event',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: `att_due_${n}`,
        attendeeEmail: 'guest@example.com',
        attendeeName: 'Guest',
        attendeeCompany: 'Guest Co',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: regId,
        vatInclusive: true,
        memberId,
        planYear: null,
        planId: null,
        draftByUserId: user.userId,
        status: 'issued',
        pdfDocKind: 'receipt_separate',
        fiscalYear: 2025,
        sequenceNumber: n,
        documentNumber: `INV-2025-EV-${String(n).padStart(6, '0')}`,
        issueDate: '2025-01-15',
        dueDate,
        subtotalSatang: 327_103n,
        vatRateSnapshot: '0.0700',
        vatSatang: 22_897n,
        totalSatang: 350_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: null,
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2025/${invoiceId}.pdf`,
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    return invoiceId;
  }

  it('issued membership invoice, due_date in the FUTURE → true', async () => {
    const memberId = await seedMember();
    await seedMembershipInvoice({ memberId, status: 'issued', dueDate: futureDueDate });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(true);
  });

  it('issued membership invoice, due_date in the PAST → false', async () => {
    const memberId = await seedMember();
    await seedMembershipInvoice({ memberId, status: 'issued', dueDate: pastDueDate });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  // `computeIsOverdue`'s own docstring says it best: "dueDate must be
  // non-null (defensive — issued invoices always have one)". The
  // `invoices_non_draft_has_snapshots` CHECK enforces `due_date IS NOT
  // NULL` for EVERY non-draft row (no per-subject relaxation), so an
  // `issued` invoice with a NULL due_date cannot exist in live Neon —
  // confirmed here by asserting the DB itself rejects the insert. The
  // bridge's SQL still carries `isNotNull(dueDate)` as belt-and-braces
  // defence-in-depth (mirrors `computeIsOverdue`), but there is no live
  // round-trip to exercise for the "NULL due_date" branch specifically.
  it('issued invoice with NULL due_date is unreachable — DB rejects it (invoices_non_draft_has_snapshots)', async () => {
    const memberId = await seedMember();
    let caught: unknown;
    try {
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: null });
    } catch (e) {
      caught = e;
    }
    // postgres.js wraps the PostgresError as `.cause` on Drizzle's
    // "Failed query" error — the constraint name lives there, not on
    // the top-level `.message`.
    const cause = (caught as { cause?: unknown } | undefined)?.cause;
    expect(String(cause)).toMatch(/invoices_non_draft_has_snapshots/);
  });

  it('draft membership invoice with future due_date → false (only issued counts)', async () => {
    const memberId = await seedMember();
    await seedMembershipInvoice({ memberId, status: 'draft', dueDate: futureDueDate });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  it('void membership invoice with future due_date → false (only issued counts)', async () => {
    const memberId = await seedMember();
    await seedMembershipInvoice({ memberId, status: 'void', dueDate: futureDueDate });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  it('paid membership invoice with future due_date → false (only issued counts)', async () => {
    const memberId = await seedMember();
    await seedMembershipInvoice({ memberId, status: 'paid', dueDate: futureDueDate });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  it('event-subject invoice with future due_date → false (subject must be membership)', async () => {
    const memberId = await seedMember();
    await seedEventInvoiceForMember(memberId, futureDueDate);

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  it('no invoice at all → false', async () => {
    const memberId = await seedMember();

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const got = await deps.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
      tenantId: tenant.ctx.slug,
      memberId,
      todayBkk,
    });
    expect(got).toBe(false);
  });

  it("cross-tenant: tenant B cannot see tenant A's invoice (RLS)", async () => {
    const tenantB = await createTestTenant('test-chamber');
    try {
      const memberId = await seedMember();
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: futureDueDate });

      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      const gotUnderB = await depsB.invoiceDueBridge.hasUnpaidNotYetDueMembershipInvoice({
        tenantId: tenantB.ctx.slug,
        memberId,
        todayBkk,
      });
      expect(gotUnderB).toBe(false);
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });

  describe('oldestUnpaidMembershipInvoiceDueDate (065 §5.2)', () => {
    // 065 §5.2 review — a floor far below every seeded due_date, so these
    // cases exercise the ordering/subject/status/RLS filters WITHOUT the
    // `sinceDueDate` window excluding anything. The window itself has its
    // own dedicated case below.
    const SINCE_ALL = '2000-01-01';

    it('returns the OLDEST due_date among multiple issued membership invoices', async () => {
      const memberId = await seedMember();
      const older = addDays(todayBkk, 5);
      const newer = addDays(todayBkk, 40);
      // Seed newest first to prove ORDER BY due_date ASC (not insert order).
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: newer });
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: older });

      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const got = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: SINCE_ALL,
      });
      expect(got).toBe(older);
    });

    it('null when the member has no membership invoice', async () => {
      const memberId = await seedMember();
      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const got = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: SINCE_ALL,
      });
      expect(got).toBeNull();
    });

    it('ignores draft / paid / void — only issued counts', async () => {
      const memberId = await seedMember();
      await seedMembershipInvoice({ memberId, status: 'draft', dueDate: pastDueDate });
      await seedMembershipInvoice({ memberId, status: 'paid', dueDate: pastDueDate });
      await seedMembershipInvoice({ memberId, status: 'void', dueDate: pastDueDate });

      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const got = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: SINCE_ALL,
      });
      expect(got).toBeNull();
    });

    it('ignores event-subject invoices (subject must be membership)', async () => {
      const memberId = await seedMember();
      await seedEventInvoiceForMember(memberId, futureDueDate);

      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const got = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: SINCE_ALL,
      });
      expect(got).toBeNull();
    });

    it('excludes an invoice due BEFORE sinceDueDate — a STALE prior-period invoice never anchors (065 §5.2 review)', async () => {
      const memberId = await seedMember();
      const stale = addDays(todayBkk, -400); // ~13 months ago (prior period)
      const current = addDays(todayBkk, -10); // this period, already past due
      // Stale is the OLDEST-due of the two, so without the floor it would win
      // the ORDER BY due_date ASC LIMIT 1 and anchor the clock on an ancient
      // invoice. The floor between the two due dates must exclude it.
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: stale });
      await seedMembershipInvoice({ memberId, status: 'issued', dueDate: current });

      const deps = makeRenewalsDeps(tenant.ctx.slug);
      const floorBetween = addDays(todayBkk, -60);
      const got = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: floorBetween,
      });
      // The stale invoice is excluded → the current one governs, even though
      // it is NOT the oldest-due row for the member.
      expect(got).toBe(current);

      // A floor ABOVE both due dates → the member has none in-window → null
      // (would fall to the no-invoice backstop in the lapse cron).
      const gotNone = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
        tenantId: tenant.ctx.slug,
        memberId,
        sinceDueDate: addDays(todayBkk, 5),
      });
      expect(gotNone).toBeNull();
    });

    it("cross-tenant: tenant B cannot see tenant A's invoice due_date (RLS)", async () => {
      const tenantB = await createTestTenant('test-chamber');
      try {
        const memberId = await seedMember();
        await seedMembershipInvoice({ memberId, status: 'issued', dueDate: futureDueDate });

        const depsB = makeRenewalsDeps(tenantB.ctx.slug);
        const gotUnderB = await depsB.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
          tenantId: tenantB.ctx.slug,
          memberId,
          sinceDueDate: SINCE_ALL,
        });
        expect(gotUnderB).toBeNull();
      } finally {
        await tenantB.cleanup().catch(() => {});
      }
    });
  });
});
