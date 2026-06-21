/**
 * Unit — resendVerificationEmail erased/removed-contact guard
 * (COMP-1 PR-review, FIX A — GDPR Art.17 / PDPA §33 resurrection close).
 *
 * The pre-fix eligibility gate was ONLY `isEmailVerified(userId) === false →
 * proceed`. Member erasure (`eraseUser`) sets the linked login's
 * `email_verified = false`, which FLIPS THAT GATE ON for an erased member's
 * contact — so an admin hitting the route directly (UI button hidden because
 * the contact no longer renders post-erasure, but the route is reachable via a
 * stale tab) would mint a fresh verification token + enqueue an
 * `email_verification_resent` mail to the scrubbed sentinel address, leaving a
 * redeemable token on a `status='disabled'` login.
 *
 * The fix refuses immediately after the contact is loaded when the contact is
 * removed (`contact.removedAt != null`), BEFORE the linkedUser / isEmailVerified
 * checks and BEFORE any token-issue / outbox / audit work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

// runInTenant must NOT be invoked on the guarded path — wire it to a spy that
// would call its fn (so a regression that DID reach the tx is observable as a
// token-issue/outbox call), and assert it is never called.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({} as never),
  ),
}));

import {
  resendVerificationEmail,
  type ResendVerificationDeps,
  type ResendVerificationInput,
} from '@/modules/members/application/use-cases/resend-verification-email';
import type { ContactId } from '@/modules/members/domain/contact';
import { runInTenant } from '@/lib/db';

const CONTACT_ID = '22222222-2222-2222-2222-222222222222' as ContactId;
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const LINKED_USER_ID = 'usr-erased-1';

const tenant = { slug: 'test-tenant' } as unknown as ResendVerificationDeps['tenant'];

/**
 * A REMOVED contact that still carries a linkedUserId and whose linked login is
 * `email_verified = false` (exactly the post-erasure shape) — the pre-fix gate
 * would PASS this and proceed to issue a token.
 */
const erasedContact = {
  contactId: CONTACT_ID,
  memberId: MEMBER_ID,
  email: `erased+${CONTACT_ID}@erased.invalid`,
  firstName: '[erased]',
  lastName: '[erased]',
  preferredLanguage: 'en' as const,
  linkedUserId: LINKED_USER_ID,
  isPrimary: false,
  removedAt: new Date('2026-06-20T00:00:00Z'),
};

function makeDeps(): {
  deps: ResendVerificationDeps;
  tokens: {
    invalidateActiveForUserInTx: ReturnType<typeof vi.fn>;
    insertInTx: ReturnType<typeof vi.fn>;
  };
  emails: { enqueueInTx: ReturnType<typeof vi.fn> };
  audit: { recordInTx: ReturnType<typeof vi.fn> };
  isEmailVerified: ReturnType<typeof vi.fn>;
} {
  const invalidateActiveForUserInTx = vi.fn(async () =>
    ok({ invalidatedCount: 0 }),
  );
  const insertInTx = vi.fn(async () => ok(undefined));
  const enqueueInTx = vi.fn(async () => ok({ outboxRowId: 'outbox-1' }));
  const recordInTx = vi.fn(async () => ok(undefined));
  // The flipped gate: an erased login is email_verified=false → the pre-fix
  // path would treat it as "needs a resend".
  const isEmailVerified = vi.fn(async () => ok(false));

  const deps: ResendVerificationDeps = {
    tenant,
    contactRepo: {
      findById: vi.fn(async () => ok(erasedContact)),
    } as unknown as ResendVerificationDeps['contactRepo'],
    tokens: {
      invalidateActiveForUserInTx,
      insertInTx,
    } as unknown as ResendVerificationDeps['tokens'],
    emails: {
      enqueueInTx,
    } as unknown as ResendVerificationDeps['emails'],
    userEmails: {
      isEmailVerified,
    } as unknown as ResendVerificationDeps['userEmails'],
    audit: {
      recordInTx,
    } as unknown as ResendVerificationDeps['audit'],
    clock: { now: () => new Date('2026-06-21T00:00:00Z') },
  };
  return {
    deps,
    tokens: { invalidateActiveForUserInTx, insertInTx },
    emails: { enqueueInTx },
    audit: { recordInTx },
    isEmailVerified,
  };
}

const input: ResendVerificationInput = {
  contactId: CONTACT_ID,
  memberId: MEMBER_ID,
  actorUserId: 'admin-1',
  requestId: 'req-resend-1',
  locale: 'en',
};

beforeEach(() => vi.clearAllMocks());

describe('resendVerificationEmail — erased/removed-contact guard (FIX A)', () => {
  it('refuses a removed contact with not_eligible/contact_removed and does NOT touch the token/outbox path', async () => {
    const { deps, tokens, emails, audit, isEmailVerified } = makeDeps();

    const result = await resendVerificationEmail(deps, input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'not_eligible',
      reason: 'contact_removed',
    });

    // The dangerous path is never reached: no tx, no token mint, no outbox row,
    // no audit, and the flipped isEmailVerified gate is never even consulted
    // (the removed-contact guard short-circuits before it).
    expect(runInTenant).not.toHaveBeenCalled();
    expect(isEmailVerified).not.toHaveBeenCalled();
    expect(tokens.invalidateActiveForUserInTx).not.toHaveBeenCalled();
    expect(tokens.insertInTx).not.toHaveBeenCalled();
    expect(emails.enqueueInTx).not.toHaveBeenCalled();
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });
});
