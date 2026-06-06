/**
 * Pass A · Section 3 — contact marketing-subscription read (live Neon).
 *
 * The member-detail Contacts card surfaces a per-contact Subscribed /
 * Unsubscribed badge by batch-looking-up the contact emails against the F7
 * `marketing_unsubscribes` suppression list (`lookupBatch`). This test
 * exercises that exact read path end-to-end against real Postgres RLS:
 *   - An unsubscribed email is returned in the suppressed set; a clean email
 *     is NOT.
 *   - Case-insensitive: the page lower-cases before the lookup, matching the
 *     stored `email_lower`.
 *   - Cross-tenant isolation (Constitution Principle I): tenant B's repo sees
 *     NONE of tenant A's suppression rows.
 *
 * Uses the barrel-exposed `makeDrizzleMarketingUnsubscribesRepo` (the same
 * RLS-safe adapter the page calls). Simulated emails only — no real PII.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import {
  makeDrizzleMarketingUnsubscribesRepo,
  asEmailLower,
} from '@/modules/broadcasts';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

function emailLower(raw: string) {
  const parsed = asEmailLower(raw.toLowerCase());
  if (!parsed.ok) throw new Error(`bad test email: ${raw}`);
  return parsed.value;
}

describe('Pass A · Section 3 — contact subscription lookup (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const unsubscribedEmail = `sim-unsub-${randomUUID().slice(0, 8)}@example.test`;
  const subscribedEmail = `sim-sub-${randomUUID().slice(0, 8)}@example.test`;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed one suppression row in tenant A for the unsubscribed email.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values({
        tenantId: tenantA.ctx.slug,
        emailLower: unsubscribedEmail.toLowerCase(),
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(marketingUnsubscribes)
        .where(eq(marketingUnsubscribes.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('returns the unsubscribed email and excludes the subscribed one', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenantA.ctx.slug);
    const suppressed = await repo.lookupBatch(tenantA.ctx.slug, [
      emailLower(unsubscribedEmail),
      emailLower(subscribedEmail),
    ]);
    expect(suppressed.has(emailLower(unsubscribedEmail))).toBe(true);
    expect(suppressed.has(emailLower(subscribedEmail))).toBe(false);
  });

  it('matches case-insensitively (page lower-cases before lookup)', async () => {
    const repo = makeDrizzleMarketingUnsubscribesRepo(tenantA.ctx.slug);
    const suppressed = await repo.lookupBatch(tenantA.ctx.slug, [
      emailLower(unsubscribedEmail.toUpperCase()),
    ]);
    expect(suppressed.has(emailLower(unsubscribedEmail))).toBe(true);
  });

  it('tenant B sees none of tenant A suppression rows (Principle I)', async () => {
    const repoB = makeDrizzleMarketingUnsubscribesRepo(tenantB.ctx.slug);
    const suppressed = await repoB.lookupBatch(tenantB.ctx.slug, [
      emailLower(unsubscribedEmail),
    ]);
    expect(suppressed.size).toBe(0);
  });
});
