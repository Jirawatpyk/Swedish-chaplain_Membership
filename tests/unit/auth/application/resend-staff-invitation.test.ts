/**
 * Unit tests for `resendStaffInvitation` use case (Staff Invitation
 * Lifecycle, Task 1).
 *
 * Thin Application wrapper around the shared F1 `reissueInvitation`
 * primitive. Emits `invitation_reissued` HERE — not inside
 * `reissueInvitation`, which F3's `resendBouncedInvite` also calls (member
 * portal invite resend). Emitting inside `reissueInvitation` would
 * double-audit that caller with a redundant event. `reissueInvitation`
 * owns its own tx and does not expose it (RA-8), so the audit append
 * happens via the non-tx `audit.append` AFTER `reissueInvitation` returns
 * ok — an accepted non-atomic edge that mirrors F3's
 * `member_portal_invite_queued` pattern. On any `reissueInvitation` error
 * the mapped error is returned WITHOUT auditing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Prevent the default deps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({
  defaultResendStaffInvitationDeps: {},
}));

import { resendStaffInvitation } from '@/modules/auth/application/resend-staff-invitation';
import type { ResendStaffInvitationDeps } from '@/modules/auth/application/resend-staff-invitation';
import { asUserId } from '@/modules/auth/domain/branded';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';
import { ok, err } from '@/lib/result';

const USER_ID = asUserId('11111111-1111-4111-8111-111111111111');
const ACTOR_ID = asUserId('22222222-2222-4222-8222-222222222222');

const input = {
  userId: USER_ID,
  actorUserId: ACTOR_ID,
  sourceIp: '203.0.113.5',
  requestId: 'req-resend-staff-1',
  tenantId: 'test-tenant' as TenantSlug,
};

type ResultLike = ReturnType<typeof ok> | ReturnType<typeof err>;

function makeDeps(
  reissueResult: ResultLike = ok({
    invitationId: 'tok_hash',
    email: 'a@b.co',
    role: 'admin',
  }),
): ResendStaffInvitationDeps {
  return {
    reissue: vi.fn().mockResolvedValue(reissueResult),
    audit: { append: vi.fn().mockResolvedValue(undefined) },
  } as unknown as ResendStaffInvitationDeps;
}

describe('resendStaffInvitation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path — reissues, audits invitation_reissued, returns ok {email}', async () => {
    const deps = makeDeps();
    const result = await resendStaffInvitation(input, deps);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ email: 'a@b.co' });

    expect(deps.reissue).toHaveBeenCalledTimes(1);
    expect(deps.reissue).toHaveBeenCalledWith({
      userId: USER_ID,
      invitedByUserId: ACTOR_ID,
      locale: undefined,
      tenantId: input.tenantId,
      requestId: input.requestId,
    });

    expect(deps.audit.append).toHaveBeenCalledTimes(1);
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'invitation_reissued',
        actorUserId: ACTOR_ID,
        targetUserId: USER_ID,
      }),
    );
  });

  it('passes a caller-supplied locale straight through to reissueInvitation', async () => {
    const deps = makeDeps();
    await resendStaffInvitation({ ...input, locale: 'th' }, deps);

    expect(deps.reissue).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'th' }),
    );
  });

  it('maps reissueInvitation not-pending error through, does NOT audit', async () => {
    const deps = makeDeps(err({ code: 'not-pending' }));
    const result = await resendStaffInvitation(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-pending');
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('maps reissueInvitation user-not-found error through, does NOT audit', async () => {
    const deps = makeDeps(err({ code: 'user-not-found' }));
    const result = await resendStaffInvitation(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('user-not-found');
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('maps reissueInvitation reissue-failed error through, does NOT audit', async () => {
    const deps = makeDeps(err({ code: 'reissue-failed' }));
    const result = await resendStaffInvitation(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('reissue-failed');
    expect(deps.audit.append).not.toHaveBeenCalled();
  });
});

/**
 * Regression guard: verify the bidirectional import cycle between auth-deps
 * and reissue-invitation is correctly wired. This must import the REAL
 * (unmocked) modules to detect breakage that typecheck cannot see.
 *
 * If this test fails, it indicates either:
 * - The `reissueInvitation` function was converted to a `const` arrow
 *   (TDZ error at runtime)
 * - The `defaultReissueInvitationDeps` is being read at module top level
 *   somewhere (creates a circular dependency error)
 * - The wiring of `defaultResendStaffInvitationDeps.reissue` is broken
 */
describe('resendStaffInvitation — bidirectional cycle guard', () => {
  it('defaultResendStaffInvitationDeps.reissue equals the real reissueInvitation', async () => {
    // Import the REAL modules (not mocked). vi.importActual bypasses any
    // mocks at the test level, returning the actual production code.
    const realAuthDeps = await vi.importActual<
      typeof import('@/lib/auth-deps')
    >('@/lib/auth-deps');
    const realReissueInvitation = await vi.importActual<
      typeof import('@/modules/auth/application/reissue-invitation')
    >('@/modules/auth/application/reissue-invitation');

    // Verify the cycle is wired: the `reissue` dep is the real function.
    expect(realAuthDeps.defaultResendStaffInvitationDeps.reissue).toBe(
      realReissueInvitation.reissueInvitation,
    );
  });
});
