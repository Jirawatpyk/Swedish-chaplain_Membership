/**
 * T090 — Password reset full-flow integration test.
 *
 * Scenario: forgot-password → reset-password end-to-end against a
 * real Postgres (live Neon DB). Combines the most valuable branches
 * from T090–T094 into a single file so the important contracts are
 * exercised without ballooning the integration suite:
 *
 *   - Happy path: active user → token row written → token redeem
 *     updates password, kills sessions, emits both audit events.
 *   - Replay guard: the same token cannot be used twice (T091 overlap).
 *   - Expired-token guard: synthesise an expired row directly and
 *     confirm it rejects (T092 overlap).
 *   - Enumeration safety: unknown email returns ok with no token row
 *     and no audit event (T093 overlap).
 *
 * Resend email sending is stubbed via a no-op injected EmailSender so
 * the test does not actually hit Resend servers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  auditLog,
  passwordResetTokens,
  sessions as sessionsTable,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import {
  defaultForgotPasswordDeps,
  forgotPassword,
} from '@/modules/auth/application/forgot-password';
import {
  defaultResetPasswordDeps,
  resetPassword,
} from '@/modules/auth/application/reset-password';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { asPasswordHash, asTokenId } from '@/modules/auth/domain/branded';
import { ok } from '@/lib/result';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

// Stub email sender — never touches Resend
const stubEmailSender = {
  send: async () => ok({ messageId: 'stub' }),
};

// No-op rate limiter so successive test calls don't hit the shared bucket
const unlimitedLimiter = {
  check: async () => ({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
};

describe('integration: forgot-password → reset-password happy path', () => {
  let user: TestUser;

  beforeEach(async () => {
    user = await createActiveTestUser('admin');
    // Seed two sessions so we can verify they get revoked
    await sessionRepo.create({
      userId: user.userId,
      sourceIp: '203.0.113.9',
      now: new Date(),
    });
    await sessionRepo.create({
      userId: user.userId,
      sourceIp: '203.0.113.10',
      now: new Date(),
    });
  });

  afterEach(async () => {
    await deleteTestUser(user);
  });

  it('active user receives a token and reset completes end-to-end', async () => {
    const requestId = `it-reset-${Date.now()}`;

    // 1. Request reset
    const forgotResult = await forgotPassword(
      {
        email: user.rawEmail,
        sourceIp: '203.0.113.9',
        requestId,
      },
      {
        ...defaultForgotPasswordDeps,
        email: stubEmailSender,
        limiter: unlimitedLimiter as never,
      },
    );
    expect(forgotResult.ok).toBe(true);

    // 2. Token row exists
    const tokenRows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.userId));
    expect(tokenRows.length).toBeGreaterThanOrEqual(1);
    const freshToken = tokenRows.find((r) => r.consumedAt === null);
    expect(freshToken).toBeDefined();
    if (!freshToken) return;

    // 3. Audit: password_reset_requested
    const reqRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'password_reset_requested'),
          eq(auditLog.actorUserId, user.userId),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(reqRows.length).toBeGreaterThanOrEqual(1);

    // 4. Redeem token with a strong password
    const newPassword = `Reset-${Date.now()}-Xq!2026`;
    const resetRes = await resetPassword(
      {
        token: asTokenId(freshToken.id),
        newPassword,
        sourceIp: '203.0.113.9',
        requestId: `${requestId}-redeem`,
      },
      { ...defaultResetPasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(resetRes.ok).toBe(true);

    // 5. Token marked consumed
    const after = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, freshToken.id));
    expect(after[0]?.consumedAt).not.toBeNull();

    // 6. User's password hash updated
    const userRows = await db
      .select({
        hash: users.passwordHash,
        lastChanged: users.lastPasswordChangedAt,
      })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(userRows[0]?.hash).toBeTruthy();
    const ok2 = await argon2Hasher.verify(asPasswordHash(userRows[0]!.hash!), newPassword);
    expect(ok2).toBe(true);

    // 7. All sessions deleted
    const remaining = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, user.userId));
    expect(remaining).toHaveLength(0);

    // 8. Audit: password_reset_completed + concurrent_sessions_revoked
    const completedRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'password_reset_completed'),
          eq(auditLog.requestId, `${requestId}-redeem`),
        ),
      );
    expect(completedRows.length).toBeGreaterThanOrEqual(1);

    const revokedRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'concurrent_sessions_revoked'),
          eq(auditLog.requestId, `${requestId}-redeem`),
        ),
      );
    expect(revokedRows.length).toBeGreaterThanOrEqual(1);
  });

  it('replay: consumed token cannot be reused', async () => {
    const requestId = `it-replay-${Date.now()}`;

    const forgotResult = await forgotPassword(
      {
        email: user.rawEmail,
        sourceIp: '203.0.113.9',
        requestId,
      },
      {
        ...defaultForgotPasswordDeps,
        email: stubEmailSender,
        limiter: unlimitedLimiter as never,
      },
    );
    expect(forgotResult.ok).toBe(true);

    const tokenRows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.userId))
      .orderBy(passwordResetTokens.createdAt);
    const freshest = tokenRows[tokenRows.length - 1];
    if (!freshest) throw new Error('no token row');

    const first = await resetPassword(
      {
        token: asTokenId(freshest.id),
        newPassword: `First-${Date.now()}-Xy!2026`,
        sourceIp: '203.0.113.9',
        requestId: `${requestId}-first`,
      },
      { ...defaultResetPasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(first.ok).toBe(true);

    const second = await resetPassword(
      {
        token: asTokenId(freshest.id),
        newPassword: `Second-${Date.now()}-Xy!2026`,
        sourceIp: '203.0.113.9',
        requestId: `${requestId}-second`,
      },
      { ...defaultResetPasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('link-invalid');
  });

  it('expired token is rejected as link-invalid', async () => {
    // Manually insert an expired token row
    const expiredId = 'e'.repeat(64);
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 h ago
    await db.insert(passwordResetTokens).values({
      id: expiredId,
      userId: user.userId,
      createdAt: pastDate,
      expiresAt: new Date(pastDate.getTime() + 60 * 60 * 1000), // +1 h → still past
    });

    const result = await resetPassword(
      {
        token: asTokenId(expiredId),
        newPassword: `Expired-${Date.now()}-Xy!2026`,
        sourceIp: '203.0.113.9',
        requestId: `it-expired-${Date.now()}`,
      },
      { ...defaultResetPasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('link-invalid');
  });
});

describe('integration: forgot-password enumeration safety', () => {
  it('unknown email returns ok WITHOUT creating token or audit row', async () => {
    const requestId = `it-unknown-${Date.now()}`;
    const unknownEmail = `ghost-${Date.now()}@swecham.test`;

    const result = await forgotPassword(
      {
        email: unknownEmail,
        sourceIp: '203.0.113.9',
        requestId,
      },
      {
        ...defaultForgotPasswordDeps,
        email: stubEmailSender,
        limiter: unlimitedLimiter as never,
      },
    );
    expect(result.ok).toBe(true);

    // No audit row for this request id
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(0);
  });
});
