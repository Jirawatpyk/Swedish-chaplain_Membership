/**
 * 066 Round-2 §3.2(1) — the SECOND dispatch-candidate arm (review C1):
 * `listDueTrackCandidates` selects awaiting_payment cycles that hold an
 * unpaid (issued) MEMBERSHIP bill, with NO expires_at pre-filter, and
 * threads the member's oldest-due bill due_date onto the row (batched in
 * the query — never a per-candidate bridge round-trip).
 *
 * THE LOAD-BEARING GEOMETRY: the born-awaiting cycle's expires_at is set
 * ~12 months in the future (> the main arm's ±120d window). The main
 * `list` arm hides exactly this cohort — a near-expiry fixture would pass
 * even if this method were wired to the wrong query.
 *
 * Floor: only invoices with due_date >= (period_from − 60d) anchor the
 * track — the SAME floor as the §5.2 termination clock, so warning and
 * clock can never anchor on different invoices.
 *
 * Tenant isolation: seeds + asserts under `runInTenant`; cleanup runs as
 * BYPASSRLS owner via `db.delete` (mirrors dispatch-candidate-repo.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeDrizzleDispatchCandidateRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-dispatch-candidate-repo';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** F4 `invoices.due_date` is a plain 'YYYY-MM-DD' date column. */
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
  legal_name: 'Due Track Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'due-track@example.com',
};

describe('066 listDueTrackCandidates — second candidate arm (live Neon)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let planId: string;

  // One member per cycle (partial-unique active-cycle-per-member).
  const bornAwaitingMember = randomUUID();
  const bornAwaitingCycle = randomUUID();
  const flooredMember = randomUUID();
  const flooredCycle = randomUUID();
  const draftOnlyMember = randomUUID();
  const draftOnlyCycle = randomUUID();
  const eventOnlyMember = randomUUID();
  const eventOnlyCycle = randomUUID();
  const upcomingMember = randomUUID();
  const upcomingCycle = randomUUID();
  const erasedMember = randomUUID();
  const erasedCycle = randomUUID();
  const twoBillsMember = randomUUID();
  const twoBillsCycle = randomUUID();

  const BORN_AWAITING_DUE = dateOnly(-40 * MS_PER_DAY);
  const OLDEST_DUE = dateOnly(-50 * MS_PER_DAY);
  const NEWER_DUE = dateOnly(-20 * MS_PER_DAY);

  let seq = 910_000;
  function issuedMembershipInvoice(memberId: string, dueDate: string) {
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
      issueDate: dateOnly(-60 * MS_PER_DAY),
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

  function awaitingCycle(cycleId: string, memberId: string, opts?: { status?: string; periodFromMs?: number }) {
    // Born-awaiting geometry (default): period just started, expiry ~12mo out.
    const periodFrom = new Date(Date.now() + (opts?.periodFromMs ?? -10 * MS_PER_DAY));
    const expiresAt = new Date(Date.now() + 360 * MS_PER_DAY);
    return {
      tenantId: tenantA.ctx.slug,
      cycleId,
      memberId,
      status: (opts?.status ?? 'awaiting_payment') as 'awaiting_payment',
      periodFrom,
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular' as const,
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB' as const,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    planId = `f8-duetrk-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Due Track Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    const memberRows = [
      { memberId: bornAwaitingMember, companyName: 'Born Awaiting Co' },
      { memberId: flooredMember, companyName: 'Floored Co' },
      { memberId: draftOnlyMember, companyName: 'Draft Only Co' },
      { memberId: eventOnlyMember, companyName: 'Event Only Co' },
      { memberId: upcomingMember, companyName: 'Upcoming Co' },
      { memberId: erasedMember, companyName: 'Erased Co', erasedAt: new Date() },
      { memberId: twoBillsMember, companyName: 'Two Bills Co' },
    ];
    for (const row of memberRows) {
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberNumber: nextSeedMemberNumber(),
          country: 'TH',
          planId,
          planYear: 2026,
          ...row,
        }),
      );
    }

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values([
        awaitingCycle(bornAwaitingCycle, bornAwaitingMember),
        awaitingCycle(flooredCycle, flooredMember),
        awaitingCycle(draftOnlyCycle, draftOnlyMember),
        awaitingCycle(eventOnlyCycle, eventOnlyMember),
        awaitingCycle(upcomingCycle, upcomingMember, { status: 'upcoming' }),
        awaitingCycle(erasedCycle, erasedMember),
        awaitingCycle(twoBillsCycle, twoBillsMember),
      ]),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values([
        // Anchors the born-awaiting cycle (due 40d ago ≥ floor now-70d).
        issuedMembershipInvoice(bornAwaitingMember, BORN_AWAITING_DUE),
        // BELOW the period_from − 60d floor (due 100d ago < now-70d) —
        // must NOT anchor; the cycle falls out of this arm entirely.
        issuedMembershipInvoice(flooredMember, dateOnly(-100 * MS_PER_DAY)),
        // Non-awaiting cycle's member still holds a past-due bill — the
        // CYCLE status filter must exclude it.
        issuedMembershipInvoice(upcomingMember, BORN_AWAITING_DUE),
        // Erased member holds a past-due bill — COMP-1 H4 exclusion.
        issuedMembershipInvoice(erasedMember, BORN_AWAITING_DUE),
        // Oldest-due wins: two unpaid bills.
        issuedMembershipInvoice(twoBillsMember, NEWER_DUE),
        issuedMembershipInvoice(twoBillsMember, OLDEST_DUE),
      ]),
    );
    // Non-issued (draft) invoice — status filter must exclude it.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: randomUUID(),
        memberId: draftOnlyMember,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      }),
    );
    // EVENT-subject ISSUED invoice, past due + member-linked — excluded
    // ONLY by the `invoice_subject='membership'` conjunct (the V1-class
    // event-bill leak from Round 1). Needs a real F6 event + registration
    // (invoices_subject_fields_ck + composite FK).
    const eventId = randomUUID();
    const registrationId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values({
        eventId,
        tenantId: tenantA.ctx.slug,
        externalId: `evt-duetrk-${randomUUID().slice(0, 8)}`,
        source: 'admin_manual',
        name: 'Due-track exclusion test event',
        startDate: new Date('2099-01-01T00:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      });
      await tx.insert(eventRegistrations).values({
        registrationId,
        tenantId: tenantA.ctx.slug,
        eventId,
        externalId: `att-${randomUUID().slice(0, 8)}`,
        attendeeEmail: `attendee-${randomUUID().slice(0, 8)}@duetrk.test`,
        attendeeName: 'Due Track Attendee',
        matchType: 'non_member',
        paymentStatus: 'pending',
        registeredAt: new Date(),
      });
      const eventInvoice = issuedMembershipInvoice(eventOnlyMember, BORN_AWAITING_DUE);
      await tx.insert(invoices).values({
        ...eventInvoice,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: registrationId,
        // Event rows carry no plan identity (invoices_subject_fields_ck).
        planId: null,
        planYear: null,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenantA.ctx.slug)).catch(() => {});
    // T3-review M2 — the F6 fixture rows are not covered by tenant.cleanup().
    await db
      .delete(eventRegistrations)
      .where(eq(eventRegistrations.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db.delete(events).where(eq(events.tenantId, tenantA.ctx.slug)).catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenantA.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantA.ctx.slug)).catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  async function listAll() {
    const repo = makeDrizzleDispatchCandidateRepo(tenantA.ctx);
    const items = [];
    let cursor: string | null = null;
    do {
      const page = await repo.listDueTrackCandidates(tenantA.ctx.slug, {
        pageSize: 3, // small page to exercise the keyset cursor
        cursor,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  it('returns the born-awaiting cycle (expires_at ~12mo out) with its bill due_date', async () => {
    const items = await listAll();
    const hit = items.find((c) => c.cycle.cycleId === bornAwaitingCycle);
    expect(hit).toBeDefined();
    expect(hit!.billDueDate).toBe(BORN_AWAITING_DUE);
    // Sanity for the C1 geometry: the same cycle is INVISIBLE to the main
    // ±120d arm — proving the second arm is what surfaces it.
    const repo = makeDrizzleDispatchCandidateRepo(tenantA.ctx);
    const mainArm = await repo.list(tenantA.ctx.slug, {
      cutoffExpiresAt: new Date(Date.now() + 120 * MS_PER_DAY).toISOString(),
      maxOffsetDays: 120,
      pageSize: 100,
    });
    expect(mainArm.items.map((c) => c.cycle.cycleId)).not.toContain(bornAwaitingCycle);
  });

  it('floors: a bill due before period_from − 60d does not anchor (cycle absent)', async () => {
    const items = await listAll();
    expect(items.map((c) => c.cycle.cycleId)).not.toContain(flooredCycle);
  });

  it('excludes non-issued bills, event invoices, non-awaiting cycles, erased members', async () => {
    const ids = (await listAll()).map((c) => c.cycle.cycleId);
    expect(ids).not.toContain(draftOnlyCycle);
    expect(ids).not.toContain(eventOnlyCycle);
    expect(ids).not.toContain(upcomingCycle);
    expect(ids).not.toContain(erasedCycle);
  });

  it('oldest-due wins when the member holds two unpaid membership bills', async () => {
    const items = await listAll();
    const hit = items.find((c) => c.cycle.cycleId === twoBillsCycle);
    expect(hit).toBeDefined();
    expect(hit!.billDueDate).toBe(OLDEST_DUE);
  });

  it('cross-tenant probe: tenant B cannot see tenant A due-track candidates (Principle I)', async () => {
    // T3-review follow-up — the new arm gets its own RLS probe (the main
    // arm's probe lives in dispatch-candidate-repo.test.ts). Tenant B has
    // seeded NOTHING, so any row visible through B's context would be a
    // cross-tenant leak from A's fixtures above.
    const tenantB = await createTestTenant();
    try {
      const repoB = makeDrizzleDispatchCandidateRepo(tenantB.ctx);
      const pageB = await repoB.listDueTrackCandidates(tenantB.ctx.slug, {
        pageSize: 100,
        cursor: null,
      });
      expect(pageB.items).toHaveLength(0);
      // Positive control: A's context still sees its own candidates.
      const itemsA = await listAll();
      expect(itemsA.map((c) => c.cycle.cycleId)).toContain(bornAwaitingCycle);
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });
});
