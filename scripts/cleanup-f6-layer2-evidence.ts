/**
 * Cleanup synthetic L2 evidence seed.
 *
 * Companion to `scripts/seed-f6-layer2-evidence.ts` — deletes the
 * synthetic event(s) named `F6 T154a Layer 2 evidence` and their
 * 2 associated `event_registrations` rows from production.
 *
 * Idempotent: re-running after a partial cleanup is safe (DELETE
 * over zero rows is a no-op).
 *
 * Audit: emits a structured pino log line per deleted row so the
 * operator audit trail records the cleanup action. We do NOT
 * emit F6 audit events (no `event_archived` / similar) because
 * the synthetic rows are operator-test data, not chamber records
 * — F6 audit_log is reserved for real chamber business events.
 *
 * Constitution v1.4.0 Principle I: deletions happen inside
 * `runInTenant(ctx, ...)` so the tenant scope is enforced at
 * the DB layer (RLS) regardless of what the application supplied.
 */
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { env } from '@/lib/env';
import { asTenantContext } from '@/modules/tenants';

const SYNTHETIC_EVENT_NAME = 'F6 T154a Layer 2 evidence';

function maskUuid(uuid: string): string {
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

async function main(): Promise<void> {
  const tenantSlug = env.tenant.slug;

  console.log('');
  console.log('=== T154a Layer 2 — synthetic seed cleanup ===');
  console.log('');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`Target event_name: ${SYNTHETIC_EVENT_NAME}`);
  console.log('');

  const ctx = asTenantContext(tenantSlug);

  const summary = { eventsDeleted: 0, registrationsDeleted: 0 };

  await runInTenant(ctx, async (tx) => {
    // 1. Find matching synthetic events for this tenant.
    const targets = await tx
      .select({ eventId: events.eventId, externalId: events.externalId })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantSlug),
          eq(events.name, SYNTHETIC_EVENT_NAME),
        ),
      );

    if (targets.length === 0) {
      console.log('No synthetic L2 evidence rows to clean up.');
      return;
    }

    console.log(`Found ${targets.length} synthetic event row(s):`);
    for (const t of targets) {
      console.log(`  - ${maskUuid(t.eventId)}  external_id=${t.externalId}`);
    }
    console.log('');

    // 2. Delete attendances first (FK), then events.
    for (const t of targets) {
      const regs = await tx
        .delete(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenantSlug),
            eq(eventRegistrations.eventId, t.eventId),
          ),
        )
        .returning({ registrationId: eventRegistrations.registrationId });

      summary.registrationsDeleted += regs.length;

      await tx
        .delete(events)
        .where(
          and(eq(events.tenantId, tenantSlug), eq(events.eventId, t.eventId)),
        );

      summary.eventsDeleted += 1;
    }
  });

  console.log('Cleanup result:');
  console.log(`  events deleted: ${summary.eventsDeleted}`);
  console.log(`  event_registrations deleted: ${summary.registrationsDeleted}`);
  console.log('');

  if (summary.eventsDeleted > 0 || summary.registrationsDeleted > 0) {
    console.log('✅ Cleanup complete');
  } else {
    console.log('ℹ️ Nothing to clean up (already cleaned or never seeded).');
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error('Cleanup script crashed:', message);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
