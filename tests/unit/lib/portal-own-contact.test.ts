/**
 * `resolveOwnContactId` — the ONE viewer-contact resolver behind the FR-029
 * projection (round 5, silent-failure #6 / tests I-3). It used to be three
 * hand-copied closures that returned null with no log; the projection then
 * dropped the viewer's OWN rows too, and nothing said why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

const loggerWarn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import { resolveOwnContactId } from '@/lib/portal-own-contact';

const tenant = asTenantContext('test-tenant');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const contact = (id: string, linked: string | null, removed = false) => ({ contactId: id, linkedUserId: linked, removedAt: removed ? new Date() : null });

beforeEach(() => vi.clearAllMocks());

describe('resolveOwnContactId', () => {
  it("returns the viewer's own LIVE contact id", async () => {
    const repo = { listByMember: vi.fn(async () => ok([contact('c-other', 'u-other'), contact('c-me', 'u-me')])) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toBe('c-me');
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('a removed contact does not count; not linked → null, silently (a legitimate state)', async () => {
    const repo = { listByMember: vi.fn(async () => ok([contact('c-me', 'u-me', true)])) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toBeNull();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('a repo Result fault → null (fail closed) AND a warning naming the code', async () => {
    const repo = { listByMember: vi.fn(async () => err({ code: 'repo.unexpected' as const })) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: 'repo.unexpected', requestId: 'req-1' }), 'portal.own_contact_unresolved');
  });

  it('a throw → null (fail closed) AND a warning with the error kind', async () => {
    const repo = { listByMember: vi.fn(async () => { throw new TypeError('boom'); }) };
    expect(await resolveOwnContactId(repo, tenant, MEMBER, 'u-me', 'req-1')).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: 'TypeError' }), 'portal.own_contact_unresolved');
  });
});
