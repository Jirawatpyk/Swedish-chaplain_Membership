/**
 * T154a Layer 2 — production evidence seed.
 *
 * Operator runs this AFTER `pnpm verify:f6-f8` (Layer 1) confirms the
 * composition root has selected `drizzleEventAttendeesAdapter` in
 * production runtime. This script:
 *
 *   1. Picks 1 existing member from the SweCham tenant (UUID only —
 *      no PII printed to stdout).
 *   2. Inserts 1 evidence event ("F6 T154a Layer 2 evidence") + 2
 *      event_registration rows linked to that member via direct
 *      Drizzle inserts inside `runInTenant(ctx, ...)` so RLS approves.
 *      Direct DB writes deliberately bypass the createEvent +
 *      importCsv use-cases so audit_log is not polluted and quota
 *      counters are not decremented for this synthetic seed.
 *   3. Queries the F8 bridge port `drizzleEventAttendeesAdapter.
 *      listAttendances(tenantSlug, memberId)` and asserts ≥2 of the
 *      seeded records are visible (matched by eventId).
 *
 * Pass criteria:
 *   - exit code 0
 *   - stdout reports `✅ T154a Layer 2 PRODUCTION — PASS`
 *   - F8 bridge query returns ≥2 records keyed to the seeded event
 *
 * If any of these miss → exit 1 → operator must inspect composition
 * root + RLS context resolution + adapter wiring before flag-flip
 * is fully validated.
 *
 * Cleanup: the seed deliberately persists (low-volume production
 * data; cleanup script may run later if desired). Event name and
 * external_id include the prefix `F6 T154a Layer 2 evidence` /
 * `f6-l2-evidence-` so future operators can grep + delete.
 *
 * Constitution v1.4.0 Principle I: every write happens inside
 * `runInTenant` so the tenant scope is enforced at the DB layer
 * (RLS) regardless of what the application supplied.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { env } from '@/lib/env';
import { drizzleEventAttendeesAdapter } from '@/modules/events/infrastructure/drizzle-event-attendees-by-member';
import { asTenantContext } from '@/modules/tenants';

function maskUuid(uuid: string): string {
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

async function main(): Promise<void> {
  const tenantSlug = env.tenant.slug;

  console.log('');
  console.log('=== T154a Layer 2 — production evidence seed ===');
  console.log('');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`FEATURE_F6_EVENTCREATE: ${env.features.f6EventCreate}`);
  console.log('');

  // 1. Find one member (UUID only — never print email or other PII).
  const memberRows = await db
    .select({ memberId: members.memberId })
    .from(members)
    .where(eq(members.tenantId, tenantSlug))
    .limit(1);

  if (memberRows.length === 0) {
    console.error('❌ No members found in tenant — Layer 2 seed requires ≥1 member.');
    console.error('   Hint: bootstrap via /admin/members first, then re-run.');
    process.exit(1);
  }

  const memberId = memberRows[0]!.memberId;
  console.log(`Selected member: ${maskUuid(memberId)}`);
  console.log('');

  // 2. Seed 1 evidence event + 2 attendances inside tenant context (RLS).
  const eventId = randomUUID();
  const ctx = asTenantContext(tenantSlug);
  const eventStart = new Date();
  eventStart.setDate(eventStart.getDate() - 7); // 7d ago — well within F8's 90d window.
  const seedStamp = Date.now();

  await runInTenant(ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenantSlug,
      eventId,
      source: 'eventcreate',
      externalId: `f6-l2-evidence-${seedStamp}`,
      name: 'F6 T154a Layer 2 evidence',
      startDate: eventStart,
      isPartnerBenefit: false,
      isCulturalEvent: false,
    } as unknown as typeof events.$inferInsert);

    for (let i = 0; i < 2; i++) {
      const regAt = new Date();
      regAt.setDate(regAt.getDate() - 7 + i);
      await tx.insert(eventRegistrations).values({
        tenantId: tenantSlug,
        registrationId: randomUUID(),
        eventId,
        source: 'eventcreate',
        externalId: `f6-l2-att-${seedStamp}-${i}`,
        attendeeEmail: `f6-l2-evidence-${seedStamp}-${i}@layer2.local`,
        attendeeName: `L2 Evidence Attendee ${i + 1}`,
        attendeeCompany: 'L2 Evidence Co',
        matchType: 'member_contact',
        matchedMemberId: memberId,
        paymentStatus: 'paid',
        ticketType: 'L2 Evidence',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
        metadata: {},
        registeredAt: regAt,
        piiPseudonymisedAt: null,
      } as unknown as typeof eventRegistrations.$inferInsert);
    }
  });

  console.log(`Seeded: event ${maskUuid(eventId)} + 2 attendance rows`);
  console.log('');

  // 3. F8 bridge port query — Layer 2 assertion.
  const records = await drizzleEventAttendeesAdapter.listAttendances(
    tenantSlug,
    memberId,
  );
  const seededVisible = records.filter((r) => r.eventId === eventId).length;
  const adapterReady = drizzleEventAttendeesAdapter.isAvailable();

  console.log(`F8 bridge port returned: ${records.length} total · ${seededVisible}/2 seeded`);
  console.log(`drizzleEventAttendeesAdapter.isAvailable(): ${adapterReady}`);
  console.log('');

  if (seededVisible >= 2 && adapterReady) {
    console.log('✅ T154a Layer 2 PRODUCTION — PASS');
    console.log('   REAL ADAPTER active + seeded rows visible via bridge port');
    console.log('   F8 at-risk-scorer will see this data on next recompute');
    console.log('   eventAttendanceFactor.skipped will be FALSE');
    process.exit(0);
  }

  console.error('❌ T154a Layer 2 — FAIL');
  console.error(`   isAvailable: ${adapterReady} (expected true)`);
  console.error(`   seeded visible: ${seededVisible}/2 (expected ≥2)`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error('Seed script crashed:', message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
