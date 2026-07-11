/**
 * Bug #4 (2026-07-10) — quota reservation TOCTOU. Two concurrent submits at
 * `remaining = 1` previously both passed the pre-tx quota snapshot and
 * over-subscribed (used+reserved = cap+1), which then tripped the
 * `over_subscription` invariant and 500'd the quota endpoint + every further
 * submit (a member self-lockout).
 *
 * The fix serialises the check-then-reserve per (tenant, member, quota-year)
 * via `pg_advisory_xact_lock` inside the submit tx. This test drives that
 * primitive directly with two genuinely-concurrent transactions and asserts
 * exactly ONE reserves — the loser blocks on the advisory lock until the
 * winner commits, then re-reads the fresh count and is quota-blocked.
 *
 * Live DB only — advisory-lock serialisation cannot be exercised with mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asMemberId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const CAP = 1;
const QUOTA_YEAR = 2026;

describe('submit quota TOCTOU — bug #4 (advisory lock prevents over-subscription)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('two concurrent check-then-reserve attempts reserve exactly CAP (never cap+1)', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const memberIdStr = randomUUID();
    const member = asMemberId(memberIdStr);

    // One concurrent "submit": acquire the per-member quota advisory lock,
    // re-count under it, and reserve a slot (draft → submitted) ONLY if the
    // member is still under cap. Mirrors the fixed submit-broadcast tx body.
    const attempt = (): Promise<'inserted' | 'blocked'> =>
      repo.withTx(async (tx) => {
        const counts = await repo.recheckMemberQuotaUnderLock!(
          tx,
          tenant.ctx.slug,
          member,
          QUOTA_YEAR,
        );
        if (counts.submittedOrApproved + counts.sent >= CAP) {
          return 'blocked';
        }
        const bid = asBroadcastId(randomUUID());
        await repo.insertDraft(tx, {
          tenantId: tenant.ctx.slug,
          broadcastId: bid,
          requestedByMemberId: memberIdStr,
          requestedByMemberPlanIdSnapshot: 'plan-x',
          submittedByUserId: randomUUID(),
          actorRole: 'member_self_service',
          subject: 'TOCTOU test',
          bodyHtml: '<p>b</p>',
          bodySource: 'b',
          fromName: 'X via Test Chamber',
          replyToEmail: 'r@example.com',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          estimatedRecipientCount: 1,
          scheduledFor: null,
        });
        await repo.applyTransition(
          tx,
          tenant.ctx.slug,
          bid,
          'submitted',
          { submittedAt: new Date(), estimatedRecipientCount: 1 },
          'draft',
        );
        return 'inserted';
      });

    const results = await Promise.all([attempt(), attempt()]);

    // Exactly one reserved; the other was serialised behind the lock and
    // re-read the fresh (now at-cap) count → blocked.
    expect(results.filter((r) => r === 'inserted')).toHaveLength(1);
    expect(results.filter((r) => r === 'blocked')).toHaveLength(1);

    // DB truth: exactly CAP reserved slots — never over-subscribed.
    const finalCounts = await repo.withTx((tx) =>
      repo.recheckMemberQuotaUnderLock!(
        tx,
        tenant.ctx.slug,
        member,
        QUOTA_YEAR,
      ),
    );
    expect(finalCounts.submittedOrApproved).toBe(CAP);
    expect(finalCounts.sent).toBe(0);
  });
});
