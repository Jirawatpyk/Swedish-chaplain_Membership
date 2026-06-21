/**
 * Unit test — `revertContactEmail` redemption guard for erased / disabled
 * users (COMP-1 US2a, M1 redemption-guard half).
 *
 * GAP M1: after a GDPR-Art.17 / PDPA §33 member erasure, a still-live 48h
 * `revert` token (holding the original email in plaintext) could be redeemed
 * → `revertContactEmail` restored the real email to `users.email` +
 * `contacts.email` and set `email_verified=true` — resurrecting erased PII.
 *
 * M1 closes it with defense-in-depth. This file tests the SECOND half — the
 * robust catch-all GUARD at redemption: `revertContactEmail` MUST refuse to
 * restore PII when the target login is `status='disabled'` (the erasure
 * sentinel state), returning a typed `not_found` (which the route renders as
 * link-invalid) and touching NEITHER `users.email` NOR `contacts.email`.
 *
 * The guard catches ANY stale token regardless of how it slipped past the
 * in-tx invalidation (belt-and-suspenders for a token created in an edge-cased
 * window). It runs INSIDE the revert tx, AFTER the FOR-UPDATE token re-fetch,
 * BEFORE any restore write.
 *
 * Mocked `runInTenant` (`@/lib/db`) invokes the fn with a bare `{}` tx — the
 * use case talks to ports only. Live-Neon end-to-end PII-resurrection proof
 * lives in the integration suite (erase-member-revert-token.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { revertContactEmail } from '@/modules/members/application/use-cases/revert-contact-email';
import type { RevertContactEmailDeps } from '@/modules/members/application/use-cases/revert-contact-email';

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: never) => unknown) => fn({} as never),
}));

type RevertStubDeps = RevertContactEmailDeps & {
  tokens: {
    findActiveByIdInTx: ReturnType<typeof vi.fn>;
    markConsumedInTx: ReturnType<typeof vi.fn>;
    invalidateActiveForUserInTx: ReturnType<typeof vi.fn>;
  };
  contactRepo: { updateEmailInTx: ReturnType<typeof vi.fn> };
  userEmails: {
    updateInTx: ReturnType<typeof vi.fn>;
    readStatusInTx: ReturnType<typeof vi.fn>;
  };
  sessions: { revokeAllForInTx: ReturnType<typeof vi.fn> };
  audit: { recordInTx: ReturnType<typeof vi.fn> };
};

const ACTIVE_REVERT_TOKEN = {
  tokenId: 'tok-1',
  tenantId: 't-1',
  contactId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  type: 'revert' as const,
  oldEmail: 'real.person@example.com',
  newEmail: 'changed@example.com',
  activatedAt: new Date('2026-06-16T00:00:00.000Z'),
  expiresAt: new Date('2026-06-19T00:00:00.000Z'),
};

function buildDeps(): RevertStubDeps {
  return {
    tenant: { slug: 't-1' },
    tokens: {
      findActiveByIdInTx: vi.fn(async () => ok(ACTIVE_REVERT_TOKEN)),
      markConsumedInTx: vi.fn(async () => ok(undefined)),
      invalidateActiveForUserInTx: vi.fn(async () =>
        ok({ invalidatedCount: 0 }),
      ),
    },
    contactRepo: {
      updateEmailInTx: vi.fn(async () => ok({ oldEmail: 'changed@example.com' })),
    },
    userEmails: {
      updateInTx: vi.fn(async () => ok({ oldEmail: 'changed@example.com' })),
      // Default: ACTIVE login (no erasure) — the happy path still restores.
      readStatusInTx: vi.fn(async () => ok({ status: 'active' as const })),
    },
    sessions: {
      revokeAllForInTx: vi.fn(async () => ok({ revokedCount: 0 })),
    },
    audit: { recordInTx: vi.fn(async () => ok(undefined)) },
    clock: { now: () => new Date('2026-06-17T00:00:00.000Z') },
  } as unknown as RevertStubDeps;
}

describe('revertContactEmail — erased/disabled-user redemption guard (COMP-1 US2a M1)', () => {
  it('REJECTS with not_found and restores NO PII when the target user is disabled (erased)', async () => {
    const deps = buildDeps();
    deps.userEmails.readStatusInTx = vi.fn(async () =>
      ok({ status: 'disabled' as const }),
    );

    const res = await revertContactEmail(deps, {
      tokenId: 'tok-1',
      requestId: 'req-1',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');

    // No PII restored on either side, no flags flipped, token NOT consumed by
    // a success path (the guard aborts the tx before any write).
    expect(deps.contactRepo.updateEmailInTx).not.toHaveBeenCalled();
    expect(deps.userEmails.updateInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('REJECTS with not_found when the target user row is gone (hard-deleted)', async () => {
    const deps = buildDeps();
    deps.userEmails.readStatusInTx = vi.fn(async () => ok(null));

    const res = await revertContactEmail(deps, {
      tokenId: 'tok-1',
      requestId: 'req-1',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
    expect(deps.userEmails.updateInTx).not.toHaveBeenCalled();
  });

  it('still restores for an ACTIVE login (guard does not over-block the happy path)', async () => {
    const deps = buildDeps();

    const res = await revertContactEmail(deps, {
      tokenId: 'tok-1',
      requestId: 'req-1',
    });

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(deps.userEmails.readStatusInTx).toHaveBeenCalled();
    expect(deps.contactRepo.updateEmailInTx).toHaveBeenCalled();
    expect(deps.userEmails.updateInTx).toHaveBeenCalled();
  });
});
