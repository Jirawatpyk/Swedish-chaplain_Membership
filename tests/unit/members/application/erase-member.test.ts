/**
 * Unit tests for `eraseMember` use case SKELETON (COMP-1 US1, Task 4).
 *
 * Scope: input validation, the durable `member_erasure_requested` emit, and
 * the atomic tx that scrubs members + contacts. The session/invitation cascade
 * (Task 5) and the post-commit F7/F8 cascades + `member_erased` (Task 6) are
 * NOT yet wired — those gain their own coverage when implemented.
 *
 * Uses port stubs + a mocked `runInTenant` (`@/lib/db`) that invokes the
 * supplied fn with an empty tx — the skeleton talks to ports only, never the
 * raw Drizzle chain, so a bare `{}` tx is sufficient. Live RLS + cascade
 * coverage lives in the integration suite added by later tasks.
 */
import { describe, expect, it, vi } from 'vitest';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { asMemberId } from '@/modules/members';
import { buildEraseDeps } from './erase-member.fixtures';

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: never) => unknown) => fn({} as never),
}));

const META = { actorUserId: 'admin-1', requestId: 'req-1' };
const MEMBER_ID = asMemberId('m-1');
const MISSING_ID = asMemberId('missing');

describe('eraseMember — requested audit + atomic scrub', () => {
  it('rejects an unknown reason with invalid_body', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(MEMBER_ID, { reason: 'because' }, META, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });

  it('emits member_erasure_requested before the scrub, then scrubs members + contacts', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erasure_requested');
    expect(deps.memberRepo.scrubPiiInTx).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER_ID,
      expect.objectContaining({ erasedAt: expect.any(Date) }),
    );
    expect(deps.contactRepo.scrubPiiForMemberInTx).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER_ID,
      expect.objectContaining({ erasedAt: expect.any(Date) }),
    );
  });

  it('returns not_found when the member does not exist', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findByIdInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as const,
    );
    const res = await eraseMember(
      MISSING_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
  });

  it('returns not_found when scrubPiiInTx reports the member vanished mid-tx', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.scrubPiiInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as const,
    );
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
  });
});
