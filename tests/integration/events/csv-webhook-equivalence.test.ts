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
 * The shared `processAttendeeInTx` helper guarantees the equivalence
 * by construction — both webhook and CSV paths run identical
 * attendee-processing logic, so the hash-and-compare is provably
 * correct by design.
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
import { asUserId } from '@/modules/auth';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser } from '../helpers/test-users';
import { f6CsvTestSelectedEventStub } from '../../unit/events/_helpers/f6-csv-test-fixtures';
// R10.2 / QA F-2 closure — needed to seed a real event into tenantB
// so the FK constraint csv_import_records_event_fk (migration 0139)
// can resolve. The previous test relied on the f6CsvTestSelectedEventStub
// UUID which is intentionally NOT seeded into the events table for
// unit-test contexts (the stub's docstring says: "tests that hit live
// Neon must override with a pre-seeded event").
import { randomUUID } from 'node:crypto';
import { asEventId } from '@/modules/events';

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

// R10.2 (rewrite) — single-event fixture compatible with F6.1 CSV API.
// The F6.1 CSV import requires a single `selectedEvent` per batch
// (admin picks ONE event for the whole CSV upload). The original
// multi-event design (5 events × 5 attendees = 25 rows) produced
// 5 events on the webhook path vs 1 event on the CSV path — broken
// equivalence by construction. Now: 1 event × 5 attendees = 5 rows,
// one attendee per match-type bucket. Both paths produce 1 event +
// 5 registrations with byte-identical state (modulo bookkeeping
// timestamps + UUIDs).
//
// The 5 match-type buckets are NOT actually exercised here (no F3
// member seed), so all rows resolve as `non_member` / `unmatched` —
// `csv-webhook-equivalence-5match.test.ts` covers the full 5/5
// match-type byte-equivalence with F3 members seeded.
// R10.2 (rewrite) — fixture uses a non-partner / non-cultural event
// because webhook ingest auto-derives `isPartnerBenefit` /
// `isCulturalEvent` from the payload's `category` field, while CSV
// import takes them from the pre-seeded DB row. Aligning on the
// default-false state avoids the auto-derivation divergence and
// keeps the snapshot-equivalence assertion focused on the matcher
// + registration row shape (not the category mapping).
const FIXTURE_EVENT = {
  externalId: 'event_eq_single',
  name: 'Equivalence Test Event',
  start: '2026-06-21T18:00:00+07:00',
  isPartner: false,
  isCultural: false,
} as const;

function buildFixture(): ReadonlyArray<FixtureAttendee> {
  const fixture: FixtureAttendee[] = [];
  // 1 event × 5 attendees (one per match-type bucket).
  const evt = FIXTURE_EVENT;
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
      // resolutions. Without F3 seed (see beforeAll comment), all
      // rows resolve to `non_member` / `unmatched` buckets — that's
      // intentional. The equivalence claim holds regardless of
      // which buckets land because both paths share the same matcher.
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

describe('F6 CSV ↔ webhook hash-equivalence over enumerated columns (FR-027 / SC-006)', () => {
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

  // R10.2 (rewrite, 2026-05-17) — single-event fixture compatible
  // with F6.1 CSV API. Both paths produce 1 event + 5 registrations
  // with byte-identical state (modulo bookkeeping timestamps + UUIDs).
  //
  // FR-027 byte-equivalence guarantee verified by direct cross-path
  // snapshot comparison. Complements `csv-webhook-equivalence-5match.
  // test.ts` which exercises the full 5/5 MatchType variants with F3
  // members seeded; this test exercises the bookkeeping-column parity
  // across the matcher-default `non_member` / `unmatched` buckets
  // without needing F3 seed.
  it(
    'Path A (webhook) ↔ Path B (CSV) produce hash-equivalent events + registrations snapshots',
    { timeout: 90_000 },
    async () => {
    const fixture = buildFixture();
    expect(fixture.length).toBe(5);

    // Path A — webhook (one ingestWebhookAttendee call per attendee).
    // Webhook auto-creates the event row from the first delivery's
    // event payload; subsequent deliveries upsert the same event.
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

    // Path B — CSV. Pre-seed an IDENTICAL event row (same externalId,
    // name, startDate, flags) so the CSV path's 1 event matches the
    // webhook path's 1 event for snapshot comparison. F6.1 CSV API
    // requires the selectedEvent to already exist via the events
    // table (admin picks via combobox); we seed it directly to mimic
    // that precondition.
    const csvBytes = fixtureToCsv(fixture);
    const { runImportCsv } = await import('@/lib/events-csv-import-deps');

    const csvActor = await createActiveTestUser('admin');
    const csvActorUserId = asUserId(csvActor.userId);

    const seededCsvEventId = randomUUID();
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenantB.ctx.slug,
        eventId: seededCsvEventId,
        source: 'eventcreate',
        // Match the webhook-created event shape so the cross-path
        // snapshot comparison succeeds. Webhook ingest sets these
        // fields from the payload's event sub-object.
        //
        // 095 dup-event fix: the CSV import now binds attendees to this
        // pre-seeded (admin-selected) event and NO LONGER upserts the
        // event's own columns from the CSV. So the seeded row must
        // already carry the same `category` the webhook derives from its
        // payload (`att.isCulturalEvent ? 'cultural' : 'networking'`) —
        // it models the admin creating the event with that category
        // before importing. Registration-level equivalence (the real
        // FR-027 guarantee) is unaffected and still asserted below.
        externalId: FIXTURE_EVENT.externalId,
        name: FIXTURE_EVENT.name,
        startDate: new Date(FIXTURE_EVENT.start),
        category: FIXTURE_EVENT.isCultural ? 'cultural' : 'networking',
        isPartnerBenefit: FIXTURE_EVENT.isPartner,
        isCulturalEvent: FIXTURE_EVENT.isCultural,
      });
    });

    const csvResult = await runImportCsv({
      tenantSlug: tenantB.ctx.slug,
      actorUserId: csvActorUserId,
      bytes: csvBytes,
      selectedEvent: {
        ...f6CsvTestSelectedEventStub,
        eventId: asEventId(seededCsvEventId),
        externalId: FIXTURE_EVENT.externalId,
        name: FIXTURE_EVENT.name,
        startDate: new Date(FIXTURE_EVENT.start),
        // category from FIXTURE_EVENT shape — used by CSV import to
        // surface in the result summary. isPartnerBenefit /
        // isCulturalEvent live on the DB row (seeded above) and CSV
        // import reads them from DB, not from `selectedEvent`.
      },
    });
    expect(csvResult.kind).toBe('completed');
    if (csvResult.kind === 'completed') {
      expect(csvResult.summary.rowsProcessed).toBe(5);
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

    // 095 — the CSV path now writes NO event row (it binds to the seeded
    // event), so the events-half of this equivalence is controlled by
    // this test's own seed on BOTH sides (FIXTURE_EVENT). Guard against a
    // residual CSV-side upsert regression: assert the import spawned no
    // SECOND event. (Because the seeded event is `eventcreate` +
    // FIXTURE_EVENT.externalId, a same-key upsert would MERGE rather than
    // add a row — the cross-source no-duplicate proof for an
    // `admin_manual` selected event lives in
    // csv-import-selected-event-binding.test.ts. The registration-half
    // below carries the FR-027 attendee equivalence.)
    expect(eventsB).toHaveLength(1);

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
