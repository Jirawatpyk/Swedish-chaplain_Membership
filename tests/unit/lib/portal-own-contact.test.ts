/**
 * `resolveOwnContactId` — the ONE viewer-contact resolver behind the FR-029
 * portal timeline projection. Round 5 gave it a log; round 7 gave it a TYPE:
 * a read fault is `err`, never a `null` that reads as "not linked" (the
 * distinction `readOwnPendingRequest` already carries), so a caller can show
 * an error instead of a silently shortened timeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

const loggerWarn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { resolveOwnContactId } from '@/lib/portal-own-contact';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const contact = (id: string, linked: string | null, removed = false) => ({ contactId: id, linkedUserId: linked, removedAt: removed ? new Date() : null });

beforeEach(() => vi.clearAllMocks());

describe('resolveOwnContactId', () => {
  it("returns ok(the viewer's own LIVE contact id)", async () => {
    const repo = { listByMember: vi.fn(async () => ok([contact('c-other', 'u-other'), contact('c-me', 'u-me')])) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toEqual(ok('c-me'));
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('a removed contact does not count; not linked → ok(null), silently (a legitimate state)', async () => {
    const repo = { listByMember: vi.fn(async () => ok([contact('c-me', 'u-me', true)])) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toEqual(ok(null));
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('a repo Result fault → err (the caller decides what the viewer sees) AND a warning naming the code', async () => {
    const repo = { listByMember: vi.fn(async () => err({ code: 'repo.unexpected' as const })) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toEqual(err({ code: 'repo.unexpected' }));
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: 'repo.unexpected', requestId: 'req-1' }), 'portal.own_contact_unresolved');
  });

  it('a throw → err with the error kind AND a warning', async () => {
    const repo = { listByMember: vi.fn(async () => { throw new TypeError('boom'); }) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toEqual(err({ code: 'TypeError' }));
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: 'TypeError' }), 'portal.own_contact_unresolved');
  });
});
