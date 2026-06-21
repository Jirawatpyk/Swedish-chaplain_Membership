/**
 * H3 (code-review) — ADAPTER unit: `listLinkedUserIdsForMemberInTx` must
 * THROW (not swallow to `[]`) when its underlying SELECT rejects.
 *
 * This is the discriminating regression net for the H3 fix. The method's
 * read drives the Art.17/PDPA §33 session/invitation revocation cascade
 * (erase-member.ts / Bug I-1) and the equivalent archive cascade
 * (archive-member.ts / US7). The OLD adapter wrapped the SELECT in a
 * `try/catch` that returned `[]` on any infra error — so a transient DB
 * failure (statement timeout / connection blip) looked identical to
 * "genuinely no linked users", silently skipping the cascade while the
 * scrub/status-flip still committed. The fix removes that catch so the
 * error propagates and the caller's atomic tx rolls back.
 *
 * We drive the real adapter method with a fake `tx` whose query chain
 * rejects — a clean stand-in for a DB read failure, with NO real
 * transaction to poison (so the assertion is unambiguous):
 *  - OLD swallowing adapter: resolves to `[]`        → this test is RED.
 *  - FIXED fail-loud adapter: rejects with the error → this test is GREEN.
 *
 * The happy-path SQL (filters `removed_at IS NULL`, returns the linked
 * users) is exercised against live Neon by
 * `tests/integration/members/erase-member-cascade.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import type { TenantTx } from '@/lib/db';
import type { MemberId } from '@/modules/members';

/**
 * A fake `tx` whose `select(...).from(...).where(...)` chain REJECTS when
 * awaited — mirrors the adapter's exact call shape:
 *   tx.select({ linkedUserId }).from(contacts).where(and(...))
 */
function makeRejectingTx(error: Error): TenantTx {
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  // `where` is the awaited terminal in the adapter — reject there.
  builder.where = vi.fn(() => Promise.reject(error));
  return { select: vi.fn(() => builder) } as unknown as TenantTx;
}

describe('drizzleContactRepo.listLinkedUserIdsForMemberInTx — fails loud (H3)', () => {
  it('propagates (rejects) when the SELECT errors, instead of swallowing to []', async () => {
    const dbError = new Error('57014 canceling statement due to statement timeout');
    const tx = makeRejectingTx(dbError);

    await expect(
      drizzleContactRepo.listLinkedUserIdsForMemberInTx(
        tx,
        'member-1' as unknown as MemberId,
      ),
    ).rejects.toThrow(dbError);
  });
});

/**
 * COMP-1 US2a — the UNFILTERED F1 erasure work-list read must share the SAME
 * fail-loud contract. It drives the post-commit F1 linked-login erasure
 * (erase-member.ts): a read failure swallowed to `[]` would skip a login that
 * FAILED to erase on a prior pass while `member_erased` was emitted as
 * "complete" → the erased member's credential survives (Art.17). The method
 * has NO try/catch, so a rejecting SELECT propagates and the caller's atomic
 * tx rolls back. The happy-path SQL (UNFILTERED by removed_at — survives the
 * contacts scrub) is exercised against live Neon by
 * `tests/integration/members/erase-member-linked-user-shadow.test.ts`.
 */
describe('drizzleContactRepo.listAllLinkedUserIdsForMemberInTx — fails loud (US2a)', () => {
  it('propagates (rejects) when the SELECT errors, instead of swallowing to []', async () => {
    const dbError = new Error('57014 canceling statement due to statement timeout');
    const tx = makeRejectingTx(dbError);

    await expect(
      drizzleContactRepo.listAllLinkedUserIdsForMemberInTx(
        tx,
        'member-1' as unknown as MemberId,
      ),
    ).rejects.toThrow(dbError);
  });
});

/**
 * COMP-1 US2a (L1 over-delete fix) — the LIVE-only contact-email read that
 * feeds the outbox cancel-set must share the SAME fail-loud contract. It is the
 * address-keyed input to the `DELETE … WHERE to_email IN (…)` outbox cancel; a
 * read failure swallowed to `[]` would skip the cancel under a falsely-
 * "complete" erasure, leaving a dispatchable post-erasure mail behind. The
 * method has NO try/catch, so a rejecting SELECT propagates and the caller's
 * atomic erasure tx rolls back. The happy-path SQL (filters `removed_at IS
 * NULL` so a removed contact's ambiguously-owned email is excluded) is
 * exercised against live Neon by
 * `tests/integration/members/erase-member-outbox-cancel.test.ts`.
 */
describe('drizzleContactRepo.listLiveEmailsForMemberInTx — fails loud (US2a)', () => {
  it('propagates (rejects) when the SELECT errors, instead of swallowing to []', async () => {
    const dbError = new Error('57014 canceling statement due to statement timeout');
    const tx = makeRejectingTx(dbError);

    await expect(
      drizzleContactRepo.listLiveEmailsForMemberInTx(
        tx,
        'member-1' as unknown as MemberId,
      ),
    ).rejects.toThrow(dbError);
  });
});
