/**
 * Email-locale audit 2026-07-16 — the admin "re-send verification email" action
 * must render the email in the RECIPIENT's stored language
 * (`contact.preferredLanguage`), not a hardcoded English. The route used to pass
 * `locale: 'en'` unconditionally (self-documented follow-up), so a Thai/Swedish
 * member whose first verification failed always got the resend in English.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({} as never)),
}));

import {
  resendVerificationEmail,
  type ResendVerificationDeps,
  type ResendVerificationInput,
} from '@/modules/members/application/use-cases/resend-verification-email';
import type { ContactId } from '@/modules/members/domain/contact';

const CONTACT_ID = '22222222-2222-2222-2222-222222222222' as ContactId;
const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
const LINKED_USER_ID = 'usr-1';
const tenant = { slug: 'test-tenant' } as unknown as ResendVerificationDeps['tenant'];

function makeDeps(preferredLanguage: 'en' | 'th' | 'sv') {
  const enqueueInTx = vi.fn(async () => ok({ outboxRowId: 'outbox-1' }));
  const deps: ResendVerificationDeps = {
    tenant,
    contactRepo: {
      findById: vi.fn(async () =>
        ok({
          contactId: CONTACT_ID,
          memberId: MEMBER_ID,
          email: 'thai.member@example.com',
          firstName: 'สม',
          lastName: 'ชาย',
          preferredLanguage,
          linkedUserId: LINKED_USER_ID,
          isPrimary: true,
          removedAt: null,
        }),
      ),
    } as unknown as ResendVerificationDeps['contactRepo'],
    tokens: {
      invalidateActiveForUserInTx: vi.fn(async () => ok({ invalidatedCount: 0 })),
      insertInTx: vi.fn(async () => ok(undefined)),
    } as unknown as ResendVerificationDeps['tokens'],
    emails: { enqueueInTx } as unknown as ResendVerificationDeps['emails'],
    userEmails: {
      isEmailVerified: vi.fn(async () => ok(false)),
    } as unknown as ResendVerificationDeps['userEmails'],
    audit: {
      recordInTx: vi.fn(async () => ok(undefined)),
    } as unknown as ResendVerificationDeps['audit'],
    clock: { now: () => new Date('2026-07-16T00:00:00Z') },
  };
  return { deps, enqueueInTx };
}

beforeEach(() => vi.clearAllMocks());

describe('resendVerificationEmail — recipient locale (email-locale audit 2026-07-16)', () => {
  it('renders in the contact preferred language when no explicit locale is passed', async () => {
    const { deps, enqueueInTx } = makeDeps('th');
    const input: ResendVerificationInput = {
      contactId: CONTACT_ID,
      memberId: MEMBER_ID,
      actorUserId: 'admin-1',
      requestId: 'req-1',
      // locale intentionally omitted — the route no longer hardcodes 'en'.
    };

    const result = await resendVerificationEmail(deps, input);

    expect(result.ok).toBe(true);
    expect(enqueueInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'email_verification_resent', locale: 'th' }),
    );
  });

  it('an explicit locale still overrides the contact default', async () => {
    const { deps, enqueueInTx } = makeDeps('th');
    const input: ResendVerificationInput = {
      contactId: CONTACT_ID,
      memberId: MEMBER_ID,
      actorUserId: 'admin-1',
      requestId: 'req-1',
      locale: 'sv',
    };

    await resendVerificationEmail(deps, input);

    expect(enqueueInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ locale: 'sv' }),
    );
  });
});
