/**
 * G5 (Round 2, 2026-05-17) — `forgotPassword` use case unit tests.
 *
 * Primary purpose: pin the B5 `password_reset_email_failed` audit emit.
 * Pre-B5 the audit trail read as if the email had been sent when in
 * fact the Resend retry loop had exhausted. The audit emit is now
 * the operator forensic anchor.
 *
 * The integration test (`tests/integration/auth/password-reset.test.ts`)
 * covers the happy path end-to-end; this file isolates the Resend-
 * exhaustion branch so a refactor that drops the audit emit fails CI
 * in seconds (vs minutes-on-live-Neon).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  authMetrics: {
    passwordResetRequested: vi.fn(),
    redisFallback: vi.fn(),
    emailSendFailure: vi.fn(),
    emailSendDuration: vi.fn(),
    auditMissing: vi.fn(),
  },
}));
vi.mock('@/lib/auth-deps', () => ({ defaultForgotPasswordDeps: {} }));

import { forgotPassword } from '@/modules/auth/application/forgot-password';
import type { ForgotPasswordDeps } from '@/modules/auth/application/forgot-password';
import {
  asEmailAddress,
  asResetTokenId,
  asTokenId,
  asUserId,
} from '@/modules/auth/domain/branded';
import { ok, err } from '@/lib/result';

const USER_ID = asUserId('user-fp-001');
const NOW = new Date('2026-05-17T10:00:00Z');
const FAKE_EMAIL = 'forget@swecham.test';

function makeUser() {
  return {
    user: {
      id: USER_ID,
      email: asEmailAddress(FAKE_EMAIL),
      role: 'admin' as const,
      status: 'active' as const,
      createdAt: NOW,
      lastSignInAt: null,
      lastPasswordChangedAt: null,
      failedSignInCount: 0,
      lockedUntil: null,
      displayName: 'Forget Me Not',
      emailVerified: true,
      requiresPasswordReset: false,
    },
    passwordHash: null,
  };
}

function makeDeps(
  overrides: Partial<ForgotPasswordDeps> = {},
): ForgotPasswordDeps {
  return {
    users: {
      findByEmail: vi.fn().mockResolvedValue(makeUser()),
    } as unknown as ForgotPasswordDeps['users'],
    tokens: {
      invalidateAllUnconsumedForUser: vi.fn().mockResolvedValue(0),
      createReset: vi.fn().mockResolvedValue({
        plaintext: asResetTokenId('a'.repeat(64)),
        token: {
          id: asTokenId('b'.repeat(64)),
          userId: USER_ID,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
          consumedAt: null,
        },
      }),
    } as unknown as ForgotPasswordDeps['tokens'],
    audit: {
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as ForgotPasswordDeps['audit'],
    limiter: {
      check: vi
        .fn()
        .mockResolvedValue({ success: true, reset: Date.now() + 3_600_000 }),
      peek: vi
        .fn()
        .mockResolvedValue({ success: true, reset: Date.now() + 3_600_000 }),
    } as unknown as ForgotPasswordDeps['limiter'],
    email: {
      send: vi.fn().mockResolvedValue(ok({ messageId: 'stub-msg-id' })),
    } as unknown as ForgotPasswordDeps['email'],
    buildResetPasswordEmail: (() => ({
      subject: 'Reset your password',
      html: '<p>reset</p>',
      text: 'reset',
    })) as unknown as ForgotPasswordDeps['buildResetPasswordEmail'],
    now: () => NOW,
    ...overrides,
  };
}

describe('forgotPassword — B5 password_reset_email_failed emit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits password_reset_email_failed when Resend retry loop exhausts', async () => {
    const deps = makeDeps({
      email: {
        send: vi.fn().mockResolvedValue(
          err({ code: 'api_error' as const, message: 'Resend 503' }),
        ),
      } as unknown as ForgotPasswordDeps['email'],
    });

    const result = await forgotPassword(
      {
        email: FAKE_EMAIL,
        sourceIp: '203.0.113.42',
        requestId: 'req-resend-fail',
      },
      deps,
    );

    // Enumeration-safety: still ok response
    expect(result.ok).toBe(true);

    // B5 audit emit fires alongside the password_reset_requested row
    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_reset_email_failed');
    expect(auditCalls).toContain('password_reset_requested');

    const failedRow = vi
      .mocked(deps.audit.append)
      .mock.calls.find(
        (c) =>
          (c[0] as { eventType: string }).eventType ===
          'password_reset_email_failed',
      );
    expect(failedRow?.[0]).toMatchObject({
      actorUserId: USER_ID,
      targetUserId: USER_ID,
      requestId: 'req-resend-fail',
    });
  });

  it('does NOT emit password_reset_email_failed on the happy email-send path', async () => {
    const deps = makeDeps();

    const result = await forgotPassword(
      {
        email: FAKE_EMAIL,
        sourceIp: '203.0.113.42',
        requestId: 'req-happy',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).not.toContain('password_reset_email_failed');
    expect(auditCalls).toContain('password_reset_requested');
  });

  it('unknown email returns ok WITHOUT any audit emit (enumeration safety)', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue(null),
      } as unknown as ForgotPasswordDeps['users'],
    });

    const result = await forgotPassword(
      {
        email: 'ghost@swecham.test',
        sourceIp: '203.0.113.42',
        requestId: 'req-ghost',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.audit.append).not.toHaveBeenCalled();
  });
});
