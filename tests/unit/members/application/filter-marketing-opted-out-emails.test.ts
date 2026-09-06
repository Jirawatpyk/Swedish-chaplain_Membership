/**
 * 108 PR-D review cycle 10 (privacy B-1 / security HIGH-1) —
 * `filterMarketingOptedOutEmails`: the F3 use case behind F7's
 * `MembersBridgePort.filterMarketingOptedOut`. Given a batch of lower-cased
 * addresses it answers which of them belong to a LIVE contact that carries a
 * marketing opt-out (FR-022a), so the dispatcher can drop them.
 *
 * Thin by design: an empty batch never touches the repo; anything else is one
 * batched repo call; a repo failure is returned as-is (the bridge turns it
 * into a rejection — never fail-open).
 */
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { filterMarketingOptedOutEmails } from '@/modules/members';
import type { ContactRepo } from '@/modules/members/application/ports/contact-repo';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');

function makeRepo(answer: ReadonlySet<string> | 'error') {
  const findMarketingOptedOutEmailLowers = vi.fn(async () =>
    answer === 'error'
      ? err({ code: 'repo.unexpected' as const, cause: new Error('boom') })
      : ok(answer),
  );
  return {
    repo: { findMarketingOptedOutEmailLowers } as unknown as ContactRepo,
    findMarketingOptedOutEmailLowers,
  };
}

describe('filterMarketingOptedOutEmails (108 PR-D B-1)', () => {
  it('empty batch → ok(empty set) without touching the repo', async () => {
    const { repo, findMarketingOptedOutEmailLowers } = makeRepo(new Set());
    const r = await filterMarketingOptedOutEmails({ tenant, contactRepo: repo }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.size).toBe(0);
    expect(findMarketingOptedOutEmailLowers).not.toHaveBeenCalled();
  });

  it('one batched repo call, tenant-scoped; the matched subset comes back', async () => {
    const { repo, findMarketingOptedOutEmailLowers } = makeRepo(new Set(['b@example.com']));
    const r = await filterMarketingOptedOutEmails(
      { tenant, contactRepo: repo },
      ['a@example.com', 'b@example.com'],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.value]).toEqual(['b@example.com']);
    expect(findMarketingOptedOutEmailLowers).toHaveBeenCalledTimes(1);
    expect(findMarketingOptedOutEmailLowers).toHaveBeenCalledWith(tenant, [
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('repo failure is returned, not swallowed into an empty set', async () => {
    const { repo } = makeRepo('error');
    const r = await filterMarketingOptedOutEmails(
      { tenant, contactRepo: repo },
      ['a@example.com'],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('repo.unexpected');
  });
});
