/**
 * T036 — Argon2id hasher unit tests.
 *
 * Verifies the round-trip + the timing-constant dummy verify path.
 * The actual constant-time PROPERTY (≤ 5 ms p95 difference between
 * unknown-email and wrong-password sign-in) is asserted in
 * tests/integration/auth/enumeration-timing.test.ts (T057) under load,
 * not here.
 */
import { describe, expect, it, vi } from 'vitest';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { asPasswordHash } from '@/modules/auth/domain/branded';

// Stop the global setup from faking timers for this file — argon2 calls
// run inside native code that the fake clock can't drive.
vi.useRealTimers();

describe('argon2Hasher', () => {
  it('hash + verify round-trip succeeds for the same password', async () => {
    const hashed = await argon2Hasher.hash('correct horse battery staple');
    expect(hashed).toMatch(/^\$argon2id\$/);
    await expect(argon2Hasher.verify(hashed, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('verify rejects the wrong password', async () => {
    const hashed = await argon2Hasher.hash('letmein-2026');
    await expect(argon2Hasher.verify(hashed, 'wrongpassword')).resolves.toBe(false);
  });

  // B4 (post-ship 2026-05-17) — promoted malformed-hash to a typed
  // throw so sign-in can route the user to a dedicated audit event +
  // skip the failedSignInCount/lockout path. Pre-B4 this returned
  // false silently, conflating DB corruption with wrong-password.
  it('verify throws MalformedHashError on a malformed hash string', async () => {
    const { MalformedHashError } = await import(
      '@/modules/auth/infrastructure/password/argon2-hasher'
    );
    await expect(
      argon2Hasher.verify(asPasswordHash('not-a-real-hash'), 'anything'),
    ).rejects.toBeInstanceOf(MalformedHashError);
  });

  it('verifyDummy resolves without throwing for any input', async () => {
    await expect(argon2Hasher.verifyDummy('anything')).resolves.toBeUndefined();
    await expect(argon2Hasher.verifyDummy('')).resolves.toBeUndefined();
  });

  it('produces different hashes for the same plaintext (random salt)', async () => {
    const a = await argon2Hasher.hash('same-password');
    const b = await argon2Hasher.hash('same-password');
    expect(a).not.toBe(b);
    // But both verify against the original
    await expect(argon2Hasher.verify(a, 'same-password')).resolves.toBe(true);
    await expect(argon2Hasher.verify(b, 'same-password')).resolves.toBe(true);
  });
}, { timeout: 30_000 });
