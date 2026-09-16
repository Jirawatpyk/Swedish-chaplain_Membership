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
 *     columns (a repo bug cannot half-decide a row), and `decideInTx` refuses
 *     a decision that names a key twice or names a key with no field row —
 *     both roll the tx back and leave the request pending;
 *   - RLS FORCE — a `runInTenant` for tenant B sees ZERO rows of tenant A, in
 *     BOTH directions (Constitution I.3, the repo-level half of SC-009);
 *   - withdraw / decide / acknowledge / countSubmittedSince / pendingStats /
 *     the three list projections read back what was written — including
 *     FR-029: `listVisibleToUser` EXCLUDES a colleague's `own_contact` row
 *     while still returning the member's company-level ones.
 *
 * Seeds: two tenants, each with a plan + member + primary contact + a portal
 * user linked to it, so every FK (member, contact, user) is satisfied.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asMemberId, asContactId, type UserId } from '@/modules/members';
import type { ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { PROPOSABLE_FIELD_KEYS } from '@/modules/members/domain/change-request/proposable-fields';
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

  // PR-3 review round 2 (B5) — the `state = 'pending'` predicate, MEASURED.
  // The assertion below used to run against a tenant that held nothing but
  // pending rows, so it held whether or not the SQL filtered at all: dropping
  // the WHERE clause changed no number. Two NON-pending rows are seeded first,
  // both submitted EARLIER than the pending one, so an unfiltered scan would
  // move the count (1 → 3) AND the oldest timestamp. They are submitted by
  // tenant B's user under tenant A: the partial unique index is per
  // (tenant, submitter), so this is the only way to hold a second request in
  // this tenant, and each is taken out of `pending` before the next is added.
  it('pendingStats + countSubmittedSince read the durable rows — and pendingStats counts ONLY pending ones', async () => {
    const OLDER = new Date('2026-09-01T08:00:00Z');
    const withdrawnDraft = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: OLDER, staffNotifiedAt: OLDER });
    await runInTenant(a.tenant.ctx, async (tx) => {
      const ins = await drizzleChangeRequestRepo.insertInTx(tx, withdrawnDraft);
      if (!ins.ok) throw new UseCaseAbort(ins.error);
      const w = await drizzleChangeRequestRepo.withdrawInTx(tx, withdrawnDraft.id, { reason: 'member', withdrawnAt: new Date('2026-09-02T08:00:00Z') });
      if (!w.ok) throw new UseCaseAbort(w.error);
    });
    const decidedDraft = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: OLDER, staffNotifiedAt: OLDER });
    const reviewer = await createActiveTestUser('admin');
    try {
      await runInTenant(a.tenant.ctx, async (tx) => {
        const ins = await drizzleChangeRequestRepo.insertInTx(tx, decidedDraft);
        if (!ins.ok) throw new UseCaseAbort(ins.error);
        const d = await drizzleChangeRequestRepo.decideInTx(tx, decidedDraft.id, {
          decidedAt: new Date('2026-09-02T09:00:00Z'),
          decidedByUserId: mu(reviewer.userId),
          outcome: 'rejected',
          reason: 'seeded for the pendingStats predicate',
          note: null,
          fields: decidedDraft.fields.map((f) => ({ key: f.key, outcome: 'rejected' as const, appliedAt: null })),
        });
        if (!d.ok) throw new UseCaseAbort(d.error);
      });

      const stats = await drizzleChangeRequestRepo.pendingStats(a.tenant.ctx);
      // 3 rows in the tenant, 1 pending: an unfiltered COUNT reads 3
      expect(stats.ok && stats.value.count).toBe(1);
      // and an unfiltered MIN reads 2026-09-01, not the pending row's date
      expect(stats.ok && stats.value.oldestSubmittedAt?.toISOString()).toBe('2026-09-11T08:00:00.000Z');
      const window = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.countSubmittedSince(tx, mu(a.user.userId), new Date('2026-09-10T08:00:00Z')),
      );
      expect(window.ok && window.value).toEqual({ count: 1, oldestSubmittedAt: new Date('2026-09-11T08:00:00Z') });
      const outside = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.countSubmittedSince(tx, mu(a.user.userId), new Date('2026-09-11T09:00:00Z')),
      );
      expect(outside.ok && outside.value).toEqual({ count: 0, oldestSubmittedAt: null });
    } finally {
      // The two seeded rows hang off tenant A's member, so the later
      // `listByMember` / history assertions in this file would see them. They
      // exist for the two `pendingStats` assertions above and nothing else —
      // remove them here rather than teaching four other tests about them.
      // Bare `db` (owner, BYPASSRLS): the tenant tx is already closed.
      const seededIds = [withdrawnDraft.id, decidedDraft.id];
      await db.delete(memberChangeRequestFields).where(inArray(memberChangeRequestFields.requestId, seededIds));
      await db.delete(memberChangeRequests).where(inArray(memberChangeRequests.id, seededIds));
      await deleteTestUser(reviewer).catch(() => {});
    }
  });

  it.each([
    ['decided_by_user_id', 'member_change_requests_decided_by_tenant_idx'],
    ['submitted_by_user_id', 'member_change_requests_submitted_by_user_idx'],
  ])('migration 0302: the RI check on the single-column users FK (%s) is an index probe, never a seq scan — a positive control the name-counting canary cannot give (migration re-review, M1 / M2)', async (column, indexName) => {
    // Postgres runs an RI check with row security OFF and NO tenant qual — it
    // is a bare `WHERE $1 = <fk column>` issued by the parent row's delete
    // trigger. So it is modelled on the OWNER connection, OUTSIDE
    // `runInTenant`: inside one, RLS appends `tenant_id =
    // current_setting('app.current_tenant')` and a TENANT-FIRST index (the
    // pre-0302 shape this test exists to refuse) serves that PAIR as a single
    // `Index Cond`, so the demotion would be invisible — measured. Dropping
    // to `SET LOCAL row_security = off` inside `runInTenant` is not an
    // option: `chamber_app` is NOBYPASSRLS, so the query errors outright
    // (also measured). `SET LOCAL` keeps the planner knob inside this tx.
    const plan = await db.transaction(async (tx) => {
      // a tiny table would seq-scan on cost alone; force the planner to show whether an index CAN serve the lookup
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await tx.execute(sql`EXPLAIN SELECT 1 FROM member_change_requests WHERE ${sql.raw(column)} = ${randomUUID()}`)) as unknown as Array<Record<string, string>>;
      return rows.map((r) => Object.values(r).join(' ')).join('\n');
    });
    expect(plan, plan).toContain(indexName);
    expect(plan, plan).not.toMatch(/Seq Scan on member_change_requests/);
    // the FK column must be the index CONDITION, not a Filter under an index
    // scan — EXPLAIN prints the index name in BOTH shapes, and demoted-to-
    // Filter is exactly the pre-fix (tenant-first) behaviour guarded here
    expect(plan, plan).toMatch(new RegExp(`Index Cond: \\(${column} = `));
    expect(plan, plan).not.toMatch(new RegExp(`Filter: \\(${column} = `));
  });

  it('findPendingBySubmitter (PR-1 review, Rel M-5) is a PLAIN read: it returns while another tx holds the row FOR UPDATE — the locking finder blocks behind the same holder (positive control)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = runInTenant(a.tenant.ctx, async (tx) => {
      const locked = await drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId));
      expect(locked.ok && locked.value?.submittedByUserId).toBe(a.user.userId);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 300));
    const blocked = (ms: number) => new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), ms));
    try {
      // the read the profile page + the gate route make: never waits on a decide / submit holding the row
      const plain = await Promise.race([drizzleChangeRequestRepo.findPendingBySubmitter(a.tenant.ctx, mu(a.user.userId)), blocked(5_000)]);
      expect(plain).not.toBe('blocked');
      expect(plain !== 'blocked' && plain.ok && plain.value?.submittedByUserId).toBe(a.user.userId);
      // positive control: the FOR UPDATE finder DOES queue behind the holder
      const locking = runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)));
      expect(await Promise.race([locking, blocked(1_500)])).toBe('blocked');
      release();
      await holder;
      const after = await locking;
      expect(after.ok && after.value?.submittedByUserId).toBe(a.user.userId);
    } finally {
      release();
      await holder.catch(() => {});
    }
    const stranger = await drizzleChangeRequestRepo.findPendingBySubmitter(a.tenant.ctx, mu(b.user.userId));
    expect(stranger).toEqual({ ok: true, value: null });
  }, 60_000);

  it('decideInTx (PR-1 review, Mig M-5 — ONE statement for every field row): a decision naming a key with NO row rolls the tx back and the request stays pending', async () => {
    const pending = await runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(a.user.userId)));
    const id = pending.ok && pending.value ? pending.value.id : ('' as ChangeRequestId);
    const keys = pending.ok && pending.value ? pending.value.fields.map((f) => f.key) : [];
    // a key the fixture does NOT propose — chosen, not hardcoded, so a fixture
    // change cannot turn this into the duplicate-key path (migration re-review, L2)
    const absentKey = PROPOSABLE_FIELD_KEYS.find((k) => !keys.includes(k));
    if (!absentKey) throw new Error('fixture proposes every key');
    const reviewer = await createActiveTestUser('admin');
    try {
      await expect(
        runInTenant(a.tenant.ctx, async (tx) => {
          const r = await drizzleChangeRequestRepo.decideInTx(tx, id, {
            decidedAt: new Date('2026-09-11T09:31:00Z'),
            decidedByUserId: mu(reviewer.userId),
            outcome: 'rejected',
            reason: 'one key too many',
            note: null,
            fields: [...keys.map((key) => ({ key, outcome: 'rejected' as const, appliedAt: null })), { key: absentKey, outcome: 'rejected' as const, appliedAt: null }],
          });
          if (!r.ok) throw new UseCaseAbort(r.error);
          return r;
        }),
      ).rejects.toBeInstanceOf(UseCaseAbort);
      const [row] = await db.select().from(memberChangeRequests).where(inArray(memberChangeRequests.id, [id]));
      expect(row?.state).toBe('pending');
      const fieldRows = await db.select().from(memberChangeRequestFields).where(inArray(memberChangeRequestFields.requestId, [id]));
      expect(fieldRows.every((f) => f.outcome === null)).toBe(true);
    } finally {
      await deleteTestUser(reviewer).catch(() => {});
    }
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

    // queue default = pending oldest-first
    const queue = await drizzleChangeRequestRepo.listQueue(a.tenant.ctx, {}, { cursor: null, limit: 10 });
    expect(queue.ok && queue.value.items.map((r) => r.request.id)).toEqual([second.id]);
    const filtered = await drizzleChangeRequestRepo.listQueue(a.tenant.ctx, { state: 'decided', outcome: 'partially_approved' }, { cursor: null, limit: 10 });
    expect(filtered.ok && filtered.value.items.length).toBe(1);

    // FR-029 scope (PR-2 review, Critical C1). Every row seeded above is
    // `mixed`, so the previous `every((r) => r.request.scope !== 'own_contact')`
    // was VACUOUSLY true — it passed on an all-mixed set and would have passed
    // against a repo with no scope predicate at all. Seed a REAL own_contact
    // row first. It needs its own submitter: the partial unique index allows
    // one pending row per submitter and `second` already holds A's. The FR-029
    // predicate reads `submitted_by_user_id` + `scope` only, so the colleague
    // reuses A's contact row for the display join.
    const colleague = await createActiveTestUser('member');
    lateUsers.push(colleague);
    const ownContact = draft(a, {
      submittedByUserId: mu(colleague.userId),
      submitterRoleAtSubmission: 'secondary',
      scope: 'own_contact',
      submittedAt: new Date('2026-09-11T11:10:00Z'),
      fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66877777777', affectsTaxDocuments: false }],
    });
    const insOwn = await runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.insertInTx(tx, ownContact));
    expect(insOwn.ok, JSON.stringify(insOwn)).toBe(true);

    const strangerView = await drizzleChangeRequestRepo.listVisibleToUser(
      a.tenant.ctx,
      mu(b.user.userId),
      asMemberId(a.memberId),
      { cursor: null, limit: 10 },
    );
    const visibleIds = strangerView.ok ? strangerView.value.items.map((r) => r.request.id) : [];
    expect(visibleIds).not.toContain(ownContact.id);
    // the positive control: the SAME read still carries the member's
    // company-level rows, so the line above is an exclusion, not an empty list
    expect(visibleIds).toContain(second.id);
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

  it('decideInTx refuses a DUPLICATED field key and leaves the request pending (defence-in-depth, migration re-review L1 — the guard had never gone red)', async () => {
    // Tenant B's seeded request is still pending and carries BOTH fixture
    // keys, so this decision covers EVERY field row: only the duplicate can
    // refuse it. That isolation matters — a duplicate that left some key
    // undecided would be caught by the `decision leaves … undecided` guard
    // instead, and this one would stay unexercised. Without lines 469-471 the
    // `UPDATE … FROM (VALUES …)` join updates the repeated row ONCE from an
    // unspecified source row, RETURNING still names the key, and the request
    // commits `decided`.
    const pending = await runInTenant(b.tenant.ctx, (tx) => drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(b.user.userId)));
    expect(pending.ok && pending.value).not.toBeNull();
    const id = pending.ok && pending.value ? pending.value.id : ('' as ChangeRequestId);
    const keys = pending.ok && pending.value ? pending.value.fields.map((f) => f.key) : [];
    expect(keys.length).toBeGreaterThan(0);
    const reviewer = await createActiveTestUser('admin');
    lateUsers.push(reviewer);
    const decidedAt = new Date('2026-09-11T13:00:00Z');
    await expect(
      runInTenant(b.tenant.ctx, async (tx) => {
        const r = await drizzleChangeRequestRepo.decideInTx(tx, id, {
          decidedAt,
          decidedByUserId: mu(reviewer.userId),
          outcome: 'rejected',
          reason: 'duplicate-key probe',
          note: null,
          fields: [...keys, keys[0]!].map((key) => ({ key, outcome: 'rejected' as const, appliedAt: null })),
        });
        if (!r.ok) throw new UseCaseAbort(r.error);
        return r;
      }),
    ).rejects.toBeInstanceOf(UseCaseAbort);
    const [row] = await db.select().from(memberChangeRequests).where(inArray(memberChangeRequests.id, [id]));
    expect(row?.state).toBe('pending');
    expect(row?.decidedByUserId).toBeNull();
    const fieldRows = await db.select().from(memberChangeRequestFields).where(inArray(memberChangeRequestFields.requestId, [id]));
    expect(fieldRows.length).toBe(keys.length);
    expect(fieldRows.every((f) => f.outcome === null)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 10 (post-ship `/code-review` 2026-09-16)
  // -------------------------------------------------------------------------

  it('T124: ONE corrupt row is skipped from a list page (logged M114.repo.row_invalid) - the rest of the page still renders', async () => {
    // submitted by b.user INSIDE tenant A (the `pendingStats` case's idiom):
    // a.user already carries a pending row from the earlier cases here, and
    // the partial unique index allows exactly one per submitter
    const good = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: new Date('2026-09-11T14:00:00Z') });
    const corrupt = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: new Date('2026-09-11T14:05:00Z') });
    const seeded = await runInTenant(a.tenant.ctx, async (tx) => {
      const i1 = await drizzleChangeRequestRepo.insertInTx(tx, good);
      if (!i1.ok) return i1;
      const w = await drizzleChangeRequestRepo.withdrawInTx(tx, good.id, {
        reason: 'replaced',
        withdrawnAt: new Date('2026-09-11T14:05:00Z'),
        replacedByRequestId: corrupt.id,
      });
      if (!w.ok) return w;
      return drizzleChangeRequestRepo.insertInTx(tx, corrupt);
    });
    expect(seeded.ok).toBe(true);
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      // `jsonb` is unconstrained: a NUMBER in `seen_value` is outside the
      // Domain shape. Bare `db` (owner) - the app has no way to write this.
      await db
        .update(memberChangeRequestFields)
        .set({ seenValue: 42 as unknown as string })
        .where(and(eq(memberChangeRequestFields.requestId, corrupt.id), eq(memberChangeRequestFields.fieldKey, 'phone')));

      const page = await drizzleChangeRequestRepo.listByMember(a.tenant.ctx, asMemberId(a.memberId), { cursor: null, limit: 50 });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const ids = page.value.items.map((r) => r.request.id);
      expect(ids).toContain(good.id);
      expect(ids).not.toContain(corrupt.id);
      const skipped = errorSpy.mock.calls.find((c) => (c[0] as { errorId?: string }).errorId === 'M114.repo.row_invalid');
      expect(skipped, 'the skip must name itself in the log').toBeDefined();
      expect(skipped?.[0]).toMatchObject({ tenantId: a.tenant.ctx.slug, changeRequestId: corrupt.id });
      // ids only - no proposed value rides in the log line
      expect(JSON.stringify(skipped?.[0])).not.toContain('+668');
    } finally {
      errorSpy.mockRestore();
      await db.delete(memberChangeRequests).where(inArray(memberChangeRequests.id, [good.id, corrupt.id]));
    }
  });

  it('T125: the CHECK refuses a partially_approved decision with NO decision_reason (FR-014, migration 0303)', async () => {
    const d = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: new Date('2026-09-11T15:00:00Z') });
    const reviewer = await createActiveTestUser('admin');
    lateUsers.push(reviewer);
    await runInTenant(a.tenant.ctx, async (tx) => {
      const ins = await drizzleChangeRequestRepo.insertInTx(tx, d);
      if (!ins.ok) throw new UseCaseAbort(ins.error);
      const dec = await drizzleChangeRequestRepo.decideInTx(tx, d.id, {
        decidedAt: new Date('2026-09-11T15:10:00Z'),
        decidedByUserId: mu(reviewer.userId),
        outcome: 'partially_approved',
        reason: 'one field rejected',
        note: null,
        fields: [
          { key: 'phone', outcome: 'approved' as const, appliedAt: new Date('2026-09-11T15:10:00Z') },
          { key: 'billing_address', outcome: 'rejected' as const, appliedAt: null },
        ],
      });
      if (!dec.ok) throw new UseCaseAbort(dec.error);
    });
    try {
      // bare `db` (owner) - the DB is the LAST line: a repo bug or a
      // hand-written UPDATE must not be able to strip the reason
      let caught: unknown;
      try {
        await db.execute(sql`UPDATE "member_change_requests" SET "decision_reason" = NULL WHERE "id" = ${d.id}`);
      } catch (e) {
        caught = e;
      }
      expect(caught, 'the UPDATE must be refused by the CHECK').toBeDefined();
      // Drizzle wraps the driver error and hangs the original off `.cause`
      // (the last-admin-guard precedent) - walk the chain for the SQLSTATE
      let cur: unknown = caught;
      let pg: { code?: string; constraint_name?: string } | undefined;
      while (cur !== null && cur !== undefined) {
        const candidate = cur as { code?: string; constraint_name?: string; cause?: unknown };
        if (candidate.code === '23514') {
          pg = candidate;
          break;
        }
        cur = candidate.cause;
      }
      expect(pg, 'no 23514 in the cause chain').toBeDefined();
      expect(pg?.constraint_name).toBe('member_change_requests_reason_iff_rejected_ck');
      const [row] = await db.select().from(memberChangeRequests).where(inArray(memberChangeRequests.id, [d.id]));
      expect(row?.decisionReason).toBe('one field rejected');
      // the OTHER arms are unchanged: an `approved` decision needs no reason
      await db.execute(sql`UPDATE "member_change_requests" SET "outcome" = 'approved', "decision_reason" = NULL WHERE "id" = ${d.id}`);
      const [approved] = await db.select().from(memberChangeRequests).where(inArray(memberChangeRequests.id, [d.id]));
      expect(approved?.decisionReason).toBeNull();
    } finally {
      await db.delete(memberChangeRequests).where(inArray(memberChangeRequests.id, [d.id]));
    }
  });

  it('T128: countSubmittedSince is INCLUSIVE at the window boundary (FR-008 "in 24 hours")', async () => {
    const at = new Date('2026-09-20T08:00:00Z');
    const d = draft(a, { submittedByUserId: mu(b.user.userId), submittedAt: at, staffNotifiedAt: at });
    const ins = await runInTenant(a.tenant.ctx, (tx) => drizzleChangeRequestRepo.insertInTx(tx, d));
    expect(ins.ok).toBe(true);
    try {
      const atBoundary = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.countSubmittedSince(tx, mu(b.user.userId), at),
      );
      expect(atBoundary.ok && atBoundary.value).toEqual({ count: 1, oldestSubmittedAt: at });
      const justAfter = await runInTenant(a.tenant.ctx, (tx) =>
        drizzleChangeRequestRepo.countSubmittedSince(tx, mu(b.user.userId), new Date(at.getTime() + 1)),
      );
      expect(justAfter.ok && justAfter.value).toEqual({ count: 0, oldestSubmittedAt: null });
    } finally {
      await db.delete(memberChangeRequests).where(inArray(memberChangeRequests.id, [d.id]));
    }
  });
});

const reviewers: TestUser[] = [];
/** Users a change-request row REFERENCES (submitter / reviewer, RESTRICT) — deleted after the tenant rows are gone. */
const lateUsers: TestUser[] = [];
afterAll(async () => {
  for (const r of [...reviewers, ...lateUsers]) await deleteTestUser(r).catch(() => {});
});
