/**
 * F114 T022 — `DrizzleChangeRequestRepo` against live Neon (dev branch).
 *
 * The rules the use cases lean on live in the DATABASE, so they are proven
 * there, not in a mock:
 *   - insert + field rows round-trip through the Domain mapping (jsonb address
 *     groups included);
 *   - the partial unique index refuses a SECOND pending row for the same
 *     `(tenant_id, submitted_by_user_id)` → `repo.conflict`
 *     `change_request_pending_exists`;
 *   - the CHECKs refuse `state = 'decided'` without an outcome / decision
 *     columns (a repo bug cannot half-decide a row);
 *   - RLS FORCE — a `runInTenant` for tenant B sees ZERO rows of tenant A, in
 *     BOTH directions (Constitution I.3, the repo-level half of SC-009);
 *   - withdraw / decide / acknowledge / countSubmittedSince / pendingStats /
 *     the three list projections read back what was written.
 *
 * Seeds: two tenants, each with a plan + member + primary contact + a portal
 * user linked to it, so every FK (member, contact, user) is satisfied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, asContactId, type UserId } from '@/modules/members';
import type { ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { drizzleChangeRequestRepo } from '@/modules/members/infrastructure/db/drizzle-change-request-repo';
import { UseCaseAbort } from '@/modules/members/application/tx-abort';
import type { ChangeRequestDraft } from '@/modules/members/application/ports/change-request-repo';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/** The F1 `TestUser.userId` carries the AUTH brand; the members module brands the same uuid its own way. */
const mu = (id: string): UserId => id as unknown as UserId;

interface Seeded {
  tenant: TestTenant;
  user: TestUser;
  memberId: string;
  contactId: string;
}

async function seedTenant(prefix: 'test-swecham' | 'test-chamber'): Promise<Seeded> {
  const tenant = await createTestTenant(prefix);
  const user = await createActiveTestUser('member');
  const planId = `cr-plan-${randomUUID().slice(0, 8)}`;
  await seedPortalPlan(tenant.ctx.slug, user.userId, planId);
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `CR Co ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Anna',
      lastName: 'Svensson',
      email: `cr-${contactId.slice(0, 8)}@example.com`,
      phone: '+66812345678',
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: user.userId,
    });
  });
  return { tenant, user, memberId, contactId };
}

function draft(s: Seeded, overrides: Partial<ChangeRequestDraft> = {}): ChangeRequestDraft {
  return {
    id: randomUUID() as ChangeRequestId,
    tenantId: s.tenant.ctx.slug as ChangeRequestDraft['tenantId'],
    memberId: asMemberId(s.memberId),
    submittedByUserId: mu(s.user.userId),
    submittedByContactId: asContactId(s.contactId),
    submitterRoleAtSubmission: 'primary',
    scope: 'mixed',
    submittedAt: new Date('2026-09-11T08:00:00Z'),
    staffNotifiedAt: new Date('2026-09-11T08:00:00Z'),
    fields: [
      { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false },
      {
        key: 'billing_address',
        target: 'member',
        seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
        proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
        affectsTaxDocuments: true,
      },
    ],
    ...overrides,
  };
}

describe('DrizzleChangeRequestRepo (live Neon)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    a = await seedTenant('test-swecham');
    b = await seedTenant('test-chamber');
  });

  afterAll(async () => {
    await a.tenant.cleanup().catch(() => {});
    await b.tenant.cleanup().catch(() => {});
    await deleteTestUser(a.user).catch(() => {});
    await deleteTestUser(b.user).catch(() => {});
  });

  it('insertInTx round-trips the request + its field rows (jsonb address group intact)', async () => {
    const d = draft(a);
    const inserted = await runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.insertInTx(tx, d));
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.value.state).toBe('pending');
    expect(inserted.value.scope).toBe('mixed');
    expect(inserted.value.fields.map((f) => f.key)).toEqual(['phone', 'billing_address']);
    expect(inserted.value.fields[1]?.proposed).toEqual(d.fields[1]!.proposed);
    expect(inserted.value.fields[1]?.affectsTaxDocuments).toBe(true);
    expect(inserted.value.fields[0]?.outcome).toBeNull();

    const read = await drizzleChangeRequestRepo.findById(a.tenant.ctx, d.id);
    expect(read.ok && read.value.id).toBe(d.id);
    expect(read.ok && read.value.fields).toEqual(inserted.value.fields);
  });

  it('the partial unique index refuses a second pending row for the same submitter', async () => {
    // A failed statement leaves the Postgres tx ABORTED, so the caller must
    // roll back by throwing (the `UseCaseAbort` contract every members use
    // case follows) — returning the `err` and letting the tx COMMIT is not an
    // option. Mirror that here.
    const second = await runInTenant(a.tenant.ctx, async (tx) => {
      const r = await drizzleChangeRequestRepo.insertInTx(tx, draft(a));
      if (!r.ok) throw new UseCaseAbort(r.error);
      return r;
    }).catch((e: unknown) => (e instanceof UseCaseAbort ? { ok: false as const, error: e.error } : Promise.reject(e)));
    expect(second).toEqual({
      ok: false,
      error: { code: 'repo.conflict', reason: 'change_request_pending_exists' },
    });
  });

  it('findPendingBySubmitterInTx returns the pending row for the submitter and null for a stranger', async () => {
    const mine = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)),
    );
    expect(mine.ok && mine.value?.submittedByUserId).toBe(a.user.userId);
    const none = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(b.user.userId)),
    );
    expect(none).toEqual({ ok: true, value: null });
  });

  it('RLS FORCE: tenant B sees zero rows of tenant A, and vice versa (Constitution I.3)', async () => {
    const aPending = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)),
    );
    expect(aPending.ok && aPending.value).not.toBeNull();
    const id = aPending.ok && aPending.value ? aPending.value.id : ('' as ChangeRequestId);

    // B → A: by id, by submitter, by stats, by list
    expect(await drizzleChangeRequestRepo.findById(b.tenant.ctx, id)).toEqual({ ok: false, error: { code: 'repo.not_found' } });
    const crossPending = await runInTenant(b.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)),
    );
    expect(crossPending).toEqual({ ok: true, value: null });
    const bStats = await drizzleChangeRequestRepo.pendingStats(b.tenant.ctx);
    expect(bStats).toEqual({ ok: true, value: { count: 0, oldestSubmittedAt: null } });
    const bQueue = await drizzleChangeRequestRepo.listQueue(b.tenant.ctx, {}, { cursor: null, limit: 10 });
    expect(bQueue.ok && bQueue.value.items).toEqual([]);

    // A → B: insert in B, then A cannot see it
    const bDraft = draft(b);
    const bIns = await runInTenant(b.tenant.ctx, (tx) => drizzleChangeRequestRepo.insertInTx(tx, bDraft));
    expect(bIns.ok).toBe(true);
    expect(await drizzleChangeRequestRepo.findById(a.tenant.ctx, bDraft.id)).toEqual({ ok: false, error: { code: 'repo.not_found' } });
    const aQueue = await drizzleChangeRequestRepo.listQueue(a.tenant.ctx, {}, { cursor: null, limit: 10 });
    expect(aQueue.ok && aQueue.value.items.map((r) => r.request.id)).toEqual([id]);

    // A cross-tenant WRITE by id is a no-row UPDATE → not_found, B's row untouched
    const crossDecide = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.withdrawInTx(tx, bDraft.id, { reason: 'member', withdrawnAt: new Date() }),
    );
    expect(crossDecide).toEqual({ ok: false, error: { code: 'repo.not_found' } });
    const bStill = await drizzleChangeRequestRepo.findById(b.tenant.ctx, bDraft.id);
    expect(bStill.ok && bStill.value.state).toBe('pending');
  });

  it('pendingStats + countSubmittedSince read the durable rows', async () => {
    const stats = await drizzleChangeRequestRepo.pendingStats(a.tenant.ctx);
    expect(stats.ok && stats.value.count).toBe(1);
    expect(stats.ok && stats.value.oldestSubmittedAt?.toISOString()).toBe('2026-09-11T08:00:00.000Z');
    const window = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.countSubmittedSince(tx, mu(a.user.userId), new Date('2026-09-10T08:00:00Z')),
    );
    expect(window.ok && window.value).toEqual({ count: 1, oldestSubmittedAt: new Date('2026-09-11T08:00:00Z') });
    const outside = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.countSubmittedSince(tx, mu(a.user.userId), new Date('2026-09-11T09:00:00Z')),
    );
    expect(outside.ok && outside.value).toEqual({ count: 0, oldestSubmittedAt: null });
  });

  it('decideInTx writes per-field outcomes + decision columns atomically; a decided row refuses a second decide', async () => {
    const pending = await runInTenant(a.tenant.ctx, (tx) =>
      drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)),
    );
    const id = pending.ok && pending.value ? pending.value.id : ('' as ChangeRequestId);
    const decidedAt = new Date('2026-09-11T09:30:00Z');
    const reviewer = await createActiveTestUser('admin');
    try {
      const decided = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.decideInTx(tx, id, {
          decidedAt,
          decidedByUserId: mu(reviewer.userId),
          outcome: 'partially_approved',
          reason: 'Use the registered billing address',
          note: null,
          fields: [
            { key: 'phone', outcome: 'approved', appliedAt: decidedAt },
            { key: 'billing_address', outcome: 'rejected', appliedAt: null },
          ],
        }),
      );
      expect(decided.ok).toBe(true);
      if (!decided.ok) return;
      expect(decided.value.state).toBe('decided');
      expect(decided.value.outcome).toBe('partially_approved');
      expect(decided.value.decidedByUserId).toBe(reviewer.userId);
      expect(decided.value.fields.map((f) => [f.key, f.outcome, f.appliedAt?.toISOString() ?? null])).toEqual([
        ['phone', 'approved', decidedAt.toISOString()],
        ['billing_address', 'rejected', null],
      ]);

      const again = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.decideInTx(tx, id, {
          decidedAt,
          decidedByUserId: mu(reviewer.userId),
          outcome: 'approved',
          reason: null,
          note: null,
          fields: [
            { key: 'phone', outcome: 'approved', appliedAt: decidedAt },
            { key: 'billing_address', outcome: 'approved', appliedAt: decidedAt },
          ],
        }),
      );
      expect(again).toEqual({ ok: false, error: { code: 'repo.not_found' } });

      const acked = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.acknowledgeInTx(tx, id, new Date('2026-09-11T10:00:00Z')),
      );
      expect(acked.ok && acked.value.outcomeAcknowledgedAt?.toISOString()).toBe('2026-09-11T10:00:00.000Z');
      const ackedAgain = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.acknowledgeInTx(tx, id, new Date('2026-09-12T10:00:00Z')),
      );
      expect(ackedAgain.ok && ackedAgain.value.outcomeAcknowledgedAt?.toISOString()).toBe('2026-09-11T10:00:00.000Z');
    } finally {
      // The decided row references the reviewer (RESTRICT) — cleanup deletes
      // the tenant's rows in afterAll; the reviewer row is deleted after that.
      // Keep a handle so afterAll can remove it in order.
      reviewers.push(reviewer);
    }
  });

  it('the DB CHECKs refuse a half-decided row (state decided without outcome / decision columns)', async () => {
    const id = randomUUID();
    // Drizzle wraps the driver error ("Failed query: …"); the constraint name
    // lives on the PostgresError cause.
    const thrown = await runInTenant(a.tenant.ctx, (tx) =>
      tx.execute(sql`
        INSERT INTO member_change_requests
          (id, tenant_id, member_id, submitted_by_user_id, submitted_by_contact_id,
           submitter_role_at_submission, scope, state)
        VALUES (${id}, ${a.tenant.ctx.slug}, ${a.memberId}, ${a.user.userId}, ${a.contactId},
                'primary', 'company', 'decided')
      `),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).not.toBeNull();
    const cause = (thrown as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toMatch(/member_change_requests_(outcome|decision)_iff_decided_ck/);
  });

  it('keyset paging with EQUAL submitted_at: the id tiebreak (round 1 #22) yields no duplicate and no gap (round 6 tests Q-5)', async () => {
    const at = new Date('2026-09-11T12:00:00Z');
    const older = draft(a, { submittedAt: at });
    const newer = draft(a, { submittedAt: at });
    // two rows at the SAME instant: the first is replaced by the second (one pending per submitter)
    const seeded = await runInTenant(a.tenant.ctx, async (tx) => {
      const i1 = await drizzleChangeRequestRepo.insertInTx(tx, older);
      if (!i1.ok) return i1;
      const w = await drizzleChangeRequestRepo.withdrawInTx(tx, older.id, { reason: 'replaced', withdrawnAt: at, replacedByRequestId: newer.id });
      if (!w.ok) return w;
      return drizzleChangeRequestRepo.insertInTx(tx, newer);
    });
    expect(seeded.ok).toBe(true);
    try {
      const all = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), { cursor: null, limit: 50 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const ids = all.value.items.map((r) => r.request.id);
      const seen: string[] = [];
      let cursor: typeof all.value.nextCursor = null;
      for (let i = 0; i < 20; i += 1) {
        const page = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), { cursor, limit: 1 });
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        seen.push(...page.value.items.map((r) => r.request.id));
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(ids); // same order, every row once
      expect(new Set(seen).size).toBe(ids.length);
      // clean up the two rows so the sibling cases keep their counts
    } finally {
      // owner-role delete (chamber_app has no DELETE grant; the app never hard-deletes)
      await db.delete(memberChangeRequests).where(inArray(memberChangeRequests.id, [older.id, newer.id]));
    }
  });

  it('withdrawInTx: pending → withdrawn/replaced with the pointer; list projections carry member + submitter facts', async () => {
    const first = draft(a, { submittedAt: new Date('2026-09-11T11:00:00Z') });
    const second = draft(a, { submittedAt: new Date('2026-09-11T11:05:00Z') });
    const ins1 = await runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.insertInTx(tx, first));
    expect(ins1.ok).toBe(true);
    const withdrawn = await runInTenant(a.tenant.ctx, async (tx) => {
      const w = await drizzleChangeRequestRepo.withdrawInTx(tx, first.id, {
        reason: 'replaced',
        withdrawnAt: new Date('2026-09-11T11:05:00Z'),
        replacedByRequestId: second.id,
      });
      if (!w.ok) return w;
      const ins2 = await drizzleChangeRequestRepo.insertInTx(tx, second);
      return ins2.ok ? w : ins2;
    });
    expect(withdrawn.ok && withdrawn.value.state).toBe('withdrawn');
    expect(withdrawn.ok && withdrawn.value.withdrawnReason).toBe('replaced');
    expect(withdrawn.ok && withdrawn.value.replacedByRequestId).toBe(second.id);

    const byMember = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), { cursor: null, limit: 10 });
    expect(byMember.ok).toBe(true);
    if (!byMember.ok) return;
    // newest first: second (11:05), first (11:00), the decided one (08:00)
    expect(byMember.value.items.map((r) => r.request.id)).toEqual([second.id, first.id, byMember.value.items[2]!.request.id]);
    expect(byMember.value.items[0]?.member.companyName).toMatch(/^CR Co /);
    expect(byMember.value.items[0]?.submitter.displayName.length).toBeGreaterThan(0);
    expect(byMember.value.items[2]?.decidedBy).toMatchObject({ deactivated: false });

    // keyset paging: limit 2 → cursor → the remaining one, no duplicate, no gap
    const page1 = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), { cursor: null, limit: 2 });
    expect(page1.ok && page1.value.items.length).toBe(2);
    expect(page1.ok && page1.value.nextCursor).not.toBeNull();
    const page2 = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), {
      cursor: page1.ok ? page1.value.nextCursor : null,
      limit: 2,
    });
    expect(page2.ok && page2.value.items.map((r) => r.request.id)).toEqual([byMember.value.items[2]!.request.id]);
    expect(page2.ok && page2.value.nextCursor).toBeNull();

    // FR-029 scope: a stranger user of the same member sees only company/mixed-scope rows
    const strangerView = await drizzleChangeRequestRepo.listVisibleToUser(
      a.tenant.ctx,
      mu(b.user.userId),
      asMemberId(a.memberId),
      { cursor: null, limit: 10 },
    );
    expect(strangerView.ok && strangerView.value.items.every((r) => r.request.scope !== 'own_contact')).toBe(true);
    // queue default = pending oldest-first
    const queue = await drizzleChangeRequestRepo.listQueue(a.tenant.ctx, {}, { cursor: null, limit: 10 });
    expect(queue.ok && queue.value.items.map((r) => r.request.id)).toEqual([second.id]);
    const filtered = await drizzleChangeRequestRepo.listQueue(a.tenant.ctx, { state: 'decided', outcome: 'partially_approved' }, { cursor: null, limit: 10 });
    expect(filtered.ok && filtered.value.items.length).toBe(1);
  });

  it('PR-1 review (migration I-1) — the composite child FK refuses a field row of tenant B that points at a request of tenant A (RI bypasses RLS; the FK must not)', async () => {
    // any request of tenant A will do (the submitter already holds a pending row from the cases above)
    const rows = await runInTenant(a.tenant.ctx, (tx) => tx.select({ id: memberChangeRequests.id }).from(memberChangeRequests).limit(1));
    const target = rows[0];
    expect(target).toBeDefined();
    if (!target) return;
    const own = { value: { id: target.id } };
    let code: string | undefined;
    try {
      await runInTenant(b.tenant.ctx, (tx) =>
        tx.insert(memberChangeRequestFields).values({
          tenantId: b.tenant.ctx.slug,
          requestId: own.value.id,
          // a key the seeded drafts never carry, so the (request_id, field_key)
          // uniqueness cannot fire before the FK check
          fieldKey: 'website',
          target: 'member',
          seenValue: null,
          proposedValue: 'https://probe.example',
          affectsTaxDocuments: false,
        }),
      );
    } catch (e) {
      code = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
    }
    expect(code).toBe('23503');
  });
});

const reviewers: TestUser[] = [];
afterAll(async () => {
  for (const r of reviewers) await deleteTestUser(r).catch(() => {});
});
