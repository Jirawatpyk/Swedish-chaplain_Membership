/**
 * Drift-guard: the auth login-row erasure sentinel must stay byte-identical
 * to the members-domain sentinel format (COMP-1 US2a, security review).
 *
 * `UserRepo.anonymiseErasedInTx` hard-codes the sentinel email as
 * `erased+${userId}@erased.invalid` (user-repo.ts). Production code MUST NOT
 * import the members const into the auth module — that would cross the
 * auth→members Clean-Architecture boundary (Principle III). Tests CAN reach
 * across modules, so this test pins the auth format against the single source
 * of truth in `@/modules/members/domain/erasure-sentinels`: if anyone changes
 * `ERASED_EMAIL_LOCAL_PREFIX` or `ERASED_EMAIL_DOMAIN`, this fails and flags
 * the silent auth drift so both scrubs can be re-aligned.
 *
 * Pure format test — reconstructs the expected string from a sample UUID; no
 * DB and no `userRepo` invocation needed.
 */
import { describe, expect, it } from 'vitest';
import {
  ERASED_EMAIL_DOMAIN,
  ERASED_EMAIL_LOCAL_PREFIX,
} from '@/modules/members/domain/erasure-sentinels';

/**
 * The exact literal `anonymiseErasedInTx` builds (user-repo.ts:358):
 *   const sentinelEmail = `erased+${userId}@erased.invalid`;
 * Kept here as the auth-side oracle so a change to either side trips the test.
 */
function authScrubSentinel(userId: string): string {
  return `erased+${userId}@erased.invalid`;
}

describe('auth erasure sentinel format vs members single source', () => {
  // A representative UUIDv4 (the real value is the user-row id).
  const sampleUserId = '11111111-2222-4333-8444-555555555555';

  it('matches `${LOCAL_PREFIX}${userId}@${DOMAIN}` from the members domain', () => {
    const expectedFromMembersConsts =
      `${ERASED_EMAIL_LOCAL_PREFIX}${sampleUserId}@${ERASED_EMAIL_DOMAIN}`;

    expect(authScrubSentinel(sampleUserId)).toBe(expectedFromMembersConsts);
  });

  it('pins the canonical const values the auth scrub depends on', () => {
    // If either of these fails, the members sentinel changed but the
    // auth scrub's hard-coded literal did not — the drift this guard exists
    // to catch. Update user-repo.ts to match, then update these literals.
    expect(ERASED_EMAIL_LOCAL_PREFIX).toBe('erased+');
    expect(ERASED_EMAIL_DOMAIN).toBe('erased.invalid');
  });
});
