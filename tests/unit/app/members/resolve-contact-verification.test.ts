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

  it('marks a linked contact whose email is unverified as pending', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(false));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(true);
    expect(isVerified).toHaveBeenCalledWith('u1');
  });

  it('does NOT mark a verified linked contact', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(true));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
  });

  it('skips contacts with no linkedUserId and removed contacts (no read)', async () => {
    const isVerified = vi.fn().mockResolvedValue(ok(false));
    const res = await resolveContactVerification({
      contacts: [contact('c1', null), contact('c2', 'u2', new Date())],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.size).toBe(0);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('defaults to not-pending when the read errors (button hidden on unknown)', async () => {
    const isVerified = vi.fn().mockResolvedValue(err({ code: 'repo.unexpected' }));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'contact_verification_read_err', contactId: 'c1' }), expect.any(String));
  });

  it('defaults to not-pending when the callable throws (button hidden on unknown)', async () => {
    const isVerified = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await resolveContactVerification({
      contacts: [contact('c1', 'u1')],
      memberId: 'm1',
      isVerified,
      logger,
      errKind,
    });
    expect(res.pending.has('c1')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'contact_verification_threw' }),
      expect.any(String),
    );
  });
});
