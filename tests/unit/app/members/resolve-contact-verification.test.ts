// tests/unit/app/members/resolve-contact-verification.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { resolveContactVerification } from '@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification';

const logger = { debug: vi.fn(), warn: vi.fn() };
const errKind = (e: unknown) => (e as Error)?.constructor?.name ?? 'Unknown';

function contact(id: string, linkedUserId: string | null, removedAt: Date | null = null) {
  return { contactId: id, linkedUserId, removedAt };
}

describe('resolveContactVerification', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // (a) linked+unverified (userId NOT in verifiedSet) → pending
  it('marks a linked contact whose userId is NOT in verifiedSet as pending', async () => {
    const isVerifiedBatch = vi.fn().mockResolvedValue(ok(new Set<string>()));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(true);
    expect(isVerifiedBatch).toHaveBeenCalledWith(['u1']);
  });

  // (b) verified (userId IS in verifiedSet) → not-pending
  it('does NOT mark a contact whose userId IS in verifiedSet', async () => {
    const isVerifiedBatch = vi.fn().mockResolvedValue(ok(new Set(['u1'])));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
  });

  // (c) no linkedUserId / removed → NOT in queried ids; isVerifiedBatch NOT called
  it('skips contacts with no linkedUserId or with removedAt set — does NOT call isVerifiedBatch', async () => {
    const isVerifiedBatch = vi.fn();
    const res = await resolveContactVerification({
      contacts: [contact('c1', null), contact('c2', 'u2', new Date())],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.size).toBe(0);
    expect(isVerifiedBatch).not.toHaveBeenCalled();
  });

  // (d) batch err → empty pending + warn
  it('returns empty pending and warns when isVerifiedBatch returns err', async () => {
    const isVerifiedBatch = vi.fn().mockResolvedValue(err({ code: 'repo.unexpected' }));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'contact_verification_batch_read_err', memberId: 'm1' }),
      expect.any(String),
    );
  });

  // (e) batch throws → empty pending + warn
  it('returns empty pending and warns when isVerifiedBatch throws', async () => {
    const isVerifiedBatch = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'contact_verification_batch_read_threw' }),
      expect.any(String),
    );
  });

  // (f) MIXED — two contacts, one in verifiedSet (not-pending), one not (pending)
  it('correctly splits mixed contacts: only those NOT in verifiedSet are pending', async () => {
    // u1 is verified, u2 is not
    const isVerifiedBatch = vi.fn().mockResolvedValue(ok(new Set(['u1'])));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1'), contact('c2', 'u2')],
      memberId: 'm1',
      isVerifiedBatch,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
    expect(res.pending.has('c2')).toBe(true);
    // batch called once with both userIds
    expect(isVerifiedBatch).toHaveBeenCalledTimes(1);
    const calledWith = isVerifiedBatch.mock.calls[0]![0] as string[];
    expect(calledWith.sort()).toEqual(['u1', 'u2'].sort());
  });
});
