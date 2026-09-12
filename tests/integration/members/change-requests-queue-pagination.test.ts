/**
 * F114 T119 — the queue budget at 5,000 rows on live Neon (plan § Technical
 * Context: "queue list p95 < 400 ms at 5,000 rows (indexed keyset)"; the 108
 * precedent for a stated budget is a SEEDED test, not a sentence).
 *
 * Seeds 200 members × 25 DECIDED requests (5,000 rows + one field row each)
 * in one tenant — the first 300 rows share ONE `submitted_at`, so the keyset's
 * `(submitted_at = cursor, id < cursor.id)` tie-break branch is exercised on
 * three page boundaries (review round 1, REL-7: 1-second spacing never reached
 * it) — then walks the QUEUE USE CASE (`listChangeRequestQueue`: the page's
 * `listQueue` + `pendingStats` in parallel, the two transactions a route pays,
 * REL-9) with keyset `cursor` / `limit = 100`:
 *   - 50 pages, 5,000 distinct ids, no gap and no duplicate;
 *   - a stable order: `(submitted_at DESC, id DESC)` across page boundaries;
 *   - the page latency's p95 is under `ciScaled(400)` ms (the plan's budget
 *     is a p95, measured around the repo call — the route adds JSON only;
 *     one warm-up page absorbs the connection + plan cost, and a single
 *     slow page out of fifty is below the percentile, not a regression);
 *   - `EXPLAIN` of the page query names the
 *     `member_change_requests_tenant_state_submitted_idx` index (the planner
 *     did not fall back to a seq scan + sort).
 *
 * `decided` rows are used because the partial unique index allows only one
 * PENDING row per submitter — 5,000 pending rows would need 5,000 users. The
 * two states share the same `(tenant_id, state, submitted_at DESC)` index.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asMemberId, drizzleChangeRequestRepo, listChangeRequestQueue } from '@/modules/members';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { ciScaled } from '../../helpers/ci-latency';

const MEMBERS = 200;
const PER_MEMBER = 25;
const TOTAL = MEMBERS * PER_MEMBER;
const PAGE = 100;
const TIE_ROWS = 300;
const BASE = new Date('2026-06-01T00:00:00Z');

let tenant: TestTenant;
let submitter: TestUser;
let reviewer: TestUser;
let memberIds: string[] = [];

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

describe('queue keyset pagination at 5,000 rows (T119, live Neon)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    submitter = await createActiveTestUser('member');
    reviewer = await createActiveTestUser('admin');
    const planId = `cr-page-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, submitter.userId, planId);
    memberIds = Array.from({ length: MEMBERS }, () => randomUUID());
    const contactIds = memberIds.map(() => randomUUID());
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(
        memberIds.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Page Co ${i}`,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active' as const,
        })),
      );
      await tx.insert(contacts).values(
        memberIds.map((memberId, i) => ({
          tenantId: tenant.ctx.slug,
          contactId: contactIds[i]!,
          memberId,
          firstName: 'Page',
          lastName: `Contact ${i}`,
          email: `page-${contactIds[i]!.slice(0, 8)}@example.com`,
          phone: '+66812345678',
          preferredLanguage: 'en' as const,
          isPrimary: true,
          linkedUserId: submitter.userId,
        })),
      );
      const requestRows = Array.from({ length: TOTAL }, (_, n) => {
        const m = n % MEMBERS;
        // the first TIE_ROWS rows share one timestamp (keyset tie-break coverage)
        const submittedAt = new Date(BASE.getTime() + Math.max(0, n - TIE_ROWS + 1) * 1000);
        return {
          id: randomUUID(),
          tenantId: tenant.ctx.slug,
          memberId: memberIds[m]!,
          submittedByUserId: submitter.userId,
          submittedByContactId: contactIds[m]!,
          submitterRoleAtSubmission: 'primary',
          scope: 'own_contact',
          state: 'decided',
          outcome: 'approved',
          submittedAt,
          staffNotifiedAt: submittedAt,
          decidedAt: new Date(submittedAt.getTime() + 3_600_000),
          decidedByUserId: reviewer.userId,
          createdAt: submittedAt,
          updatedAt: submittedAt,
        };
      });
      for (const chunk of chunks(requestRows, 500)) {
        await tx.insert(memberChangeRequests).values(chunk);
        await tx.insert(memberChangeRequestFields).values(
          chunk.map((r) => ({
            tenantId: tenant.ctx.slug,
            requestId: r.id,
            fieldKey: 'phone',
            target: 'contact',
            seenValue: '+66812345678',
            proposedValue: '+66899999999',
            outcome: 'approved',
            appliedAt: r.decidedAt,
            affectsTaxDocuments: false,
          })),
        );
      }
    });
  }, 300_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(submitter).catch(() => {});
    await deleteTestUser(reviewer).catch(() => {});
  }, 120_000);

  it('walks all 5,000 rows in 50 pages with no gap, no duplicate, a stable order, p95 page latency under budget', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let previous: { submittedAt: number; id: string } | null = null;
    const durations: number[] = [];
    const deps = { tenant: tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, clock: { now: () => new Date() } };
    // warm-up: the first statements pay the pooled connection + plan cost
    await listChangeRequestQueue(deps, { filter: { state: 'decided' }, cursor: null, limit: PAGE });
    let tieBoundaries = 0;
    for (;;) {
      const started = performance.now();
      const page = await listChangeRequestQueue(deps, { filter: { state: 'decided' }, cursor, limit: PAGE });
      durations.push(performance.now() - started);
      expect(page.ok, JSON.stringify(page)).toBe(true);
      if (!page.ok) return;
      pages += 1;
      const first = page.value.items[0]?.row.request;
      if (previous && first && first.submittedAt.getTime() === previous.submittedAt) tieBoundaries += 1;
      for (const item of page.value.items) {
        const r = item.row.request;
        expect(seen.has(r.id), `duplicate ${r.id}`).toBe(false);
        seen.add(r.id);
        if (previous) {
          const later = r.submittedAt.getTime() < previous.submittedAt || (r.submittedAt.getTime() === previous.submittedAt && r.id < previous.id);
          expect(later, `order broke at ${r.id}`).toBe(true);
        }
        previous = { submittedAt: r.submittedAt.getTime(), id: r.id };
      }
      cursor = page.value.nextCursor;
      if (cursor === null) break;
      expect(pages).toBeLessThanOrEqual(TOTAL / PAGE + 1);
    }
    expect(seen.size).toBe(TOTAL);
    expect(pages).toBe(TOTAL / PAGE);
    // the tie-break branch was crossed (300 equal rows / 100 per page → 2 boundaries inside the tie block)
    expect(tieBoundaries).toBeGreaterThanOrEqual(2);
    const sorted = [...durations].sort((x, y) => x - y);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const slowest = sorted[sorted.length - 1]!;
    expect(p95, `p95 page ${p95.toFixed(0)} ms, slowest ${slowest.toFixed(0)} ms (budget p95 < ${ciScaled(400)} ms)`).toBeLessThan(ciScaled(400));
  }, 300_000);

  it.each([
    ['newest first (decided / history)', 'DESC'],
    ['oldest first (the pending queue default — a backward index scan)', 'ASC'],
  ])('the page query uses the (tenant_id, state, submitted_at DESC) index — %s — never a seq scan + sort', async (_label, dir) => {
    const plan = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        EXPLAIN SELECT * FROM member_change_requests
        WHERE state = 'decided'
        ORDER BY submitted_at ${sql.raw(dir)}, id ${sql.raw(dir)}
        LIMIT ${PAGE + 1}
      `)) as unknown as Array<Record<string, string>>;
      return rows.map((r) => Object.values(r).join(' ')).join('\n');
    });
    expect(plan).toContain('member_change_requests_tenant_state_submitted_idx');
    expect(plan).not.toMatch(/Seq Scan on member_change_requests/);
  });

  it('the per-member history stays indexed too — one member, 25 rows newest first', async () => {
    const r = await drizzleChangeRequestRepo.listByMember(tenant.ctx, asMemberId(memberIds[0]!), { cursor: null, limit: 100 });
    expect(r.ok && r.value.items).toHaveLength(PER_MEMBER);
    expect(r.ok && r.value.items.every((i) => i.member.companyName === 'Page Co 0')).toBe(true);
  });
});
