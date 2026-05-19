/**
 * F6.1 Option B+ (2026-05-18) — Mirror EventCreate Status into
 * event_registrations.payment_status via the CSV import path.
 *
 * Acceptance:
 *   1. CSV with a mix of Status values (Attending, Pending, Waitlisted,
 *      No Show, Cancelled, plus a typo-Skipped) imports such that:
 *        - rowsProcessed counts Attending + Pending + Waitlisted + NoShow
 *        - rowsSkipped counts the typo + Cancellation-without-prior ghost
 *      Each persisted row's `payment_status` matches the mapping table.
 *
 *   2. Quota strict allowlist — only the `paid` row contributes to
 *      partnership / cultural quota (matched member · partner-benefit
 *      event). Pending / Waitlisted / NoShow attendees DO NOT count.
 *
 *   3. Re-upload with `Pending → Attending` for the same attendee bumps
 *      `rowsStateChanged` and updates `payment_status='paid'` via the
 *      existing `maybeApplyStateChange` path. The other 3 rows report as
 *      `rowsAlreadyImported`.
 *
 * Live DB cost: ~12-18s wall-clock (event upsert + 5 attendee inserts
 * + re-upload + state-change UPDATE).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const HEADER =
  'Basic Info,Status,First Name,Last Name,Email,Phone Number,Phone Number Consent,Registration Date,Added Date,Last Updated Date,Attendee Edited Date,Ticket,Guest Of,Number of Guests Allowed,Checked In,Attendee ID,Order ID,VIP,Notes,Assigned Table,Tags,Company Name,Registration Category,Personal Data Protection Consent,Last Email Sent,Last Email Sent Date,Unsubscribed';

function buildRow(
  firstName: string,
  status: string,
  email: string,
  attendeeId: string,
): string {
  const cells = [
    `${firstName} Mirror`,
    status,
    firstName,
    'Mirror',
    email,
    '',
    'FALSE',
    '2026-04-01T09:00:00Z',
    '2026-04-01T09:00:00Z',
    '2026-04-01T09:00:00Z',
    '–',
    'Standard',
    '–',
    '1',
    'FALSE',
    attendeeId,
    attendeeId.split('-')[0] ?? attendeeId,
    'FALSE',
    '', // Notes — Option B+ ignores
    '–',
    '',
    'Test Co',
    'Member',
    'I hereby acknowledge',
    '–',
    '–',
    'FALSE',
  ];
  return cells
    .map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join(',');
}

function buildCsv(rows: ReadonlyArray<string>): Uint8Array {
  return new TextEncoder().encode([HEADER, ...rows].join('\r\n') + '\r\n');
}

describe('F6.1 Option B+ — Status mirroring (live Neon)', () => {
  let tenant: TestTenant;
  let actor: TestUser;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      // uuid-suffixed slug isolates from other suites
    }
  });

  it(
    'mixed Status CSV → each persists with correct payment_status; only paid counts toward quota',
    { timeout: 120_000 },
    async () => {
      // D5 follow-up — load-bear the strict allowlist assertion by
      // seeding a partner-benefit event AND a matched partnership
      // member for ALL 4 attendees. The previous version's event
      // lacked `isPartnerBenefit` so the gate at process-attendee-
      // in-tx.ts short-circuited BEFORE evaluating the payment_status
      // allowlist — the test would have passed even if Option B+
      // regressed and counted `pending` / `waitlisted` / `no_show`
      // against quota. Now the differentiator is purely the payment
      // status, so the assertion catches regressions in the strict
      // allowlist itself.
      const corporatePlanId = `test-plan-corp-${randomUUID()}`;
      const partnershipPlanId = `test-plan-partnership-${randomUUID()}`;
      const matrix: BenefitMatrix = {
        ...DEFAULT_TEST_BENEFIT_MATRIX,
        cultural_tickets_per_year: 0,
        partnership: {
          event_tickets_included: 6,
          booth_included: true,
          rollup_logo_at_events: true,
          logo_on_merch: true,
          video_duration_minutes: 1.5,
          video_frequency_scope: 'all_events',
          website_logo_months: 12,
          banner_per_year: 20,
          newsletter_promotion: true,
          enewsletter_logo: true,
          directory_ad_position: 'pages_1_and_2',
        },
      };
      const corpMatrix: BenefitMatrix = {
        ...DEFAULT_TEST_BENEFIT_MATRIX,
        cultural_tickets_per_year: 0,
        partnership: null,
      };
      type AttendeeSeed = {
        readonly memberId: string;
        readonly contactId: string;
        readonly firstName: string;
        readonly email: string;
        readonly status: 'Attending' | 'Pending' | 'Waitlisted' | 'No Show';
        readonly externalId: string;
      };
      const attendees: AttendeeSeed[] = [
        { memberId: randomUUID(), contactId: randomUUID(), firstName: 'Anna', email: `anna-${randomUUID().slice(0, 8)}@mirror.test`, status: 'Attending', externalId: '17000-1' },
        { memberId: randomUUID(), contactId: randomUUID(), firstName: 'Bob', email: `bob-${randomUUID().slice(0, 8)}@mirror.test`, status: 'Pending', externalId: '17000-2' },
        { memberId: randomUUID(), contactId: randomUUID(), firstName: 'Carla', email: `carla-${randomUUID().slice(0, 8)}@mirror.test`, status: 'Waitlisted', externalId: '17000-3' },
        { memberId: randomUUID(), contactId: randomUUID(), firstName: 'Dan', email: `dan-${randomUUID().slice(0, 8)}@mirror.test`, status: 'No Show', externalId: '17000-4' },
      ];
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corporatePlanId,
          planName: { en: 'Bundled Corporate (mirror)' },
          benefitMatrix: corpMatrix,
          planCategory: 'corporate',
          createdBy: actor.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Partnership (mirror)' },
          benefitMatrix: matrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corporatePlanId,
          createdBy: actor.userId,
        });
        for (const a of attendees) {
          await tx.insert(members).values({
            tenantId: tenant.ctx.slug,
            memberId: a.memberId,
            companyName: `Mirror Co ${a.firstName}`,
            country: 'TH',
            planId: partnershipPlanId,
            planYear: 2026,
            status: 'active',
          } as unknown as typeof members.$inferInsert);
          await tx.insert(contacts).values({
            tenantId: tenant.ctx.slug,
            contactId: a.contactId,
            memberId: a.memberId,
            firstName: a.firstName,
            lastName: 'Mirror',
            email: a.email,
            isPrimary: true,
          } as unknown as typeof contacts.$inferInsert);
        }
      });

      const eventId = randomUUID();
      const externalId = `event-mirror-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Status mirroring test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        isPartnerBenefit: true,
        isCulturalEvent: false,
        category: null,
      } as unknown as typeof events.$inferInsert);

      const csv = buildCsv([
        ...attendees.map((a) =>
          buildRow(a.firstName, a.status, a.email, a.externalId),
        ),
        buildRow('Eve', 'Garbage', 'eve@example.test', '17000-5'),
      ]);

      const r = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: csv,
        selectedEvent: {
          eventId,
          externalId,
          name: 'Status mirroring test',
          startDate: new Date('2026-06-05T03:00:00Z'),
          category: null,
        },
        originalFilename: 'mirror.csv',
      });
      expect(r.kind).toBe('completed');
      if (r.kind !== 'completed') return;

      // 4 mirrored rows + 1 Skipped (Status=Garbage).
      expect(r.summary.rowsTotal).toBe(5);
      expect(r.summary.rowsProcessed).toBe(4);
      expect(r.summary.rowsSkipped).toBe(1);
      expect(r.summary.rowsAlreadyImported).toBe(0);

      // Verify per-row payment_status mapping.
      const regs = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(regs.length).toBe(4);
      const byEmail = new Map(
        regs.map((row) => [row.attendeeEmailLower, row]),
      );
      for (const a of attendees) {
        const row = byEmail.get(a.email);
        const expectedPaymentStatus =
          a.status === 'Attending'
            ? 'paid'
            : a.status === 'Pending'
              ? 'pending'
              : a.status === 'Waitlisted'
                ? 'waitlisted'
                : 'no_show';
        expect(row?.paymentStatus).toBe(expectedPaymentStatus);
        // All 4 must have been matched via the member_contact path.
        expect(row?.matchedMemberId).toBe(a.memberId);
      }

      // Strict quota allowlist — even though all 4 rows matched
      // partnership members on a partner-benefit event, ONLY the
      // `paid` (Anna) row consumes quota. Bob/Carla/Dan are pending
      // /waitlisted/no_show → quota-neutral.
      const counted = regs.filter(
        (row) =>
          row.countedAgainstPartnership || row.countedAgainstCulturalQuota,
      );
      expect(counted.length).toBe(1);
      expect(counted[0]?.attendeeEmailLower).toBe(attendees[0]!.email);
      expect(counted[0]?.countedAgainstPartnership).toBe(true);
    },
  );

  it(
    'Pending → Attending re-upload UPDATEs payment_status (rowsStateChanged=1)',
    { timeout: 90_000 },
    async () => {
      const eventId = randomUUID();
      const externalId = `event-flip-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Pending→Attending flip',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      } satisfies NewEventRow);

      const selectedEvent = {
        eventId,
        externalId,
        name: 'Pending→Attending flip',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1st upload — Status=Pending
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Frank', 'Pending', 'frank@example.test', '17001-1'),
        ]),
        selectedEvent,
        originalFilename: 'flip-1.csv',
      });
      expect(r1.kind).toBe('completed');
      if (r1.kind !== 'completed') return;
      expect(r1.summary.rowsProcessed).toBe(1);

      const regsAfter1 = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(regsAfter1).toHaveLength(1);
      expect(regsAfter1[0]?.paymentStatus).toBe('pending');

      // 2nd upload — same row, Status flipped to Attending
      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Frank', 'Attending', 'frank@example.test', '17001-1'),
        ]),
        selectedEvent,
        originalFilename: 'flip-2.csv',
        forceProceed: true,
      });
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsProcessed).toBe(0);
      expect(r2.summary.rowsAlreadyImported).toBe(0);
      expect(r2.summary.rowsStateChanged).toBe(1);

      const regsAfter2 = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(regsAfter2).toHaveLength(1);
      expect(regsAfter2[0]?.paymentStatus).toBe('paid');
    },
  );

  /**
   * Quota credit-back regression (Option B+ /speckit-review follow-up):
   * a matched-member row on a partner-benefit event must:
   *   - Start at `payment_status='pending'` + `counted_against_partnership=false`
   *   - On Pending → Attending re-upload, flip to `payment_status='paid'` AND
   *     `counted_against_partnership=true`, emitting `quota_partnership_decremented`
   *   - On Attending → Pending re-upload (rare debit case), flip back to
   *     `payment_status='pending'` AND `counted_against_partnership=false`,
   *     emitting `quota_credit_back_refund` with `scope='partnership'`
   *
   * Pre-fix bug: maybeApplyStateChange UPDATEd `payment_status` only — quota
   * counters stayed stale forever, silently under-counting member seat usage.
   */
  it(
    'Pending ⇄ Attending state-changes credit + debit quota for matched partnership member',
    { timeout: 120_000 },
    async () => {
      const ATTENDEE_EMAIL = `partner-${randomUUID().slice(0, 8)}@quota.test`;
      const corporatePlanId = `test-plan-corp-${randomUUID()}`;
      const partnershipPlanId = `test-plan-partnership-${randomUUID()}`;
      const memberId = randomUUID();
      const contactId = randomUUID();

      // Plan + member + contact: a partnership plan with 6 included
      // event tickets (matches the Diamond tier in the quota-accounting
      // suite). The CSV's matched-by-email lookup needs the contact's
      // email to equal ATTENDEE_EMAIL.
      const partnershipMatrix: BenefitMatrix = {
        ...DEFAULT_TEST_BENEFIT_MATRIX,
        cultural_tickets_per_year: 0,
        partnership: {
          event_tickets_included: 6,
          booth_included: true,
          rollup_logo_at_events: true,
          logo_on_merch: true,
          video_duration_minutes: 1.5,
          video_frequency_scope: 'all_events',
          website_logo_months: 12,
          banner_per_year: 20,
          newsletter_promotion: true,
          enewsletter_logo: true,
          directory_ad_position: 'pages_1_and_2',
        },
      };
      const corporateMatrix: BenefitMatrix = {
        ...DEFAULT_TEST_BENEFIT_MATRIX,
        cultural_tickets_per_year: 0,
        partnership: null,
      };
      await runInTenant(tenant.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: corporatePlanId,
          planName: { en: 'Bundled Corporate' },
          benefitMatrix: corporateMatrix,
          planCategory: 'corporate',
          createdBy: actor.userId,
        });
        await seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: partnershipPlanId,
          planName: { en: 'Partnership Test Plan' },
          benefitMatrix: partnershipMatrix,
          planCategory: 'partnership',
          includesCorporatePlanId: corporatePlanId,
          createdBy: actor.userId,
        });
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName: 'Partnership Test Co',
          country: 'TH',
          planId: partnershipPlanId,
          planYear: 2026,
          status: 'active',
        } as unknown as typeof members.$inferInsert);
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Partner',
          lastName: 'Member',
          email: ATTENDEE_EMAIL,
          isPrimary: true,
        } as unknown as typeof contacts.$inferInsert);
      });

      // Partner-benefit event so the quota-effect gate fires.
      const eventId = randomUUID();
      const externalId = `event-credit-${eventId.slice(0, 8)}`;
      await db.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId,
        name: 'Quota-credit-back test',
        startDate: new Date('2026-06-21T18:00:00Z'),
        isPartnerBenefit: true,
        isCulturalEvent: false,
        category: null,
      } as unknown as typeof events.$inferInsert);

      const selectedEvent = {
        eventId,
        externalId,
        name: 'Quota-credit-back test',
        startDate: new Date('2026-06-21T18:00:00Z'),
        category: null,
      };

      const beforeMs = Date.now();

      // Round 1 — Pending. Quota NOT yet counted.
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Partner', 'Pending', ATTENDEE_EMAIL, '99000-1'),
        ]),
        selectedEvent,
        originalFilename: 'credit-back-1.csv',
      });
      expect(r1.kind).toBe('completed');
      if (r1.kind !== 'completed') return;
      expect(r1.summary.rowsProcessed).toBe(1);

      const after1 = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(after1).toHaveLength(1);
      expect(after1[0]?.paymentStatus).toBe('pending');
      expect(after1[0]?.countedAgainstPartnership).toBe(false);
      expect(after1[0]?.matchedMemberId).toBe(memberId);

      // Round 2 — Pending → Attending. Quota MUST be credited.
      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Partner', 'Attending', ATTENDEE_EMAIL, '99000-1'),
        ]),
        selectedEvent,
        originalFilename: 'credit-back-2.csv',
        forceProceed: true,
      });
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsStateChanged).toBe(1);

      const after2 = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(after2).toHaveLength(1);
      expect(after2[0]?.paymentStatus).toBe('paid');
      expect(after2[0]?.countedAgainstPartnership).toBe(true);

      // Credit audit emitted exactly once.
      const creditAudits = await db
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(
              auditLog.eventType,
              'quota_partnership_decremented' as never,
            ),
            gt(auditLog.timestamp, new Date(beforeMs - 1000)),
          ),
        );
      expect(creditAudits.length).toBe(1);

      // Round 3 — Attending → Pending (rare debit case). Quota credited back.
      const r3 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Partner', 'Pending', ATTENDEE_EMAIL, '99000-1'),
        ]),
        selectedEvent,
        originalFilename: 'credit-back-3.csv',
        forceProceed: true,
      });
      expect(r3.kind).toBe('completed');
      if (r3.kind !== 'completed') return;
      expect(r3.summary.rowsStateChanged).toBe(1);

      const after3 = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenant.ctx.slug),
              eq(eventRegistrations.eventId, eventId),
            ),
          ),
      );
      expect(after3).toHaveLength(1);
      expect(after3[0]?.paymentStatus).toBe('pending');
      expect(after3[0]?.countedAgainstPartnership).toBe(false);

      // Credit-back audit emitted exactly once for partnership scope.
      const debitAudits = await db
        .select({
          eventType: auditLog.eventType,
          summary: auditLog.summary,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'quota_credit_back_refund' as never),
            gt(auditLog.timestamp, new Date(beforeMs - 1000)),
          ),
        );
      expect(debitAudits.length).toBe(1);
      // Summary must disambiguate "via state_change" from a real refund.
      expect(debitAudits[0]?.summary).toContain('state_change');
      const payload = debitAudits[0]?.payload as { scope?: string };
      expect(payload?.scope).toBe('partnership');
    },
  );
});
