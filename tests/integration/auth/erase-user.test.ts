/**
 * UserRepo.anonymiseErasedInTx — live-Neon integration (COMP-1 US2a).
 *
 * The actual `users`-row anonymisation UPDATE that underpins F1 linked-user
 * erasure (GDPR Art.17 / PDPA §33). Tested DIRECTLY against live Neon in an
 * owner-role `db.transaction` (the `users` table is cross-tenant — no
 * `tenant_id`, no RLS — so it runs outside a `runInTenant` chain, mirroring
 * `delete-invited-user.ts`).
 *
 * Oracle: email → a globally-unique non-routable sentinel
 * (`erased+{userId}@erased.invalid`, lower-cased to survive the functional
 * `lower(email)` unique index), password_hash → NULL, display_name → '[erased]',
 * status → 'disabled'. Idempotent: the sentinel is computed from the id, so a
 * re-run produces the byte-identical row with no unique-index violation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog, sessions, users } from '@/modules/auth/infrastructure/db/schema';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import {
  asEmailAddress,
  asResetTokenId,
  asUserId,
  type ResetTokenId,
} from '@/modules/auth/domain/branded';
import { eraseUser } from '@/modules/auth/application/erase-user';
import { signIn } from '@/modules/auth/application/sign-in';
import {
  defaultForgotPasswordDeps,
  forgotPassword,
} from '@/modules/auth/application/forgot-password';
import {
  defaultResetPasswordDeps,
  resetPassword,
} from '@/modules/auth/application/reset-password';
import { ok } from '@/lib/result';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

// Stub email sender so the forgot-password leg never touches Resend.
const stubEmailSender = {
  send: async () => ok({ messageId: 'stub' }),
};

// No-op rate limiter so successive use-case calls don't hit the shared
// Upstash bucket (mirrors tests/integration/auth/password-reset.test.ts).
const unlimitedLimiter = {
  check: async () => ({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
  peek: async () => ({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
};

/**
 * Captures the plaintext reset token the use case hands to the email
 * builder — the test-only seam from password-reset.test.ts (E2: the
 * token is hashed at rest, so the integration test cannot recover the
 * plaintext from the DB row; it must intercept it on the way out).
 */
function makeCapturingEmailBuilder() {
  let capturedPlaintext: string | null = null;
  const builder = (input: { token: string; toEmail: string; locale?: string }) => {
    capturedPlaintext = input.token;
    return {
      subject: 'test',
      html: `<a href="https://example.test/${input.token}">reset</a>`,
      text: `reset: ${input.token}`,
    };
  };
  return {
    builder,
    getPlaintext: (): ResetTokenId => {
      if (!capturedPlaintext) {
        throw new Error('plaintext not captured — was buildResetPasswordEmail called?');
      }
      return asResetTokenId(capturedPlaintext);
    },
  };
}

/** Raw row read — bypasses the Domain mapper so we assert the persisted values. */
async function rawSelectUser(userId: string) {
  const rows = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      displayName: users.displayName,
      status: users.status,
      emailVerified: users.emailVerified,
      requiresPasswordReset: users.requiresPasswordReset,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0];
}

/** Raw count of live session rows for a user (post-erasure should be 0). */
async function rawSelectSessions(userId: string) {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

/**
 * Raw read of every audit row targeting `userId`, newest first. Selects the
 * full set of columns the no-PII oracle inspects (event_type + summary +
 * actor) so `JSON.stringify(rows)` covers all stored text in the assertion.
 */
async function rawSelectAuditByTarget(userId: string) {
  return db
    .select({
      eventType: auditLog.eventType,
      summary: auditLog.summary,
      actorUserId: auditLog.actorUserId,
      targetUserId: auditLog.targetUserId,
    })
    .from(auditLog)
    .where(eq(auditLog.targetUserId, userId))
    .orderBy(sql`${auditLog.timestamp} DESC`);
}

describe('UserRepo.anonymiseErasedInTx (live Neon)', () => {
  const created: TestUser[] = [];

  afterEach(async () => {
    for (const u of created.splice(0)) await deleteTestUser(u);
  });

  it('anonymises email→sentinel, NULLs password, name→[erased], disables', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);
    // Seed a real display name so the scrub-to-'[erased]' is observable
    // (createActiveTestUser leaves display_name NULL).
    await db
      .update(users)
      .set({ displayName: 'Anders Svensson' })
      .where(eq(users.id, user.userId));

    const result = await db.transaction((tx) =>
      userRepo.anonymiseErasedInTx(tx, user.userId),
    );
    expect(result.erased).toBe(true);

    const row = await rawSelectUser(user.userId);
    expect(row?.email).toBe(`erased+${user.userId}@erased.invalid`);
    expect(row?.passwordHash).toBeNull();
    expect(row?.displayName).toBe('[erased]');
    expect(row?.status).toBe('disabled');
    expect(row?.emailVerified).toBe(false);
    expect(row?.requiresPasswordReset).toBe(false);
  });

  it('is idempotent — a second run keeps the same sentinel (no unique-index error)', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);

    const first = await db.transaction((tx) =>
      userRepo.anonymiseErasedInTx(tx, user.userId),
    );
    expect(first.erased).toBe(true);

    const second = await db.transaction((tx) =>
      userRepo.anonymiseErasedInTx(tx, user.userId),
    );
    expect(second.erased).toBe(true);

    const row = await rawSelectUser(user.userId);
    expect(row?.email).toBe(`erased+${user.userId}@erased.invalid`);
    expect(row?.status).toBe('disabled');
  });

  it('returns erased:false when the user row does not exist', async () => {
    const result = await db.transaction((tx) =>
      userRepo.anonymiseErasedInTx(
        tx,
        asUserId('00000000-0000-0000-0000-000000000000'),
      ),
    );
    expect(result.erased).toBe(false);
  });
});

/**
 * Cross-flow: erasure → re-authentication blocked (COMP-1 US2a, security
 * review). The unit/contract suites mock the use cases, so the only proof
 * that an erased login row can never re-authenticate lives here, against
 * live Neon, calling the REAL `signIn` / `resetPassword` use cases.
 *
 * RED-meaningful: the seeded user CAN sign in (active + email_verified) and
 * a reset token issued before erasure WOULD redeem — these cases fail purely
 * because `anonymiseErasedInTx` rewrote the email to the sentinel (no row
 * resolves by the old email) and flipped status → 'disabled'. If either guard
 * regressed, these assertions would flip to success and fail the test.
 */
describe('erased user cannot re-authenticate (live Neon)', () => {
  const created: TestUser[] = [];

  afterEach(async () => {
    for (const u of created.splice(0)) await deleteTestUser(u);
  });

  it('sign-in with the OLD email + original password fails after erasure', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);

    // Sanity: the seed CAN sign in before erasure — proves the post-erasure
    // failure below is caused by erasure, not by a pre-existing block.
    const before = await signIn({
      email: user.rawEmail,
      password: user.password,
      portal: 'member',
      sourceIp: '203.0.113.40',
      requestId: `it-erase-presignin-${Date.now()}`,
    });
    expect(before.ok).toBe(true);

    await db.transaction((tx) => userRepo.anonymiseErasedInTx(tx, user.userId));

    // After erasure the old email no longer resolves to any row → the
    // unknown-email branch returns invalid-credentials (FR-016 generic).
    const after = await signIn({
      email: user.rawEmail,
      password: user.password,
      portal: 'member',
      sourceIp: '203.0.113.40',
      requestId: `it-erase-postsignin-${Date.now()}`,
    });
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe('invalid-credentials');
  });

  it('a reset token issued BEFORE erasure cannot set a new password', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);

    // 1. Issue a real, currently-valid reset token (pre-erasure).
    const capture = makeCapturingEmailBuilder();
    const forgot = await forgotPassword(
      {
        email: user.rawEmail,
        sourceIp: '203.0.113.41',
        requestId: `it-erase-forgot-${Date.now()}`,
      },
      {
        ...defaultForgotPasswordDeps,
        email: stubEmailSender,
        limiter: unlimitedLimiter as never,
        buildResetPasswordEmail: capture.builder as never,
      },
    );
    expect(forgot.ok).toBe(true);
    const token = capture.getPlaintext();

    // 2. Erase the login row — status flips to 'disabled'.
    await db.transaction((tx) => userRepo.anonymiseErasedInTx(tx, user.userId));

    // 3. Redeem the pre-erasure token → reset-password.ts:171 rejects because
    //    the user is no longer 'active' (link-invalid). The password cannot
    //    be reset, so the erased account stays unreachable.
    const redeem = await resetPassword(
      {
        token,
        newPassword: `Erased-${Date.now()}-Xy!2026`,
        sourceIp: '203.0.113.41',
        requestId: `it-erase-redeem-${Date.now()}`,
      },
      { ...defaultResetPasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(redeem.ok).toBe(false);
    if (redeem.ok) return;
    expect(redeem.error.code).toBe('link-invalid');

    // The password_hash stays NULL (the scrub nulled it; the rejected redeem
    // never wrote a new one) — defence-in-depth, no live credential remains.
    const rows = await db
      .select({ passwordHash: users.passwordHash, status: users.status })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    expect(rows[0]?.passwordHash).toBeNull();
    expect(rows[0]?.status).toBe('disabled');
  });
});

/**
 * The `eraseUser` USE CASE end-to-end on live Neon (COMP-1 US2a — Task 4).
 *
 * The blocks above exercise the repo method (`anonymiseErasedInTx`) and the
 * cross-flow re-auth guards directly. This block proves the FULL use case
 * works against real Neon: the real `db.transaction`, the real session
 * revoke, AND a real `user_erased` audit INSERT — which doubles as proof that
 * migration 0222 (`ALTER TYPE audit_event_type ADD VALUE 'user_erased'`)
 * applied: a missing enum value would throw `invalid input value for enum` on
 * the audit INSERT and fail the test (complementary to the completeness
 * round-trip in tests/integration/audit/completeness.test.ts).
 *
 * Calls `eraseUser(...)` with the DEFAULT deps (no stubs) so every wire — repo,
 * session repo, audit repo — is the production singleton.
 */
describe('eraseUser use-case (live Neon)', () => {
  const created: TestUser[] = [];

  afterEach(async () => {
    for (const u of created.splice(0)) await deleteTestUser(u);
  });

  it('after eraseUser: no login-resolvable identity, sessions revoked, user_erased audit (no PII)', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);
    // Seed a real display name (createActiveTestUser leaves it NULL) so the
    // no-PII audit assertion has a name that COULD leak if the summary echoed
    // the row — it must not appear in any stored audit text.
    await db
      .update(users)
      .set({ displayName: 'Login User' })
      .where(eq(users.id, user.userId));
    // Seed ≥1 live session so the revoke has something to delete.
    await sessionRepo.create({
      userId: user.userId,
      sourceIp: '203.0.113.50',
      now: new Date(),
    });
    const sessionsBefore = await rawSelectSessions(user.userId);
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(1);

    // --- Act: the real use case, default (production) deps ---
    const res = await eraseUser({
      userId: user.userId,
      actorUserId: 'admin-it',
      requestId: `it-erase-usecase-${Date.now()}`,
      sourceIp: null,
    });

    // 1. Result = ok({ erased: true }).
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.erased).toBe(true);

    // 2. No login-resolvable identity.
    //    (a) The row is anonymised + disabled.
    const row = await rawSelectUser(user.userId);
    expect(row?.email).toBe(`erased+${user.userId}@erased.invalid`);
    expect(row?.passwordHash).toBeNull();
    expect(row?.displayName).toBe('[erased]');
    expect(row?.status).toBe('disabled');
    expect(row?.emailVerified).toBe(false);
    //    (b) The ORIGINAL email no longer resolves to any login row — the
    //        same lookup sign-in uses (lower(email) match).
    const byOldEmail = await userRepo.findByEmail(asEmailAddress(user.rawEmail));
    expect(byOldEmail).toBeNull();

    // 3. Sessions revoked — 0 rows for the user.
    const sessionsAfter = await rawSelectSessions(user.userId);
    expect(sessionsAfter).toHaveLength(0);

    // 4. A `user_erased` audit row exists (proves migration 0222 applied) and
    //    carries NO PII (no '@', no display name, no original email).
    const audits = await rawSelectAuditByTarget(user.userId);
    const erasedAudits = audits.filter((a) => a.eventType === 'user_erased');
    expect(erasedAudits.length).toBeGreaterThanOrEqual(1);
    const erased = erasedAudits[0];
    expect(erased?.targetUserId).toBe(user.userId);
    expect(erased?.summary).not.toContain('@');
    expect(erased?.summary).not.toContain('Login User');
    // Belt-and-suspenders: the original email appears nowhere in the audit row.
    expect(JSON.stringify(erasedAudits)).not.toContain(user.rawEmail);
  });

  it('is idempotent on the use case — a second call stays ok with the same scrub', async () => {
    const user = await createActiveTestUser('member');
    created.push(user);

    const first = await eraseUser({
      userId: user.userId,
      actorUserId: 'admin-it',
      requestId: `it-erase-idem-1-${Date.now()}`,
      sourceIp: null,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.erased).toBe(true);
    const afterFirst = await rawSelectUser(user.userId);

    // A second run on the already-erased row must NOT raise a unique-index
    // error (the sentinel is derived from the id) and must leave the scrub
    // values byte-identical. (The use case DOES emit a second `user_erased`
    // audit — the skip-re-emit lives at the eraseMember orchestration layer,
    // not here — so we assert ≥1 audit + no error, never "exactly one".)
    const second = await eraseUser({
      userId: user.userId,
      actorUserId: 'admin-it',
      requestId: `it-erase-idem-2-${Date.now()}`,
      sourceIp: null,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.erased).toBe(true);

    const afterSecond = await rawSelectUser(user.userId);
    expect(afterSecond?.email).toBe(`erased+${user.userId}@erased.invalid`);
    // Byte-identical scrub across both runs.
    expect(afterSecond).toEqual(afterFirst);

    const audits = await rawSelectAuditByTarget(user.userId);
    const erasedCount = audits.filter((a) => a.eventType === 'user_erased').length;
    expect(erasedCount).toBeGreaterThanOrEqual(1);
  });
});
