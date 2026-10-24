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
// P2 Wave-0 — forgotPassword now wraps invalidate + create in db.transaction.
// Mock it to invoke the callback with a dummy tx + return its result.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));

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
      // P2 Wave-0 — the use case now calls the tx-scoped variants inside
      // db.transaction (atomic invalidate + create).
      invalidateAllUnconsumedForUserInTx: vi.fn().mockResolvedValue(0),
      createResetInTx: vi.fn().mockResolvedValue({
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
    // 125 — inline by default; the route overrides with next/server `after`.
    defer: (task) => task(),
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

  // ── O8 (Round 3) — rate-limit branches ────────────────────────────
  // The integration test (`password-reset.test.ts`) exercises the
  // happy + email-failure paths. These two unit cases pin the
  // rate-limit branches so a refactor that drops the IP-bucket drain
  // or skips the limiter check fails CI fast (vs minutes on live
  // Neon + Upstash).

  it('malformed email drains the IP bucket and returns ok without email send', async () => {
    const limiterCheck = vi
      .fn()
      .mockResolvedValue({ success: true, reset: Date.now() + 3_600_000 });
    const emailSend = vi.fn();
    const deps = makeDeps({
      limiter: {
        check: limiterCheck,
        peek: vi.fn(),
      } as unknown as ForgotPasswordDeps['limiter'],
      email: { send: emailSend } as unknown as ForgotPasswordDeps['email'],
    });

    const result = await forgotPassword(
      {
        // not a valid email-address brand
        email: 'not-an-email',
        sourceIp: '203.0.113.99',
        requestId: 'req-malformed',
      },
      deps,
    );

    // Enumeration safety — still ok.
    expect(result.ok).toBe(true);

    // IP bucket WAS drained (exactly once, with the IP key).
    expect(limiterCheck).toHaveBeenCalledTimes(1);
    expect(limiterCheck).toHaveBeenCalledWith(
      'forgot:ip:203.0.113.99',
      10,
      60 * 60,
    );

    // No email lookup, no email send, no audit emit.
    expect(emailSend).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('returns rate-limited when the IP bucket is exhausted', async () => {
    const resetAt = Date.now() + 7200_000;
    const limiterCheck = vi
      .fn()
      // First call (email bucket) succeeds, second call (IP bucket)
      // exhausted.
      .mockResolvedValueOnce({ success: true, reset: resetAt })
      .mockResolvedValueOnce({ success: false, reset: resetAt });
    const emailSend = vi.fn();
    const deps = makeDeps({
      limiter: {
        check: limiterCheck,
        peek: vi.fn(),
      } as unknown as ForgotPasswordDeps['limiter'],
      email: { send: emailSend } as unknown as ForgotPasswordDeps['email'],
    });

    const result = await forgotPassword(
      {
        email: FAKE_EMAIL,
        sourceIp: '203.0.113.99',
        requestId: 'req-ip-exhausted',
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rate-limited');
    expect(result.error.retryAfterSeconds).toBeGreaterThan(0);

    // Limiter called twice (email + IP); user lookup + email send NOT
    // called (early-return short-circuit preserves Resend quota when
    // the bucket says no).
    expect(limiterCheck).toHaveBeenCalledTimes(2);
    expect(emailSend).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  // 125 — the WHOLE active-user branch (token tx + email + audit) runs in
  // `deps.defer` (the route wires next/server `after`), so a registered
  // address does no awaited work an unknown one skips (FR-016 timing).
  it('hands the token tx, email send and audit to deps.defer instead of awaiting them', async () => {
    const deferred: Array<() => Promise<void>> = [];
    const deps = makeDeps({
      defer: (task) => {
        deferred.push(task);
      },
    });

    const result = await forgotPassword(
      { email: FAKE_EMAIL, sourceIp: '203.0.113.7', requestId: 'req-deferred' },
      deps,
    );

    expect(result.ok).toBe(true);
    // Nothing beyond the lookup ran before the response.
    expect(deps.tokens.invalidateAllUnconsumedForUserInTx).not.toHaveBeenCalled();
    expect(deps.tokens.createResetInTx).not.toHaveBeenCalled();
    expect(deps.email.send).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    await deferred[0]!();
    expect(deps.tokens.createResetInTx).toHaveBeenCalledOnce();
    expect(deps.email.send).toHaveBeenCalledOnce();
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'password_reset_requested' }),
    );
  });

  it('an unknown email never reaches deps.defer', async () => {
    const defer = vi.fn();
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue(null),
      } as unknown as ForgotPasswordDeps['users'],
      defer,
    });
    const result = await forgotPassword(
      { email: FAKE_EMAIL, sourceIp: '203.0.113.9', requestId: 'req-unknown-defer' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(defer).not.toHaveBeenCalled();
  });

  it('a throw inside the deferred task (token tx included) is logged, not propagated', async () => {
    const { logger } = await import('@/lib/logger');
    const deferred: Array<() => Promise<void>> = [];
    const deps = makeDeps({
      tokens: {
        invalidateAllUnconsumedForUserInTx: vi.fn().mockRejectedValue(new TypeError('neon down')),
        createResetInTx: vi.fn(),
      } as unknown as ForgotPasswordDeps['tokens'],
      defer: (task) => {
        deferred.push(task);
      },
    });

    await forgotPassword(
      { email: FAKE_EMAIL, sourceIp: '203.0.113.8', requestId: 'req-deferred-throw' },
      deps,
    );

    await expect(deferred[0]!()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'TypeError', requestId: 'req-deferred-throw' }),
      'forgot_password.deferred_failed',
    );
    expect(deps.email.send).not.toHaveBeenCalled();
  });
});
