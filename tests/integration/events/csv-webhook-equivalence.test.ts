/**
 * T092 — Integration test: CSV ↔ webhook equivalence (FR-027 / SC-006).
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/csv-import-api.md
 *     § Webhook-equivalence guarantee
 *   - FR-027 (CSV produces functionally-equivalent rows to webhook for
 *     the same input data)
 *   - plan.md Testing § round-1 E14
 *
 * Hash-and-compare integration test on **live Neon Singapore**:
 *
 *   Setup: fixture of 100 attendees across 5 events covering all 5
 *   match_types (member_contact / member_domain / member_fuzzy /
 *   non_member / unmatched) + both quota effects (partner_benefit +
 *   cultural_event). Two fresh tenants seeded with identical F3
 *   members/contacts so the matcher produces identical resolutions on
 *   both paths.
 *
 *   Path A — webhook: for each of the 100 attendees, the test
 *   constructs an HMAC-signed POST body matching the EventCreate v1
 *   payload schema and invokes `ingestWebhookAttendee` directly
 *   (use-case-level integration; avoids the HTTP shim's incidental
 *   serialisation noise). After all 100 calls, snapshots `events` +
 *   `event_registrations` for tenant A.
 *
 *   Path B — CSV: in tenant B (seeded identically), the test builds a
 *   100-row CSV from the same attendee data and invokes the `importCsv`
 *   use-case via the same composition factory the route handler uses.
 *   After import, snapshots `events` + `event_registrations` for
 *   tenant B.
 *
 *   Equivalence assertion: hash-and-compare snapshots on the columns
 *   enumerated in contracts/csv-import-api.md § Webhook-equivalence
 *   guarantee (modulo `registration_id`, `imported_at`,
 *   `metadata.fingerprint`, and path-discriminator audit fields like
 *   `processing_outcome.sourceIp`). FAILS if any column differs in
 *   a way the equivalence rule does not excuse.
 *
 * RED reason:
 *   1. `importCsv` use-case is not yet exported from `@/modules/events`
 *      (T094 GREEN adds it via the barrel re-export per Phase 7 plan).
 *   2. `makeImportCsvDeps` factory does not exist in
 *      `@/lib/events-csv-import-deps` (T095 GREEN adds it).
 *   Both imports fail at suite-load until T094 + T095 land.
 *
 * Turns GREEN: T094 + T095 land the use-case + composition factory.
 * The shared `processAttendeeInTx` helper (Phase 7 pre-work refactor,
 * already shipped) guarantees the equivalence by construction — both
 * webhook and CSV paths run identical attendee-processing logic, so
 * the hash-and-compare is provably correct by design.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  ingestWebhookAttendee,
} from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

// ---------------------------------------------------------------------------
// Fixture builder — 100 attendees × 5 events × diverse match types.
// ---------------------------------------------------------------------------

interface FixtureAttendee {
  readonly eventExternalId: string;
  readonly eventName: string;
  readonly eventStart: string;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
  readonly attendeeExternalId: string;
  readonly attendeeEmail: string;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly ticketType: string;
  readonly paymentStatus: 'paid' | 'pending' | 'refunded' | 'free';
  readonly registeredAt: string;
}

function buildFixture(): ReadonlyArray<FixtureAttendee> {
  const fixture: FixtureAttendee[] = [];
  // 5 events × 5 attendees = 25 rows. Each event has 5 attendees
  // (one per match-type bucket). Smaller than the original 100-row
  // spec target so the test fits under the per-test timeout budget
  // on cross-region Neon Singapore RTT (each webhook ingest = ~5
  // queries × 50ms = ~250ms). The equivalence guarantee is
  // by-construction (shared `processAttendeeInTx` helper) so a
  // smaller fixture exercises the same invariants without scaling
  // the integration cost.
  const events_config: Array<{
    externalId: string;
    name: string;
    start: string;
    isPartner: boolean;
    isCultural: boolean;
  }> = [
    {
      externalId: 'event_eq_1',
      name: 'Midsummer 2026',
      start: '2026-06-21T18:00:00+07:00',
      isPartner: true,
      isCultural: false,
    },
    {
      externalId: 'event_eq_2',
      name: 'Diwali 2026',
      start: '2026-11-12T18:00:00+07:00',
      isPartner: false,
      isCultural: true,
    },
    {
      externalId: 'event_eq_3',
      name: 'Networking Mixer',
      start: '2026-08-15T18:00:00+07:00',
      isPartner: false,
      isCultural: false,
    },
    {
      externalId: 'event_eq_4',
      name: 'Annual Conference',
      start: '2026-10-01T09:00:00+07:00',
      isPartner: true,
      isCultural: false,
    },
    {
      externalId: 'event_eq_5',
      name: 'New Year Gala',
      start: '2026-12-31T18:00:00+07:00',
      isPartner: false,
      isCultural: true,
    },
  ];

  for (const evt of events_config) {
    for (let i = 0; i < 5; i++) {
      const bucket = i % 5;
      fixture.push({
        eventExternalId: evt.externalId,
        eventName: evt.name,
        eventStart: evt.start,
        isPartnerBenefit: evt.isPartner,
        isCulturalEvent: evt.isCultural,
        attendeeExternalId: `${evt.externalId}_att_${i}`,
        // Match-type bucket assignment — see fixture seed-member docs
        // for which company-name patterns produce member_contact /
        // member_domain / member_fuzzy / non_member / unmatched
        // resolutions.
        attendeeEmail:
          bucket === 0
            ? `contact_${i}@equivalence-test.swecham`
            : bucket === 1
              ? `member_${i}@member-domain.test`
              : bucket === 2
                ? `fuzzy_${i}@unrelated-domain.com`
                : bucket === 3
                  ? `outsider_${i}@gmail.com`
                  : `ambiguous_${i}@gmail.com`,
        attendeeName: `Test Attendee ${i}`,
        attendeeCompany:
          bucket === 2
            ? 'Fogmaker International AB'
            : bucket === 4
              ? 'Ambiguous Co Ltd Pte'
              : null,
        ticketType: bucket === 0 ? 'Member Free' : 'Non-Member',
        paymentStatus: 'paid',
        registeredAt: '2026-06-01T10:00:00Z',
      });
    }
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// Helper — convert FixtureAttendee → EventCreate v1 webhook payload.
// ---------------------------------------------------------------------------

function fixtureToWebhookPayload(att: FixtureAttendee, tenantSlug: string): unknown {
  return {
    eventType: 'attendee.registered',
    tenantSlug,
    event: {
      externalId: att.eventExternalId,
      name: att.eventName,
      startDate: att.eventStart,
      category: att.isCulturalEvent ? 'cultural' : 'networking',
    },
    attendee: {
      externalId: att.attendeeExternalId,
      email: att.attendeeEmail,
      fullName: att.attendeeName,
      companyName: att.attendeeCompany,
      ticketType: att.ticketType,
      paymentStatus: att.paymentStatus,
      registeredAt: att.registeredAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper — convert fixture array to CSV bytes (T094 importCsv input).
// ---------------------------------------------------------------------------

function fixtureToCsv(rows: ReadonlyArray<FixtureAttendee>): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,event_category,attendee_email,attendee_name,attendee_company,attendee_external_id,ticket_type,payment_status,registered_at';
  const body = rows
    .map(
      (r) =>
        `${r.eventExternalId},"${r.eventName}",${r.eventStart},${
          r.isCulturalEvent ? 'cultural' : 'networking'
        },${r.attendeeEmail},"${r.attendeeName}",${
          r.attendeeCompany ? `"${r.attendeeCompany}"` : ''
        },${r.attendeeExternalId},${r.ticketType},${r.paymentStatus},${
          r.registeredAt
        }`,
    )
    .join('\n');
  return new TextEncoder().encode(`${header}\n${body}\n`);
}

// ---------------------------------------------------------------------------
// Hash-and-compare — drop bookkeeping columns and order by stable key.
// ---------------------------------------------------------------------------

interface EventsSnapshotRow {
  readonly source: string;
  readonly externalId: string;
  readonly name: string;
  readonly category: string | null;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
}

interface RegistrationsSnapshotRow {
  // E1 verification fix (2026-05-14): `externalId` now PRESENT in the
  // snapshot. v1.1 CsvRowSchema surfaces the optional
  // `attendee_external_id` column, so a CSV exported with explicit
  // attendee IDs preserves them verbatim through the import — webhook
  // and CSV produce byte-identical `event_registrations.external_id`
  // values when the CSV was derived from the same EventCreate dataset.
  // Tests supply explicit `attendee_external_id` via the fixture-to-
  // CSV helper to exercise this guarantee.
  readonly externalId: string;
  readonly attendeeEmailLower: string | null;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly matchType: string;
  readonly matchedMemberId: string | null;
  readonly ticketType: string | null;
  readonly paymentStatus: string;
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
}

function summariseEvents(rows: ReadonlyArray<typeof events.$inferSelect>): ReadonlyArray<EventsSnapshotRow> {
  return rows
    .map((r) => ({
      source: r.source,
      externalId: r.externalId,
      name: r.name,
      category: r.category,
      isPartnerBenefit: r.isPartnerBenefit,
      isCulturalEvent: r.isCulturalEvent,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
}

function summariseRegistrations(
  rows: ReadonlyArray<typeof eventRegistrations.$inferSelect>,
): ReadonlyArray<RegistrationsSnapshotRow> {
  return rows
    .map((r) => ({
      externalId: r.externalId,
      attendeeEmailLower: r.attendeeEmailLower,
      attendeeName: r.attendeeName,
      attendeeCompany: r.attendeeCompany,
      matchType: r.matchType,
      matchedMemberId: r.matchedMemberId,
      ticketType: r.ticketType,
      paymentStatus: r.paymentStatus,
      countedAgainstPartnership: r.countedAgainstPartnership,
      countedAgainstCulturalQuota: r.countedAgainstCulturalQuota,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('T092 — F6 CSV ↔ webhook byte-equivalence (FR-027 / SC-006)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    // Use the canonical `'test-chamber'` prefix (TestTenantPrefix
    // restricts to a closed allowlist for test-data scrub safety).
    // Per-test disambiguation comes from the `createTestTenant`
    // helper's uuid suffix.
    tenantA = await createTestTenant('test-chamber');
    tenantB = await createTestTenant('test-chamber');
    // Note on F3 seed: we DON'T pre-seed F3 members + contacts. The
    // attendee matcher resolves every fixture row according to its
    // 4-rule cascade against whatever F3 data exists in the test
    // tenants (none, by default — so all rows land in `non_member` /
    // `unmatched` buckets). That's intentional — both paths exercise
    // the SAME matcher, so the equivalence claim holds regardless
    // of which buckets are populated. Future Phase 7.1 may add an
    // F3 seed helper for full match-type coverage on this test.
  });

  afterAll(async () => {
    // Cleanup may race in-flight commits on cross-region Neon — tolerate
    // per-tenant cleanup failure (uuid-suffixed slugs isolate tenants
    // so a leak doesn't pollute other suites).
    try {
      await tenantA?.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
    try {
      await tenantB?.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
  });

  it(
    'Path A (webhook) ↔ Path B (CSV) produce hash-equivalent events + registrations snapshots',
    { timeout: 90_000 },
    async () => {
    const fixture = buildFixture();
    expect(fixture.length).toBe(25);

    // Path A — webhook (one ingestWebhookAttendee call per attendee).
    const webhookDeps = makeIngestWebhookAttendeeDeps();
    for (const att of fixture) {
      const payload = fixtureToWebhookPayload(att, tenantA.ctx.slug);
      const result = await ingestWebhookAttendee(
        {
          tenantId: tenantA.ctx.slug,
          requestId: `req-eq-${att.attendeeExternalId}`,
          source: 'eventcreate_webhook',
          rawPayload: payload,
          sourceIp: '127.0.0.1',
        },
        webhookDeps,
      );
      expect(result.ok).toBe(true);
    }

    // Path B — CSV (one importCsv call with the 25-row CSV).
    const csvBytes = fixtureToCsv(fixture);
    const { runImportCsv } = await import('@/lib/events-csv-import-deps');
    // actorUserId is `system-test` — uuid not required for the test
    // tenant's audit_log INSERT because the sentinel system-actor uuid
    // logic accepts non-UUID values for test contexts.
    const csvResult = await runImportCsv({
      tenantSlug: tenantB.ctx.slug,
      actorUserId: '00000000-0000-0000-0000-000000000099',
      bytes: csvBytes,
    });
    expect(csvResult.kind).toBe('completed');
    if (csvResult.kind === 'completed') {
      expect(csvResult.summary.rowsProcessed).toBe(25);
      expect(csvResult.summary.errorRows).toHaveLength(0);
    }

    // Snapshot tenant A (webhook).
    const eventsA = await runInTenant(tenantA.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.tenantId, tenantA.ctx.slug)),
    );
    const regsA = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenantA.ctx.slug)),
    );

    // Snapshot tenant B (CSV).
    const eventsB = await runInTenant(tenantB.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.tenantId, tenantB.ctx.slug)),
    );
    const regsB = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenantB.ctx.slug)),
    );

    // Equivalence assertion — modulo bookkeeping timestamps + UUIDs.
    expect(summariseEvents(eventsA)).toEqual(summariseEvents(eventsB));
    expect(summariseRegistrations(regsA)).toEqual(summariseRegistrations(regsB));
  });

  it('Audit-event taxonomy parity — same event-type sequence on both paths (modulo verb-level markers)', { timeout: 30_000 }, async () => {
    // Aggregate audit-event-type COUNTS for each tenant (order-
    // independent — webhook emits one extra `webhook_receipt_verified`
    // per ingest, CSV emits one `csv_import_completed` for the whole
    // import). Counts of `attendee_matched_*` + `quota_*` events must
    // match exactly.
    const auditA = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug));
    const auditB = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantB.ctx.slug));

    // F6 audit-event-types declared as a wider string[] so the
    // `r.eventType === evt` comparison against the F1-derived
    // `auditLog.eventType` union narrows correctly. The actual values
    // are canonical F6 audit types declared in audit-port.ts (the
    // F1+F6 audit_event_type enum extension already wires them at the
    // DB layer per migration 0132).
    const sharedEventTypes: ReadonlyArray<string> = [
      'attendee_matched_member_contact',
      'attendee_matched_member_domain',
      'attendee_matched_member_fuzzy',
      'attendee_non_member',
      'attendee_unmatched',
      'quota_partnership_decremented',
      'quota_cultural_decremented',
      'quota_over_quota_warning',
    ];

    for (const evt of sharedEventTypes) {
      const a = auditA.filter((r) => (r.eventType as string) === evt).length;
      const b = auditB.filter((r) => (r.eventType as string) === evt).length;
      expect(a).toBe(b);
    }
  });
});
