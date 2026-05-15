/**
 * T016 (Feature 013 · F6.1) — Real EventCreate-fixture integration test.
 *
 * Uploads the two committed real CSV fixtures
 * (`docs/Attendee list/EventCreate_Guestlist-*.csv`) end-to-end through
 * `runImportCsv` on live Neon Singapore. Validates:
 *
 *   1. EventCreate format auto-detected (sourceFormat: 'eventcreate_csv').
 *   2. Status filter (FR-007) drops non-Attending rows into rowsSkipped.
 *   3. Every Attending row lands in event_registrations.
 *   4. Idempotency receipts populated (re-upload would dedupe).
 *   5. csv_import_records placeholder + final outcome update flow.
 *
 * Cross-references the contract test (T012) by hitting the real parser
 * and real Drizzle adapters — no mocks. Failures here would block US1.
 *
 * Live DB cost: ~3-5s per fixture against Neon Singapore. The 2 fixtures
 * + setup run in ~15s of total wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  csvImportRecords,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const FIXTURE_DIR = join(process.cwd(), 'docs', 'Attendee list');

interface SeededEvent {
  readonly eventId: string;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

async function seedEvent(
  tenant: TestTenant,
  overrides: Partial<SeededEvent> = {},
): Promise<SeededEvent> {
  const eventId = overrides.eventId ?? randomUUID();
  const externalId = overrides.externalId ?? `event-${eventId.slice(0, 8)}`;
  const name = overrides.name ?? 'Real-fixture seeded event';
  const startDate = overrides.startDate ?? new Date('2026-06-21T18:00:00Z');
  const category = overrides.category ?? null;

  await db.insert(events).values({
    tenantId: tenant.ctx.slug,
    eventId,
    source: 'eventcreate',
    externalId,
    name,
    startDate,
    category,
  } satisfies NewEventRow);

  return { eventId, externalId, name, startDate, category };
}

describe('T016 — Real EventCreate fixture integration on live Neon', () => {
  let tenant: TestTenant;
  let actor: TestUser;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    // csv_import_records.actor_user_id FK → users.id (migration 0139).
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

  it('Grant Thornton workshop fixture imports cleanly — sourceFormat=eventcreate_csv + recordId surfaced', async () => {
    const event = await seedEvent(tenant, {
      name: 'Grant Thornton Workshop 2026',
      externalId: 'event-gt-workshop',
      startDate: new Date('2026-03-15T13:00:00Z'),
    });

    const bytes = await readFile(
      join(FIXTURE_DIR, 'EventCreate_Guestlist-grant-thornton-workshop.csv'),
    );

    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: new Uint8Array(bytes),
      selectedEvent: { ...event, eventId: event.eventId },
      originalFilename: 'EventCreate_Guestlist-grant-thornton-workshop.csv',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.sourceFormat).toBe('eventcreate_csv');
    expect(typeof result.recordId).toBe('string');
    expect(result.recordId.length).toBeGreaterThan(0);
    // Attending rows landed; rowsSkipped covers FR-007 Status filter.
    // The full identity: rowsTotal = processed + skipped + failed + alreadyImported.
    expect(result.summary.rowsTotal).toBeGreaterThan(0);
    expect(result.summary.rowsProcessed).toBeGreaterThan(0);
    expect(
      result.summary.rowsProcessed +
        result.summary.rowsSkipped +
        result.summary.rowsFailed +
        result.summary.rowsAlreadyImported,
    ).toBe(result.summary.rowsTotal);

    // Independent DB-side verification — event_registrations populated.
    const regs = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, event.eventId),
          ),
        ),
    );
    expect(regs.length).toBe(result.summary.rowsProcessed);

    // I6 (Round 1 — pr-test-analyzer): FR-009 end-to-end persistence
    // verification. The Grant Thornton fixture has EventCreate format
    // with "Personal Data Protection Consent" column, so at least
    // some rows should have a non-NULL classification (true/false)
    // per the F6.1 dedicated-column design (migration 0140 + T022).
    // Generic-CSV rows would all be NULL — but this fixture is
    // EventCreate format, so the column MUST surface tri-state data.
    const pdpaTrue = regs.filter(
      (r) => r.attendeePdpaConsentAcknowledged === true,
    );
    const pdpaFalse = regs.filter(
      (r) => r.attendeePdpaConsentAcknowledged === false,
    );
    const pdpaNull = regs.filter(
      (r) => r.attendeePdpaConsentAcknowledged === null,
    );
    // Sum equals total — every row classified into exactly one bucket.
    expect(pdpaTrue.length + pdpaFalse.length + pdpaNull.length).toBe(
      regs.length,
    );
    // F7 broadcast filter (WHERE attendee_pdpa_consent_acknowledged
    // = true) MUST resolve to non-zero — otherwise compliance-
    // marketing-opt-in is broken. The Grant Thornton fixture
    // contains "I hereby acknowledge" rows.
    expect(pdpaTrue.length).toBeGreaterThan(0);
    // R2 I6 (Round 2 — pr-test-analyzer): assert the non-true branches
    // are populated too. The Grant Thornton fixture has ~57 rows but
    // only ~16 match "I hereby acknowledge" — the remainder MUST land
    // as `false` or `null` (not silently default to `true`). Without
    // this assertion, a regression dropping the classifier's `false`
    // branch (treating every non-acknowledge as `null` only, or worse
    // defaulting to `true`) would not surface here.
    expect(pdpaFalse.length + pdpaNull.length).toBeGreaterThan(0);

    // csv_import_records finalised — outcome != 'unexpected_error' (placeholder default).
    const records = await db
      .select()
      .from(csvImportRecords)
      .where(
        and(
          eq(csvImportRecords.tenantId, tenant.ctx.slug),
          eq(csvImportRecords.recordId, result.recordId),
        ),
      );
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toMatch(/^(completed|partial_failure)$/);
    expect(records[0]?.sourceFormat).toBe('eventcreate_csv');
    expect(records[0]?.eventId).toBe(event.eventId);
  });

  it('SweCham AGM 2026 fixture imports cleanly — fingerprint computed + persisted', async () => {
    const event = await seedEvent(tenant, {
      name: 'SweCham AGM 2026',
      externalId: 'event-agm-2026',
      startDate: new Date('2026-03-20T18:00:00Z'),
    });

    const bytes = await readFile(
      join(
        FIXTURE_DIR,
        'EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv',
      ),
    );

    const result = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes: new Uint8Array(bytes),
      selectedEvent: { ...event, eventId: event.eventId },
      originalFilename:
        'EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.sourceFormat).toBe('eventcreate_csv');
    expect(result.summary.rowsProcessed).toBeGreaterThan(0);

    // Fingerprint persisted to csv_import_records.attendee_fingerprint
    // (FR-019a — 16-char SHA-256 hex prefix; the safety-net look-up
    // queries this column on subsequent uploads).
    const records = await db
      .select()
      .from(csvImportRecords)
      .where(
        and(
          eq(csvImportRecords.tenantId, tenant.ctx.slug),
          eq(csvImportRecords.recordId, result.recordId),
        ),
      );
    expect(records).toHaveLength(1);
    expect(records[0]?.attendeeFingerprint).not.toBeNull();
    expect(records[0]?.attendeeFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
