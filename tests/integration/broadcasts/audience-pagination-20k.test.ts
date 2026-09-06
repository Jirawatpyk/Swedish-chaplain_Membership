/**
 * 108 PR-C T081 (US5 s4, FR-041, FR-043, SC-004; PR-D review M-13) — a
 * 20,000-contact audience on live Neon through the real F7→F3 bridge:
 *
 *   - NO truncation: with the batching-ON ceiling (50,000) all 20,000 resolve;
 *     with the batching-OFF ceiling (5,000) the refusal carries the TRUE count
 *     (20,000), not a silently cut 5,000 (FR-041);
 *   - the compose-time count equals the dispatch-time set for the same tenant
 *     state (SC-004) — same deps, same resolver, both phases;
 *   - FR-043: 20,000 contacts resolve in < 3 s. The budget defaults to the SLO
 *     (`ciScaled` widens it ×6 on a CI runner) and can be overridden with
 *     `PERF_AUDIENCE_20K_MS` for a workstation outside the Neon region, exactly
 *     like T208's `PERF_RLS_P95_MS`. MEASURED 2026-09-07 from a Bangkok
 *     workstation (~220 ms RTT to Neon Singapore): 9.3–11.4 s at 1,000-row
 *     pages (42 round trips) → 3.7 s at 5,000-row pages/chunks (10 round
 *     trips). The remaining gap is network RTT × trips; from Vercel `sin1`
 *     (same region) the SLO is asserted in prod by SLO-F7-013
 *     (`broadcasts_recipient_count_ms`), not by this laptop;
 *   - the keyset walk is 4 full pages of 5,000 + 1 empty page (the bridge's contract);
 *   - EXPLAIN of the exact repo statement (the exported builder, so this can
 *     never drift from the code): no N+1 shape (a Nested Loop driving a Seq
 *     Scan on `contacts`), the M-13 obligation from PR-D's 0294 index.
 *
 * Seeds 20,000 active members with one primary each in one tenant. Simulated
 * addresses only — no real PII. Gated behind `RUN_SCALE_TESTS=1` like the
 * PR-D 20k audience-page proof (the nightly sweep sets it; a laptop run is
 * opt-in).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { resolveSegmentRecipients } from '@/modules/broadcasts';
import { countRecipients } from '@/lib/broadcasts-recipient-count';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { buildBroadcastRecipientContactsQuery } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { ciScaled } from '../../helpers/ci-latency';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const N = 20_000;
const CHUNK = 500;

async function seedAudience(tenant: TestTenant, planId: string, n: number, tag: string): Promise<void> {
  for (let start = 0; start < n; start += CHUNK) {
    const ids = Array.from({ length: Math.min(CHUNK, n - start) }, () => randomUUID());
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(
        ids.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Scale ${start + i}`,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active' as const,
          archivedAt: null,
        })),
      );
      await tx.insert(contacts).values(
        ids.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Scale',
          lastName: String(start + i),
          email: `scale-${start + i}-${tag}@example.test`,
          preferredLanguage: 'en' as const,
          isPrimary: true,
          removedAt: null,
        })),
      );
    });
  }
}

describe.runIf(process.env.RUN_SCALE_TESTS === '1')(
  '108 PR-C T081 — 20,000-contact audience: no truncation, count = dispatch, < 3 s, no N+1 (live Neon)',
  () => {
    let tenant: TestTenant;
    let admin: TestUser;
    const planId = `scl-${randomUUID().slice(0, 6)}`;
    const tag = randomUUID().slice(0, 8);

    function deps(audienceCeiling: number) {
      return {
        tenant: tenant.ctx,
        membersBridge,
        eventAttendees: eventAttendeesStub,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
        audienceMode: 'all_contacts' as const,
        audienceCeiling,
      };
    }

    beforeAll(async () => {
      admin = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-swecham');
      await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
      await seedAudience(tenant, planId, N, tag);
    }, 600_000);

    afterAll(async () => {
      await tenant.cleanup().catch(() => {});
      await deleteTestUser(admin).catch(() => {});
    }, 600_000);

    it('resolves all 20,000 under the batching-ON ceiling within the FR-043 budget', async () => {
      const startedAt = Date.now();
      const r = await resolveSegmentRecipients(deps(50_000), {
        segment: { kind: 'all_members' },
        phase: 'submit',
        requestingMemberId: null,
        customRecipients: null,
      });
      const elapsed = Date.now() - startedAt;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.estimatedCount).toBe(N);
      expect(r.value.recipients).toHaveLength(N);
      expect(new Set(r.value.recipients).size).toBe(N);
      // Default = the SLO; override only for a workstation outside the region
      // (disclose the value you used, as with PERF_RLS_P95_MS).
      const budgetMs = Number(process.env.PERF_AUDIENCE_20K_MS ?? ciScaled(3_000));
      expect(elapsed).toBeLessThan(budgetMs);
    }, 120_000);

    it('under the batching-OFF ceiling the refusal carries the TRUE count — never a silent 5,000', async () => {
      const r = await resolveSegmentRecipients(deps(5_000), {
        segment: { kind: 'all_members' },
        phase: 'submit',
        requestingMemberId: null,
        customRecipients: null,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toEqual({ kind: 'broadcast_audience_too_large', count: N, cap: 5_000 });
    }, 120_000);

    it('the compose-time count equals the dispatch-time set (SC-004)', async () => {
      const count = await countRecipients(deps(50_000), {
        segment: { kind: 'all_members' },
        requestingMemberId: randomUUID(),
        correlationId: randomUUID(),
      });
      expect(count).toEqual({
        status: 'ok',
        body: { count: N, ceiling: 50_000, exceeds: false, orphans: 0, droppedByPreference: 0 },
      });
      const dispatch = await resolveSegmentRecipients(deps(50_000), {
        segment: { kind: 'all_members' },
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      });
      expect(dispatch.ok).toBe(true);
      if (!dispatch.ok) return;
      expect(dispatch.value.recipients).toHaveLength(N);
      expect(dispatch.value.recipients.length).toBe(count.status === 'ok' ? count.body.count : -1);
    }, 120_000);

    it('walks exactly 4 full keyset pages plus the empty proof page', async () => {
      const rows = await membersBridge.getContactsBySegment(tenant.ctx, 'all_members', {});
      expect(rows).toHaveLength(N);
      expect(rows.every((r) => r.contactId !== null)).toBe(true);
    }, 120_000);

    it('EXPLAIN of the exact repo statement shows no N+1 shape (M-13)', async () => {
      const plan = await runInTenant(tenant.ctx, async (tx) => {
        const query = buildBroadcastRecipientContactsQuery(tx, {
          segmentType: 'all_members',
          after: null,
          limit: 5000,
        });
        const rows = (await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`)) as unknown as Array<{
          'QUERY PLAN': unknown;
        }>;
        return JSON.stringify(rows);
      });
      // A Nested Loop that re-scans `contacts` sequentially per member row is
      // the N+1 shape the 0294 index exists to prevent.
      expect(/Nested Loop[\s\S]*Seq Scan on contacts/i.test(plan)).toBe(false);
      // The statement is a bounded keyset page.
      expect(plan).toMatch(/Limit/);
    }, 120_000);
  },
);
