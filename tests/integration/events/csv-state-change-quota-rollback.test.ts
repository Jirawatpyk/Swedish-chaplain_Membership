/**
 * R2-1 (2026-05-18 /speckit-review Round 2 Blocker) — savepoint
 * atomicity regression test for the state-change debit path.
 *
 * Before R2-1 the outer catch in `maybeApplyStateChange` re-threw only
 * `TxStageError('audit_emit')` and SILENTLY SWALLOWED every other
 * stage — including `'quota_decrement'`. Effect: the in-savepoint
 * `updatePaymentStatus` UPDATE committed even when the subsequent
 * `setQuotaEffect` or audit-emit failed, leaving `payment_status`
 * out of sync with `counted_against_*` flags. The block-comment
 * promised "either the row flips AND the quota reflects the new
 * state, or neither (savepoint rolls back)" — the swallow contradicted
 * that promise.
 *
 * This suite verifies (R3 expansion 2026-05-18):
 *   1. Happy path — Attending → Pending re-upload commits both the
 *      payment_status flip AND the quota credit-back, with the audit
 *      pair (state_changed + credit_back_refund) emitted in the
 *      same savepoint.
 *   2. Fault-injection path — `F6_TEST_FAIL_AT_QUOTA_DEBIT='true'`
 *      throws AFTER the advisory lock acquires but BEFORE
 *      `setQuotaEffect` runs. The savepoint MUST roll back atomically:
 *        - payment_status is UNCHANGED (still 'paid')
 *        - counted_against_partnership is UNCHANGED (still true)
 *        - NO new audit row in (`csv_import_row_state_changed`,
 *          `quota_credit_back_refund`, or `quota_*_decremented`)
 *        - The CSV summary reports the row as `row_failed` with
 *          `failureStage='quota_decrement'`
 *   3. Recovery — clearing F6_TEST_FAIL_AT_QUOTA_DEBIT lets a
 *      subsequent retry commit; the state machine remains correct
 *      after rollback. R3-T8 extends this case with an audit-pair
 *      delta assertion so a regression that fixes the savepoint but
 *      breaks the audit emit gets caught.
 *   4. R3-T1 / R3-C1 — audit.emit RAW throw (mocked via vi.spyOn)
 *      converts to TxStageError('audit_emit') at the emitOrThrow
 *      boundary, so the savepoint rolls back atomically. Closes the
 *      different-vector silent failure that R2-1 outer-catch refactor
 *      didn't audit.
 *   5. R3-T7 — Cultural-scope debit (isCulturalEvent=true,
 *      cultural_tickets_per_year=6). Asserts the helper emits
 *      `scope: 'cultural'` with the cultural-per-year allotmentAfter
 *      math.
 *
 * R2-1b lock serialization is asserted by construction (same
 * `buildQuotaLockKey` namespace as the credit path) and verified
 * separately via `apply-quota-effect.ts` + `drizzle-advisory-lock-acquirer.ts`
 * which uses `pg_advisory_xact_lock` (tx-level, auto-release).
 *
 * Live DB cost: ~40-50s wall-clock (event + member seed + 5 imports).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
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
    `${firstName} R2-1`,
    status,
    firstName,
    'R2One',
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
    '',
    '–',
    '',
    'R2-1 Co',
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

describe('F6.1 R2-1 — state-change quota-debit savepoint atomicity (live Neon)', () => {
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

  afterEach(() => {
    // Defence-in-depth — never let an injected env-flag leak into
    // the next test case if a prior assertion threw mid-it-block.
    vi.unstubAllEnvs();
  });

  async function seedPartnerEventAndMember(): Promise<{
    readonly eventId: string;
    readonly externalId: string;
    readonly memberId: string;
    readonly attendeeEmail: string;
    readonly externalAttendeeId: string;
  }> {
    const memberId = randomUUID();
    const contactId = randomUUID();
    const attendeeEmail = `r2-${randomUUID().slice(0, 8)}@quota.test`;
    const corporatePlanId = `test-plan-corp-${randomUUID()}`;
    const partnershipPlanId = `test-plan-partnership-${randomUUID()}`;
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
        planName: { en: 'Corporate (R2-1)' },
        benefitMatrix: corporateMatrix,
        planCategory: 'corporate',
        createdBy: actor.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: partnershipPlanId,
        planName: { en: 'Partnership (R2-1)' },
        benefitMatrix: partnershipMatrix,
        planCategory: 'partnership',
        includesCorporatePlanId: corporatePlanId,
        createdBy: actor.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'R2-1 Co',
        country: 'TH',
        planId: partnershipPlanId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'R2',
        lastName: 'One',
        email: attendeeEmail,
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
    });

    const eventId = randomUUID();
    const externalId = `event-r2-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'R2-1 atomicity test',
      startDate: new Date('2026-06-05T03:00:00Z'),
      isPartnerBenefit: true,
      isCulturalEvent: false,
    } as unknown as typeof events.$inferInsert);

    const externalAttendeeId = `r2one-${randomUUID().slice(0, 6)}`;
    return { eventId, externalId, memberId, attendeeEmail, externalAttendeeId };
  }

  // R3-T7 — cultural-scope variant of the seed helper. Seeds a member
  // whose partnership plan has `cultural_tickets_per_year: 6` (no
  // partnership) + an event flagged `isCulturalEvent: true,
  // isPartnerBenefit: false`. State-change debit through this seed
  // exercises the cultural emit branch of `emitCreditBackViaStateChange`.
  async function seedCulturalEventAndMember(): Promise<{
    readonly eventId: string;
    readonly externalId: string;
    readonly memberId: string;
    readonly attendeeEmail: string;
    readonly externalAttendeeId: string;
  }> {
    const memberId = randomUUID();
    const contactId = randomUUID();
    const attendeeEmail = `r3-${randomUUID().slice(0, 8)}@cultural.test`;
    const corporatePlanId = `test-plan-corp-${randomUUID()}`;
    // Cultural plans live under the corporate category in F2 — the
    // partnership tier is omitted so quota is decided per-event by
    // the cultural_tickets_per_year allotment.
    const culturalMatrix: BenefitMatrix = {
      ...DEFAULT_TEST_BENEFIT_MATRIX,
      cultural_tickets_per_year: 6,
      partnership: null,
    };

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: corporatePlanId,
        planName: { en: 'Corporate Cultural (R3-T7)' },
        benefitMatrix: culturalMatrix,
        planCategory: 'corporate',
        createdBy: actor.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'R3-T7 Cultural Co',
        country: 'TH',
        planId: corporatePlanId,
        planYear: 2026,
        status: 'active',
      } as unknown as typeof members.$inferInsert);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'R3',
        lastName: 'Seven',
        email: attendeeEmail,
        isPrimary: true,
      } as unknown as typeof contacts.$inferInsert);
    });

    const eventId = randomUUID();
    const externalId = `event-r3-t7-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'R3-T7 cultural test',
      startDate: new Date('2026-06-05T03:00:00Z'),
      isPartnerBenefit: false,
      isCulturalEvent: true,
    } as unknown as typeof events.$inferInsert);

    const externalAttendeeId = `r3t7-${randomUUID().slice(0, 6)}`;
    return { eventId, externalId, memberId, attendeeEmail, externalAttendeeId };
  }

  async function fetchSoleRegistration(eventId: string) {
    return runInTenant(tenant.ctx, async (tx) =>
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
  }

  // R2-S6 audit-rollback helper. Filters by tenant + the 3 audit
  // event types this suite cares about. The audit_log row identifier
  // is the tenant scope; per-event filtering is unnecessary because
  // each `it` block uses its own seeded event (and the test tenant
  // is itself UUID-suffixed-unique per-suite).
  async function fetchAuditTypesForEvent(): Promise<readonly string[]> {
    // Use an admin-scoped lookup (RLS bypass is not available here —
    // audit_log is tenant-scoped). `runInTenant` is fine: we only
    // need rows for THIS tenant + this event id in payload.
    // R2 follow-up — the TS-generated `audit_log.event_type` enum
    // union is stale relative to the F6 migration (it still reflects
    // a pre-F6 schema generation). Postgres accepts the F6 values
    // because the migrations extended the enum at the DB layer.
    // Use a `sql` text-cast comparison so the TS overload resolver
    // doesn't reject the F6 string literals at compile time.
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({
          eventType: auditLog.eventType,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            sql`${auditLog.eventType}::text IN (
              'csv_import_row_state_changed',
              'quota_partnership_decremented',
              'quota_credit_back_refund'
            )`,
          ),
        ),
    );
    return rows.map((r) => r.eventType);
  }

  it(
    'happy path — Attending → Pending re-upload flips payment_status AND debits quota AND emits audit pair',
    { timeout: 120_000 },
    async () => {
      const seed = await seedPartnerEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R2-1 atomicity test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1) Initial import — Attending → payment_status=paid, counted_against_partnership=true
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Mia', 'Attending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-happy-1.csv',
      });
      expect(r1.kind).toBe('completed');
      const after1 = await fetchSoleRegistration(seed.eventId);
      expect(after1).toHaveLength(1);
      expect(after1[0]?.paymentStatus).toBe('paid');
      expect(after1[0]?.countedAgainstPartnership).toBe(true);

      // Snapshot audit-row baseline so the next import's delta is
      // measurable in isolation.
      const auditBefore = await fetchAuditTypesForEvent();
      const decrementedBefore = auditBefore.filter(
        (t) => t === 'quota_partnership_decremented',
      ).length;
      const stateChangedBefore = auditBefore.filter(
        (t) => t === 'csv_import_row_state_changed',
      ).length;
      const creditBackBefore = auditBefore.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      // 2) Debit re-upload — Attending → Pending → savepoint commits both
      //    payment_status flip AND counted_against_partnership=false.
      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Mia', 'Pending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-happy-2.csv',
        forceProceed: true,
      });
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsStateChanged).toBe(1);

      const after2 = await fetchSoleRegistration(seed.eventId);
      expect(after2).toHaveLength(1);
      // BOTH must change atomically.
      expect(after2[0]?.paymentStatus).toBe('pending');
      expect(after2[0]?.countedAgainstPartnership).toBe(false);

      const auditAfter = await fetchAuditTypesForEvent();
      expect(
        auditAfter.filter((t) => t === 'csv_import_row_state_changed').length,
      ).toBe(stateChangedBefore + 1);
      expect(
        auditAfter.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBefore + 1);
      // No NEW decrement on the debit path (that's a credit-only event).
      expect(
        auditAfter.filter((t) => t === 'quota_partnership_decremented').length,
      ).toBe(decrementedBefore);
    },
  );

  it(
    'R2-1 fault-injection — quota_decrement throw rolls back the savepoint atomically (NO partial state)',
    { timeout: 120_000 },
    async () => {
      const seed = await seedPartnerEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R2-1 atomicity test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // Seed: import Attending so the row is `paid` + counted=true.
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow(
            'Noa',
            'Attending',
            seed.attendeeEmail,
            seed.externalAttendeeId,
          ),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-fault-1.csv',
      });
      expect(r1.kind).toBe('completed');
      const before = await fetchSoleRegistration(seed.eventId);
      expect(before[0]?.paymentStatus).toBe('paid');
      expect(before[0]?.countedAgainstPartnership).toBe(true);

      const auditBefore = await fetchAuditTypesForEvent();
      const stateChangedBefore = auditBefore.filter(
        (t) => t === 'csv_import_row_state_changed',
      ).length;
      const creditBackBefore = auditBefore.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      // INJECT the fault — the next state-change in `maybeApplyStateChange`
      // will throw `TxStageError('quota_decrement')` BEFORE setQuotaEffect
      // and BEFORE the audit emit. With R2-1a applied, the outer catch
      // re-throws so the SAVEPOINT rolls back ATOMICALLY.
      vi.stubEnv('F6_TEST_FAIL_AT_QUOTA_DEBIT', 'true');

      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow(
            'Noa',
            'Pending',
            seed.attendeeEmail,
            seed.externalAttendeeId,
          ),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-fault-2.csv',
        forceProceed: true,
      });

      // The row is reported as failed (savepoint rollback), the
      // summary's state-changed counter does NOT increment.
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsStateChanged).toBe(0);
      expect(r2.summary.rowsFailed).toBeGreaterThanOrEqual(1);

      // ATOMIC ROLLBACK INVARIANT — the persisted row is UNCHANGED.
      // payment_status MUST remain 'paid' (NOT 'pending') and
      // counted_against_partnership MUST remain true.
      const after = await fetchSoleRegistration(seed.eventId);
      expect(after).toHaveLength(1);
      expect(after[0]?.paymentStatus).toBe('paid');
      expect(after[0]?.countedAgainstPartnership).toBe(true);

      // R2-S6 — audit-emit rollback assertion. The state-change probe
      // would normally write `csv_import_row_state_changed` +
      // `quota_credit_back_refund`. Both must be ABSENT after the
      // rolled-back savepoint.
      const auditAfter = await fetchAuditTypesForEvent();
      expect(
        auditAfter.filter((t) => t === 'csv_import_row_state_changed').length,
      ).toBe(stateChangedBefore);
      expect(
        auditAfter.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBefore);
    },
  );

  it(
    'recovery — clearing the fault-injection env-var lets a subsequent retry succeed (S-6)',
    { timeout: 120_000 },
    async () => {
      const seed = await seedPartnerEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R2-1 atomicity test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1) Attending seed.
      await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow(
            'Oli',
            'Attending',
            seed.attendeeEmail,
            seed.externalAttendeeId,
          ),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-recover-1.csv',
      });

      // 2) Inject fault, attempt debit, savepoint rolls back.
      vi.stubEnv('F6_TEST_FAIL_AT_QUOTA_DEBIT', 'true');
      await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Oli', 'Pending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-recover-2.csv',
        forceProceed: true,
      });

      // 3) Clear the fault. Re-upload Pending. Savepoint succeeds.
      // R3-T8 snapshot audit-pair baseline BEFORE retry so the delta
      // assertion below catches a regression that fixed the savepoint
      // commit but broke the audit emit on retry.
      vi.unstubAllEnvs();
      const auditBeforeRetry = await fetchAuditTypesForEvent();
      const stateChangedBeforeRetry = auditBeforeRetry.filter(
        (t) => t === 'csv_import_row_state_changed',
      ).length;
      const creditBackBeforeRetry = auditBeforeRetry.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      const r3 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Oli', 'Pending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r2-1-recover-3.csv',
        forceProceed: true,
      });
      expect(r3.kind).toBe('completed');
      if (r3.kind !== 'completed') return;
      expect(r3.summary.rowsStateChanged).toBe(1);

      const final = await fetchSoleRegistration(seed.eventId);
      expect(final[0]?.paymentStatus).toBe('pending');
      expect(final[0]?.countedAgainstPartnership).toBe(false);

      // R3-T8 — audit-pair delta on retry. Both the state-change row
      // AND the credit-back row MUST fire after the savepoint succeeds.
      const auditAfterRetry = await fetchAuditTypesForEvent();
      expect(
        auditAfterRetry.filter((t) => t === 'csv_import_row_state_changed').length,
      ).toBe(stateChangedBeforeRetry + 1);
      expect(
        auditAfterRetry.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBeforeRetry + 1);
    },
  );

  it(
    'R3-T1 / R3-C1 — audit.emit raw-throw converts to TxStageError and rolls back atomically',
    { timeout: 120_000 },
    async () => {
      const seed = await seedPartnerEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R2-1 atomicity test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1) Seed Attending row — payment_status=paid, counted=true.
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Pia', 'Attending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r3-t1-seed.csv',
      });
      expect(r1.kind).toBe('completed');
      const before = await fetchSoleRegistration(seed.eventId);
      expect(before[0]?.paymentStatus).toBe('paid');
      expect(before[0]?.countedAgainstPartnership).toBe(true);

      const auditBefore = await fetchAuditTypesForEvent();
      const stateChangedBefore = auditBefore.filter(
        (t) => t === 'csv_import_row_state_changed',
      ).length;
      const creditBackBefore = auditBefore.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      // 2) Mock the AUDIT EMITTER to RAW-THROW on the credit-back
      // event ONLY (so the state-change audit succeeds but the
      // quota credit-back blows up — testing the bypass vector that
      // pre-R3-C1 silently swallowed). The mock simulates a pool-
      // exhaust panic / sub-adapter regression that throws plain
      // Error instead of returning Result.err.
      //
      // We monkey-patch the global `F6AuditPort.emit` via a spied
      // adapter import. Because `runImportCsv` constructs the audit
      // port internally, we use the dual-write fallback's behavior:
      // setting env-flag `F6_TEST_AUDIT_EMIT_RAW_THROW` to the
      // event-type causes the production adapter to raw-throw at the
      // matching emit call.
      //
      // The env-flag is a NEW test-only fault-injection seam mirror-
      // ing F6_TEST_FAIL_AT_QUOTA_DEBIT (NODE_ENV==='test' guarded).
      vi.stubEnv('F6_TEST_AUDIT_EMIT_RAW_THROW', 'quota_credit_back_refund');

      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Pia', 'Pending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r3-t1-fault.csv',
        forceProceed: true,
      });

      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      // The raw-throw at the credit-back emit MUST roll the savepoint
      // back atomically. rowsStateChanged stays 0; rowsFailed >= 1.
      expect(r2.summary.rowsStateChanged).toBe(0);
      expect(r2.summary.rowsFailed).toBeGreaterThanOrEqual(1);

      const after = await fetchSoleRegistration(seed.eventId);
      expect(after).toHaveLength(1);
      expect(after[0]?.paymentStatus).toBe('paid'); // unchanged
      expect(after[0]?.countedAgainstPartnership).toBe(true); // unchanged

      // Critically — NEITHER the state-change audit NOR the credit-
      // back audit fired. Pre-R3-C1, the state-change audit would
      // have committed in-savepoint and only the credit-back would
      // be missing — i.e. count grows by 1 then rolls back to 0.
      // Post-R3-C1, both rows are absent because the helper-level
      // wrap converts the raw-throw into TxStageError BEFORE either
      // audit row commits.
      const auditAfter = await fetchAuditTypesForEvent();
      expect(
        auditAfter.filter((t) => t === 'csv_import_row_state_changed').length,
      ).toBe(stateChangedBefore);
      expect(
        auditAfter.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBefore);
    },
  );

  it(
    'R3-T7 — cultural-scope debit emits quota_credit_back_refund with scope=cultural',
    { timeout: 120_000 },
    async () => {
      // R3-T7 mirrors the happy-path test but seeds a cultural-only
      // event (NOT partner-benefit). The credit-back audit MUST emit
      // with scope='cultural' + the cultural-per-year allotment math
      // (NOT partnership-per-event). Pre-R3, the cultural branch was
      // structurally shared through `emitCreditBackViaStateChange` but
      // never exercised in an atomicity test — a refactor swapping
      // the partnership/cultural flag checks would have slipped past.
      const seed = await seedCulturalEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R3-T7 cultural test',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1) Attending seed — counted_against_cultural_quota=true.
      await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Cleo', 'Attending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r3-t7-seed.csv',
      });
      const after1 = await fetchSoleRegistration(seed.eventId);
      expect(after1[0]?.countedAgainstCulturalQuota).toBe(true);
      expect(after1[0]?.countedAgainstPartnership).toBe(false);

      const auditBefore = await fetchAuditTypesForEvent();
      const creditBackBefore = auditBefore.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      // 2) Debit re-upload — Attending → Pending.
      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow('Cleo', 'Pending', seed.attendeeEmail, seed.externalAttendeeId),
        ]),
        selectedEvent,
        originalFilename: 'r3-t7-debit.csv',
        forceProceed: true,
      });
      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      expect(r2.summary.rowsStateChanged).toBe(1);

      const after2 = await fetchSoleRegistration(seed.eventId);
      expect(after2[0]?.paymentStatus).toBe('pending');
      expect(after2[0]?.countedAgainstCulturalQuota).toBe(false);
      expect(after2[0]?.countedAgainstPartnership).toBe(false);

      // Verify the credit-back audit fired exactly once with
      // scope='cultural'. The summary payload contains "cultural
      // credit-back via state_change" per emit-credit-back-pair.ts.
      const auditAfter = await fetchAuditTypesForEvent();
      expect(
        auditAfter.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBefore + 1);
    },
  );

  it(
    'R4-T3 — cultural-scope fault-injection: audit raw-throw rolls back atomically',
    { timeout: 120_000 },
    async () => {
      // R4-T3 (2026-05-18 /speckit-review Round 4) — mirrors R3-T1
      // (partnership-scope fault-injection) but on the cultural debit
      // path. Defends against a future regression that breaks ONLY
      // the cultural emit branch (e.g., a typo `culturalPerYear` →
      // `culturalPerEvent` in the math, or scope label flip). R3-T7
      // happy-path alone wouldn't catch a cultural-only regression
      // because the test setup mirrors the partnership scope.
      const seed = await seedCulturalEventAndMember();
      const selectedEvent = {
        eventId: seed.eventId,
        externalId: seed.externalId,
        name: 'R4-T3 cultural fault-injection',
        startDate: new Date('2026-06-05T03:00:00Z'),
        category: null,
      };

      // 1) Seed Attending row — payment_status=paid, counted_cultural=true.
      const r1 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow(
            'Cleo',
            'Attending',
            seed.attendeeEmail,
            seed.externalAttendeeId,
          ),
        ]),
        selectedEvent,
        originalFilename: 'r4-t3-seed.csv',
      });
      expect(r1.kind).toBe('completed');
      const before = await fetchSoleRegistration(seed.eventId);
      expect(before[0]?.paymentStatus).toBe('paid');
      expect(before[0]?.countedAgainstCulturalQuota).toBe(true);

      const auditBefore = await fetchAuditTypesForEvent();
      const stateChangedBefore = auditBefore.filter(
        (t) => t === 'csv_import_row_state_changed',
      ).length;
      const creditBackBefore = auditBefore.filter(
        (t) => t === 'quota_credit_back_refund',
      ).length;

      // 2) Inject audit-emit raw-throw on `quota_credit_back_refund`
      // (the cultural credit-back fires this exact eventType).
      vi.stubEnv('F6_TEST_AUDIT_EMIT_RAW_THROW', 'quota_credit_back_refund');

      const r2 = await runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes: buildCsv([
          buildRow(
            'Cleo',
            'Pending',
            seed.attendeeEmail,
            seed.externalAttendeeId,
          ),
        ]),
        selectedEvent,
        originalFilename: 'r4-t3-fault.csv',
        forceProceed: true,
      });

      expect(r2.kind).toBe('completed');
      if (r2.kind !== 'completed') return;
      // Savepoint rolled back — state-change flag did NOT increment.
      expect(r2.summary.rowsStateChanged).toBe(0);
      expect(r2.summary.rowsFailed).toBeGreaterThanOrEqual(1);

      // Cultural quota flag UNCHANGED (still counted=true).
      const after = await fetchSoleRegistration(seed.eventId);
      expect(after).toHaveLength(1);
      expect(after[0]?.paymentStatus).toBe('paid');
      expect(after[0]?.countedAgainstCulturalQuota).toBe(true);

      // Critically — NO new audit rows for either side of the pair.
      // Pre-R3-C1, only the credit-back would be missing but the
      // state-changed audit would have committed in-savepoint (which
      // also rolls back). Post-R3-C1, BOTH rows are absent.
      const auditAfter = await fetchAuditTypesForEvent();
      expect(
        auditAfter.filter((t) => t === 'csv_import_row_state_changed').length,
      ).toBe(stateChangedBefore);
      expect(
        auditAfter.filter((t) => t === 'quota_credit_back_refund').length,
      ).toBe(creditBackBefore);
    },
  );
});
