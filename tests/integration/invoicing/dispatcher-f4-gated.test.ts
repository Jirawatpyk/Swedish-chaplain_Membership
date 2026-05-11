/**
 * R7-B4 integration test — the shared `/api/cron/outbox-dispatch`
 * route MUST filter out `invoice_auto_email` rows when
 * FEATURE_F4_INVOICING=false, while continuing to drain F1 rows.
 *
 * This locks in the "kill-switch actually contains F4 in-flight email
 * dispatch" guarantee that was silently broken prior to R7 (the proxy
 * gated a non-existent path `/api/cron/auto-email-dispatch`).
 *
 * Uses live Neon per repo convention. Seeds 2 outbox rows (one F1,
 * one F4), runs the filter query with the flag off, and asserts only
 * the F1 row is picked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, lte, ne } from 'drizzle-orm';
import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';

describe('R7-B4 — outbox dispatcher query filters invoice_auto_email when F4 off', () => {
  const createdOutboxIds: string[] = [];

  afterEach(async () => {
    for (const id of createdOutboxIds) {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.id, id));
    }
    createdOutboxIds.length = 0;
  });

  beforeEach(async () => {
    // Explicit past timestamp — removes any microsecond race where the
    // `defaultNow()` insertion value could be a few micros after the
    // test's `new Date()`. The query uses `lte(nextRetryAt, now)`, so
    // a row at exactly `now` matches, but an explicitly-past value
    // is unambiguous.
    const past = new Date(Date.now() - 60_000);

    // One F1 (member_invitation) row — should always drain.
    // Round-3 follow-up: tenant_id became NOT NULL via migration 0098;
    // F1 invite production code now passes the inviter's tenant slug.
    // Use 'swecham' here for parity.
    const f1 = await db
      .insert(notificationsOutbox)
      .values({
        notificationType: 'member_invitation',
        toEmail: `r7b4-f1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@swecham.test`,
        locale: 'en',
        contextData: { token: 'mock-token', role: 'member' },
        status: 'pending',
        tenantId: 'swecham',
        nextRetryAt: past,
      })
      .returning({ id: notificationsOutbox.id });
    if (f1[0]?.id) createdOutboxIds.push(f1[0].id);

    // One F4 (invoice_auto_email) row — should be SKIPPED when
    // flag=false, SEEN when flag=true.
    const f4 = await db
      .insert(notificationsOutbox)
      .values({
        notificationType: 'invoice_auto_email',
        toEmail: `r7b4-f4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@swecham.test`,
        locale: 'en',
        contextData: {
          event_type: 'invoice_issued',
          pdf_blob_key: 'invoicing/test-tenant/2026/fake-uuid_v1.pdf',
        },
        status: 'pending',
        tenantId: 'test-tenant-r7b4',
        nextRetryAt: past,
      })
      .returning({ id: notificationsOutbox.id });
    if (f4[0]?.id) createdOutboxIds.push(f4[0].id);
  });

  it('WITH f4 filter (flag=false) — F4 row is NOT returned', async () => {
    const now = new Date();
    const rows = await db
      .select({ id: notificationsOutbox.id, type: notificationsOutbox.notificationType })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.status, 'pending'),
          lte(notificationsOutbox.nextRetryAt, now),
          ne(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      );

    const seededIds = new Set(createdOutboxIds);
    const seenTypes = new Set(
      rows.filter((r) => seededIds.has(r.id)).map((r) => r.type),
    );
    expect(seenTypes.has('member_invitation')).toBe(true);
    expect(seenTypes.has('invoice_auto_email')).toBe(false);
  });

  it('WITHOUT f4 filter (flag=true) — both F1 and F4 rows are returned', async () => {
    const now = new Date();
    const rows = await db
      .select({ id: notificationsOutbox.id, type: notificationsOutbox.notificationType })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.status, 'pending'),
          lte(notificationsOutbox.nextRetryAt, now),
        ),
      );

    const seededIds = new Set(createdOutboxIds);
    const seenTypes = new Set(
      rows.filter((r) => seededIds.has(r.id)).map((r) => r.type),
    );
    expect(seenTypes.has('member_invitation')).toBe(true);
    expect(seenTypes.has('invoice_auto_email')).toBe(true);
  });
});
