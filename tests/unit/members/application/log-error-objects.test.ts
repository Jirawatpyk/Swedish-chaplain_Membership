/**
 * Spec 140 s2d (#736c) — a members log line carries an error as its class
 * (`errKind`), its SQLSTATE (`pgErrorCode`), the RepoError's `repoCode` and a
 * code-authored `step` — never the error object, its `cause`, or its message.
 *
 * drizzle-orm's `DrizzleQueryError` has ENUMERABLE `query` and `params`, so a
 * raw error on a pino line serialises the statement and its bound parameters
 * (here an email). One representative site per behaviour class:
 *   - a RepoError whose cause is a `DrizzleQueryError` (bulk-action lookup);
 *   - a raw thrown `DrizzleQueryError` (undelete-member's unhandled arm);
 *   - a thrown Error with an email in its message (set-member-preferred-locale);
 *   - the invite path's RepoError `cause:` (invite-portal link failure);
 *   - a code-authored throw keeps its step (bulk-action's outer catch).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { restoreOutcome: vi.fn() },
}));

import { logger } from '@/lib/logger';
import { errStep } from '@/lib/log-id';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { bulkAction, type BulkActionDeps } from '@/modules/members/application/use-cases/bulk-action';
import { undeleteMember, type UndeleteMemberDeps } from '@/modules/members/application/use-cases/undelete-member';
import { setMemberPreferredLocale } from '@/modules/members/application/use-cases/set-member-preferred-locale';
import { invitePortal, type InvitePortalDeps } from '@/modules/members/application/use-cases/invite-portal';
import type { ContactId } from '@/modules/members/domain/contact';

const EMAIL = 'ann@example.com';
const tenant = asTenantContext('test-tenant');
const M1 = asMemberId('11111111-1111-4111-8111-111111111111');
const META = { actorUserId: 'admin-1', requestId: 'req-736c' };

/** A unique violation as postgres-js raises it, wrapped by Drizzle the way every repo call sees it. */
function leakyDbError(): DrizzleQueryError {
  const pg = Object.assign(new Error(`duplicate key value violates unique constraint "contacts_email_uniq"`), {
    code: '23505',
    constraint_name: 'contacts_email_uniq',
    detail: `Key (email)=(${EMAIL}) already exists.`,
  });
  return new DrizzleQueryError('update contacts set email = $1 where member_id = $2', [EMAIL, M1], pg);
}

/** The fields object of the one logger call that carries `msg`. */
function fieldsOf(level: 'error' | 'warn', msg: string): Record<string, unknown> {
  const calls = vi.mocked(logger[level]).mock.calls.filter((c) => c[1] === msg);
  expect(calls, `one ${level} line "${msg}"`).toHaveLength(1);
  return calls[0]![0] as Record<string, unknown>;
}

/** Nothing from the error's text or its bound parameters reaches the line. */
function expectNoErrorText(fields: Record<string, unknown>): void {
  expect(JSON.stringify(fields)).not.toMatch(/ann@example\.com|Failed query|update contacts|"params"|"query"|Key \(/);
}

beforeEach(() => vi.clearAllMocks());

describe('RepoError with a DrizzleQueryError cause — bulk-action lookup', () => {
  it('logs the cause class, the repo code and the SQLSTATE, then the outer catch logs the code-authored step', async () => {
    const deps = {
      tenant,
      clock: { now: () => new Date() },
      memberRepo: {
        findManyByIdsInTx: vi.fn(async () => err({ code: 'repo.unexpected', cause: leakyDbError() })),
      },
    } as unknown as BulkActionDeps;

    const r = await bulkAction({ action: 'archive', member_ids: [M1] }, META, deps);

    expect(r.ok).toBe(false);
    const lookup = fieldsOf('error', 'bulk-action: findManyByIdsInTx unexpected error');
    expect(lookup).toEqual({ err: 'DrizzleQueryError', repoCode: 'repo.unexpected', code: '23505', requestId: 'req-736c' });
    expectNoErrorText(lookup);
    const rolledBack = fieldsOf('error', 'bulk-action: transaction rolled back');
    expect(rolledBack).toMatchObject({ err: 'Error', step: 'lookup_failed:repo.unexpected', action: 'archive' });
    expectNoErrorText(rolledBack);
  });
});

describe('a raw thrown DrizzleQueryError — undelete-member unhandled', () => {
  it('logs the class and the SQLSTATE, never the object', async () => {
    const deps = {
      tenant,
      clock: { now: () => new Date() },
      memberRepo: { findByIdInTx: vi.fn(async () => { throw leakyDbError(); }) },
      contactRepo: {},
      audit: {},
      renewalsCascade: { restoreForMember: vi.fn() },
    } as unknown as UndeleteMemberDeps;

    const r = await undeleteMember(M1, { actorUserId: 'admin-1', requestId: 'req-736c' }, deps);

    expect(r.ok).toBe(false);
    const fields = fieldsOf('error', 'undelete-member: unhandled');
    expect(fields).toEqual({ err: 'DrizzleQueryError', code: '23505', memberId: M1, requestId: 'req-736c' });
    expectNoErrorText(fields);
  });
});

describe('a thrown Error with an email in its message — set-member-preferred-locale', () => {
  it('logs the class, not the message', async () => {
    const r = await setMemberPreferredLocale(
      {
        tenant,
        memberRepo: {
          findPreferredLocaleInTx: vi.fn(async () => { throw new Error(`no row for ${EMAIL}`); }),
        } as never,
        audit: { recordInTx: vi.fn() } as never,
      },
      { memberId: M1, nextValue: 'th', actor: { kind: 'admin', userId: 'admin-1' }, requestId: 'req-736c' },
    );

    expect(r.ok).toBe(false);
    const fields = fieldsOf('error', 'members.set_preferred_locale.unexpected');
    expect(fields).toMatchObject({ err: 'Error', tenantId: 'test-tenant', memberId: M1 });
    expectNoErrorText(fields);
  });
});

describe('the invite path — invite-portal link failure', () => {
  it('logs the RepoError as class + repo code + SQLSTATE, not as a cause object', async () => {
    const deps = {
      tenant,
      contactRepo: {
        findById: vi.fn(async () =>
          ok({ contactId: 'c-1', email: EMAIL, firstName: 'Ann', lastName: 'A', preferredLanguage: 'en', linkedUserId: null, isPrimary: true }),
        ),
        linkUserInTx: vi.fn(async () => err({ code: 'repo.unexpected', cause: leakyDbError() })),
      },
      createUser: vi.fn(async () => ok({ user: { id: 'usr-1' }, outboxRowId: 'ob-1' })),
      deleteInvitedUser: vi.fn(async () => ({ ok: true })),
    } as unknown as InvitePortalDeps;

    const r = await invitePortal(deps, {
      contactId: 'c-1' as ContactId,
      actorUserId: 'admin-1',
      sourceIp: '203.0.113.5',
      requestId: 'req-736c',
    });

    expect(r.ok).toBe(false);
    const fields = fieldsOf('error', 'invite-portal.link_user_failed: rolling back orphaned invite (SAGA compensation)');
    expect(fields).toMatchObject({ err: 'DrizzleQueryError', repoCode: 'repo.unexpected', code: '23505' });
    expect(fields).not.toHaveProperty('cause');
    expectNoErrorText(fields);
  });
});

describe('errStep — a code-authored throw keeps its step, any other message is dropped', () => {
  it.each([
    [new Error('lookup_failed:repo.unexpected'), 'lookup_failed:repo.unexpected'],
    [new Error('audit_failed'), 'audit_failed'],
    [new Error(`no row for ${EMAIL}`), undefined],
    [leakyDbError(), undefined],
    ['lookup_failed', undefined],
    [null, undefined],
  ] as const)('%s → %s', (e, step) => {
    expect(errStep(e)).toBe(step);
  });
});
