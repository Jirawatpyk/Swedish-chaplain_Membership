/**
 * 130 (D-029) slice 5 — every statement of the members module's member repo
 * and its adapters (change-request scrub, email-change tokens, plan advisory
 * lock, plan lookup, the plan member count, the timeline, the erasure outbox
 * cancel) carries a
 * `tenant_id` predicate on each tenant-scoped table it names. `callEach`
 * refuses an unnamed method, and each method must record at least one
 * statement (a filter arg that throws before any SQL would otherwise pass
 * silently). The source scans cover statements that only run once an earlier
 * read returns rows (the recording db answers none).
 *
 * Exempt by construction, each by its exact method:
 * - `resolveBouncedInviteContacts` — the Resend webhook does not know the
 *   tenant; it resolves the owner tenant(s) of a bounced address across every
 *   tenant, then marks each inside its own `runInTenant`.
 * - `emailChangeTokenAdapter.findActiveById` — the token id is what resolves
 *   the tenant, so the read cannot be bound to one.
 * - the plan advisory lock (`SELECT pg_advisory_xact_lock(...)`), no table.
 *
 * The tx-only `…InTx` methods read their tenant with `tenantSlugOf(tx)`
 * (D-030), so the mock binds the recording db to `SHAPE_TENANT` the way
 * `runInTenant` binds a real tx.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb, SHAPE_TENANT } = await import('../../../helpers/tenant-sql-shape');
  const original = await importOriginal<typeof import('@/lib/db')>();
  const r = recordingDb();
  original.bindTenantTx(r.db, SHAPE_TENANT);
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...original,
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});
// `getPlan` delegates to the plans repo, which has its own gate (s4).
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({ planRepo: { findOne: async () => null } }),
}));

const {
  ANY,
  SHAPE_TENANT: T,
  anyWith,
  callEach,
  gateViolations,
  tenantScopedTables,
  unfencedRawSql,
  unfencedWheres,
} = await import('../../../helpers/tenant-sql-shape');
const { drizzleMemberRepo } = await import('@/modules/members/infrastructure/db/drizzle-member-repo');
const { changeRequestScrubAdapter } = await import(
  '@/modules/members/infrastructure/adapters/change-request-scrub-adapter'
);
const { emailChangeTokenAdapter } = await import('@/modules/members/infrastructure/adapters/email-change-token-adapter');
const { drizzlePlanAdvisoryLockAdapter } = await import(
  '@/modules/members/infrastructure/adapters/plan-advisory-lock-adapter'
);
const { plansBarrelAdapter } = await import('@/modules/members/infrastructure/adapters/plan-lookup-adapter');
const { outboxCancelAdapter } = await import('@/modules/members/infrastructure/adapters/outbox-cancel-adapter');
const { countActiveMembersOnPlan, countActiveMembersOnPlanInTx } = await import(
  '@/modules/members/infrastructure/db/count-active-members-on-plan'
);
const { resolveBouncedInviteContacts } = await import('@/modules/members/infrastructure/handle-invitation-bounce');
const { drizzleTimelineRepo } = await import('@/modules/members/infrastructure/timeline/drizzle-timeline-repo');

const TABLES = tenantScopedTables();
const CTX = { slug: T } as never;
const NOW = new Date('2026-01-01T00:00:00.000Z');
const SRC = {
  repo: 'src/modules/members/infrastructure/db/drizzle-member-repo.ts',
  scrub: 'src/modules/members/infrastructure/adapters/change-request-scrub-adapter.ts',
  token: 'src/modules/members/infrastructure/adapters/email-change-token-adapter.ts',
  lock: 'src/modules/members/infrastructure/adapters/plan-advisory-lock-adapter.ts',
  lookup: 'src/modules/members/infrastructure/adapters/plan-lookup-adapter.ts',
  outbox: 'src/modules/members/infrastructure/adapters/outbox-cancel-adapter.ts',
  count: 'src/modules/members/infrastructure/db/count-active-members-on-plan.ts',
  bounce: 'src/modules/members/infrastructure/handle-invitation-bounce.ts',
  timeline: 'src/modules/members/infrastructure/timeline/drizzle-timeline-repo.ts',
};

// Every optional filter OFF — the default path. Filter-ON cases follow.
const DIRECTORY_OFF = anyWith({
  q: undefined,
  status: undefined,
  planYear: undefined,
  country: undefined,
  planId: undefined,
  riskBand: undefined,
  portalNeedsInvite: undefined,
  sort: undefined,
  order: undefined,
  cursor: undefined,
  limit: 10,
  offset: 0,
});
const AUDIENCE_OFF = anyWith({
  q: undefined,
  memberId: undefined,
  kind: undefined,
  optOut: undefined,
  eligibleOnly: false,
  emailLowerIn: undefined,
  emailLowerNotIn: undefined,
  limit: 10,
  offset: 0,
});
const STATUS = { status: 'archived', archivedAt: NOW, updatedAt: NOW };
const SEGMENT_ALL = anyWith({ segmentType: 'all_members', tierCodes: undefined, after: null, limit: 10, excludeMemberId: undefined });

/**
 * `callEach` over a wrapper that records how many statements each method
 * sent, so a method that throws before its first statement fails here.
 */
async function callCounted(
  target: Record<string, unknown>,
  calls: Record<string, readonly unknown[]>,
): Promise<{ silent: string[]; byMethod: Map<string, RecordedStatement[]> }> {
  const byMethod = new Map<string, RecordedStatement[]>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(target)) {
    if (typeof fn !== 'function') continue;
    wrapped[name] = async (...args: unknown[]) => {
      const before = rec.statements.length;
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      } finally {
        byMethod.set(name, rec.statements.slice(before));
      }
    };
  }
  await callEach(wrapped, calls);
  const silent = [...byMethod].filter(([, s]) => s.length === 0).map(([n]) => n);
  return { silent, byMethod };
}

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const { blind, violations } = gateViolations(statements, TABLES);
  // Positive control: every read/update names a tenant table the parse sees.
  expect(blind).toEqual([]);
  return violations;
}

describe('members repo + adapters — tenant predicate on every statement (130 s5)', () => {
  it('member repo, every method with its optional filters OFF', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    const { silent, byMethod } = await callCounted(drizzleMemberRepo as never, {
      findById: [CTX, 'member-1'],
      findByIdInTx: [tx, 'member-1'],
      findRiskById: [CTX, 'member-1'],
      findErasedAtByIdInTx: [tx, 'member-1'],
      findErasedAtById: [CTX, 'member-1'],
      findStuckErasuresInTx: [tx, T, 10],
      findManyByIdsInTx: [tx, T, ['member-1']],
      enrolAutoInvoiceInTx: [tx, T, ['member-1'], NOW],
      findErasedIdsInTx: [tx, T, ['member-1']],
      findIdsWithoutLivePrimaryInTx: [tx, T, ['member-1']],
      unenrolAutoInvoiceInTx: [tx, T, ['member-1']],
      findByLinkedUserId: [CTX, 'user-1'],
      findSoftDuplicate: [CTX, 'Acme', 'TH'],
      createWithPrimaryContactInTx: [tx, anyWith({ member: anyWith({ registrationDate: NOW, archivedAt: null }), primaryContact: ANY, secondaryContact: null })],
      updateStatus: [CTX, 'member-1', STATUS],
      updateStatusInTx: [tx, 'member-1', STATUS],
      updateFields: [CTX, 'member-1', { companyName: 'Acme' }],
      updateFieldsInTx: [tx, 'member-1', { companyName: 'Acme' }],
      scrubPiiInTx: [tx, 'member-1', { erasedAt: NOW }],
      searchDirectory: [CTX, DIRECTORY_OFF],
      searchDirectoryWithCount: [CTX, DIRECTORY_OFF],
      listContactsForMarketingAudience: [CTX, AUDIENCE_OFF],
      countMembersNeedingPortalInvite: [CTX, anyWith({ ...DIRECTORY_OFF, portalNeedsInvite: { now: NOW } })],
      findMembersBySegmentForBroadcast: [CTX, SEGMENT_ALL],
      findBroadcastRecipientContacts: [CTX, SEGMENT_ALL],
      countBroadcastOptedOutContacts: [CTX, SEGMENT_ALL],
      findMembersHaltedForBroadcast: [CTX],
      updateBroadcastsHaltedInTx: [tx, 'member-1', true],
      updateBroadcastsAcknowledgedAtInTx: [tx, 'member-1', NOW],
      findPrimaryContactEmailInTx: [tx, T, 'member-1'],
      findPreferredLocaleInTx: [tx, 'member-1'],
      updatePreferredLocaleInTx: [tx, 'member-1', 'th'],
      findMemberByPrimaryContactEmailInTx: [tx, 'a@example.com'],
      findLastPlanChangedAt: [CTX, 'member-1'],
      findPendingInvitationsForMember: [CTX, 'member-1'],
      findPendingInvitationsForPrimaryContacts: [CTX, ['member-1']],
    });
    expect(silent).toEqual([]);
    expect(byMethod.size).toBeGreaterThanOrEqual(36);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('member repo, the optional filters ON', async () => {
    rec.statements.length = 0;
    const cursor = Buffer.from('2026-01-01T00:00:00.000Z|member-1').toString('base64');
    const directoryOn = {
      q: '42',
      status: ['active'],
      planYear: 2026,
      country: 'TH',
      planId: 'plan-1',
      riskBand: ['high', 'critical'],
      portalNeedsInvite: { now: NOW },
      sort: 'engagement',
      order: 'asc',
      limit: 10,
      offset: 0,
    };
    const tier = anyWith({
      segmentType: 'tier',
      tierCodes: ['corporate'],
      after: { kind: 'after_contact', memberId: 'member-1', contactId: 'contact-1' },
      limit: 10,
      excludeMemberId: 'member-2',
    });
    const repo = drizzleMemberRepo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const before = rec.statements.length;
    await repo.searchDirectory!(CTX, { ...directoryOn, cursor });
    await repo.searchDirectoryWithCount!(CTX, directoryOn);
    await repo.searchDirectoryWithCount!(CTX, { ...directoryOn, sort: 'memberNumber', order: 'desc' });
    await repo.listContactsForMarketingAudience!(CTX, {
      q: 'acme',
      memberId: 'member-1',
      kind: 'primary',
      optOut: 'self',
      eligibleOnly: true,
      emailLowerIn: ['a@example.com'],
      emailLowerNotIn: ['b@example.com'],
      limit: 10,
      offset: 0,
    });
    await repo.findMembersBySegmentForBroadcast!(CTX, tier);
    await repo.findBroadcastRecipientContacts!(CTX, tier);
    await repo.findBroadcastRecipientContacts!(CTX, anyWith({ ...tier, after: { kind: 'after_member', memberId: 'member-1' } }));
    await repo.countBroadcastOptedOutContacts!(CTX, tier);
    // The primary-contact follow-ups only run once a page has rows.
    expect(rec.statements.length - before).toBeGreaterThanOrEqual(11);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('change-request scrub, email-change tokens, plan lock + lookup, the plan member count', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    const scrub = await callCounted(changeRequestScrubAdapter as never, {
      scrubForMemberInTx: [tx, 'member-1', NOW],
      listRequestIdsInTx: [tx, 'member-1'],
    });
    const tokens = await callCounted(emailChangeTokenAdapter as never, {
      findActiveById: ['token-1'],
      insertInTx: [tx, CTX, anyWith({ activatedAt: NOW, expiresAt: NOW })],
      findActiveByIdInTx: [tx, 'token-1'],
      markConsumedInTx: [tx, 'token-1', NOW],
      invalidateActiveForUserInTx: [tx, 'user-1', 'revert', NOW],
      invalidateAllActiveForUsersInTx: [tx, ['user-1'], NOW],
    });
    const lock = await callCounted(drizzlePlanAdvisoryLockAdapter as never, {
      acquire: [tx, 'plans:tenant-shape:plan-1:2026'],
      isPlanSoftDeletedInTx: [tx, 'plan-1', 2026],
    });
    const lookup = await callCounted(plansBarrelAdapter as never, {
      getPlan: [CTX, 'plan-1', 2026],
      countAffectedMembers: [CTX, 'plan-1', 2026],
    });
    const outbox = await callCounted(outboxCancelAdapter as never, {
      cancelPendingForEmailsInTx: [tx, ['a@example.com'], 'member-1'],
      cancelPendingForMemberInTx: [tx, 'member-1'],
    });
    await countActiveMembersOnPlan(CTX, 'plan-1', 2026);
    await countActiveMembersOnPlanInTx(tx as never, 'plan-1', 2026).catch(() => 0);

    // `getPlan` reaches the (mocked) plans repo only — no statement of its own.
    expect([...scrub.silent, ...tokens.silent, ...lock.silent, ...outbox.silent, ...lookup.silent]).toEqual(['getPlan']);
    // The token lookup that resolves the tenant: exactly one id read, exempt.
    const resolving = tokens.byMethod.get('findActiveById')!;
    expect(resolving).toHaveLength(1);
    expect(resolving[0]!.sql).toMatch(/^select .* from "email_change_tokens" where \("email_change_tokens"\."id" = \$1/);
    const exempt = new Set(resolving);
    expect(violationsOf(rec.statements.filter((s) => !exempt.has(s)))).toEqual([]);
  });

  it('a tx runInTenant did not open sends nothing and throws, never a Result (D-030)', async () => {
    const { recordingDb } = await import('../../../helpers/tenant-sql-shape');
    const { TenantTxNotBoundError } = await import('@/lib/db');
    const unbound = recordingDb();
    const tx = unbound.db as never;
    // A misuse, not a DB error: it must not read as `repo.unexpected` or, in
    // the token verify / revert routes, as `not_found`.
    await expect(drizzleMemberRepo.findByIdInTx(tx, 'member-1' as never)).rejects.toBeInstanceOf(TenantTxNotBoundError);
    await expect(emailChangeTokenAdapter.findActiveByIdInTx(tx, 'token-1')).rejects.toBeInstanceOf(TenantTxNotBoundError);
    await expect(changeRequestScrubAdapter.listRequestIdsInTx(tx, 'member-1' as never)).rejects.toBeInstanceOf(TenantTxNotBoundError);
    await expect(outboxCancelAdapter.cancelPendingForMemberInTx(tx, 'member-1' as never)).rejects.toBeInstanceOf(TenantTxNotBoundError);
    expect(unbound.statements).toEqual([]);
  });

  it('a tenant argument that differs from the tx tenant sends nothing (D-030)', async () => {
    const tx = rec.db;
    const repo = drizzleMemberRepo as unknown as Record<string, (...a: unknown[]) => Promise<{ ok: boolean }>>;
    const calls: Array<[string, unknown[]]> = [
      ['findManyByIdsInTx', [tx, 'other-tenant', ['member-1']]],
      ['enrolAutoInvoiceInTx', [tx, 'other-tenant', ['member-1'], NOW]],
      ['findErasedIdsInTx', [tx, 'other-tenant', ['member-1']]],
      ['findIdsWithoutLivePrimaryInTx', [tx, 'other-tenant', ['member-1']]],
      ['unenrolAutoInvoiceInTx', [tx, 'other-tenant', ['member-1']]],
      ['findPrimaryContactEmailInTx', [tx, 'other-tenant', 'member-1']],
      [
        'createWithPrimaryContactInTx',
        [tx, anyWith({ member: anyWith({ tenantId: 'other-tenant', registrationDate: NOW, archivedAt: null }), primaryContact: ANY, secondaryContact: null })],
      ],
    ];
    for (const [name, args] of calls) {
      rec.statements.length = 0;
      const result = await repo[name]!(...args);
      expect(result.ok, name).toBe(false);
      expect(rec.statements, name).toEqual([]);
    }
    // The erasure reconciler's read returns rows, not a Result: it throws.
    rec.statements.length = 0;
    await expect(drizzleMemberRepo.findStuckErasuresInTx(tx as never, 'other-tenant', 10)).rejects.toThrow();
    expect(rec.statements).toEqual([]);
  });

  it('the bounce resolver is the one cross-tenant read, and it is only that', async () => {
    rec.statements.length = 0;
    await resolveBouncedInviteContacts('a@example.com');
    expect(rec.statements).toHaveLength(1);
    expect(rec.statements[0]!.sql).toMatch(/^select .* from "contacts" inner join "invitations"/);
  });

  it('timeline — the view reads are bound to the tenant', async () => {
    rec.statements.length = 0;
    await drizzleTimelineRepo.listByMember(CTX, anyWith({
      memberId: 'member-1',
      cursor: null,
      limit: 10,
      source: undefined,
      actorKind: undefined,
      fromTs: undefined,
      toTs: undefined,
      excludeMoney: undefined,
      auditEventTypeAllowlist: undefined,
    }) as never);
    // `member_timeline_v` is a view, not a schema table, so the checker does
    // not see it; assert its own `tenant_id = $n` is bound to the tenant.
    expect(rec.statements.length).toBeGreaterThanOrEqual(2);
    for (const s of rec.statements) {
      const bound = [...s.sql.matchAll(/\btenant_id = \$(\d+)/g)].filter((m) => s.params[Number(m[1]) - 1] === T);
      expect(bound.length, s.sql.slice(0, 80)).toBeGreaterThanOrEqual(1);
    }
  });

  it('every hand-written sql block on a tenant table names tenant_id (row-dependent statements included)', () => {
    for (const path of Object.values(SRC)) {
      expect(unfencedRawSql(readFileSync(path, 'utf8'), TABLES), path).toEqual([]);
    }
  });

  it('every .where( names tenant_id, or is a known fenced / exempt clause (row-dependent statements included)', () => {
    // `whereClause` is the composed directory / audience filter, fenced and
    // proven by the call-map cases above; the `consumedInv` anti-joins read
    // `invitations`, which has no tenant_id.
    expect(unfencedWheres(readFileSync(SRC.repo, 'utf8'))).toEqual([
      'and( eq(consumedInv.userId, invitations.userId), isNotNull(consumedInv.consumedAt), ),',
      'and( eq(consumedInv.userId, invitations.userId), isNotNull(consumedInv.consumedAt), ),',
      'whereClause',
      'whereClause',
      'whereClause',
      'whereClause',
      'whereClause',
      'whereClause',
    ]);
    expect(unfencedWheres(readFileSync(SRC.scrub, 'utf8'))).toEqual([]);
    // The tenant-resolving token read (see the header).
    expect(unfencedWheres(readFileSync(SRC.token, 'utf8'))).toEqual([
      'and( eq(emailChangeTokens.id, tokenId), isNull(emailChangeTokens.consumedAt), gt(emailChangeTokens.expiresAt, sql`now()`), ),',
    ]);
    expect(unfencedWheres(readFileSync(SRC.lock, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(SRC.lookup, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(SRC.outbox, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(SRC.count, 'utf8'))).toEqual([]);
    // The cross-tenant bounce resolver (see the header).
    expect(unfencedWheres(readFileSync(SRC.bounce, 'utf8'))).toEqual([
      'and( sql`LOWER(${contacts.email}) = LOWER(${email})`, isNull(contacts.removedAt), isNull(contacts.inviteBouncedAt), isNull(invitations.consumedAt), gt(invitations.expiresAt, sql`NOW()`), ),',
    ]);
    // `users` is a platform table with no tenant_id.
    expect(unfencedWheres(readFileSync(SRC.timeline, 'utf8'))).toEqual(['inArray(users.id, uuidActorIds)']);
  });
});
