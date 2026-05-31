/**
 * argon2id password hasher (T035, research.md § 3, security.md T-03).
 *
 * Parameters per OWASP Password Storage Cheat Sheet 2024:
 *   memoryCost: 19 456 KiB (~19 MB)
 *   timeCost:   2 iterations
 *   parallelism: 1
 *   hashLength: 32 bytes
 *   algorithm:  argon2id
 *
 * Targets ~50 ms per verify on a Vercel Serverless Function — fits in
 * the auth API p95 < 400 ms budget with headroom.
 *
 * **Timing-constant unknown-email path** (security.md T-03):
 *
 * The sign-in use case (T068) calls `verify(DUMMY_HASH, suppliedPassword)`
 * when no user is found, instead of returning early. This makes the
 * unknown-email and known-email-wrong-password code paths take the same
 * amount of time, defeating user enumeration via timing side-channel.
 *
 * `DUMMY_HASH` is generated lazily on first use because:
 *   1. Hardcoding a hash in source code is fragile (parameters change).
 *   2. Bundling a precomputed hash leaks the exact OWASP parameters.
 *   3. Lazy generation costs ~50 ms once on the first sign-in attempt
 *      after a cold start; every subsequent attempt reuses the cache.
 */
import { hash, verify } from '@node-rs/argon2';
import {
  asPasswordHash,
  type PasswordHash,
} from '@/modules/auth/domain/branded';
import { logger } from '@/lib/logger';
// S1-P1-13: `MalformedHashError` moved to the Application layer (use-cases
// inspect it; Principle III forbids them importing an Infrastructure VALUE).
// The hasher throws it + re-exports it here for existing consumers/tests.
import { MalformedHashError } from '@/modules/auth/application/password-errors';

/**
 * B4 (post-ship 2026-05-17) — typed error thrown by `verify` when the
 * stored hash is malformed (corrupted row, legacy format, encoding
 * drift). Distinct from a return-value `false` (which means the user
 * typed the wrong password). Sign-in catches this specifically to
 * skip the `incrementFailedCount` + lockout-trigger path — otherwise
 * a DB corruption issue would lock the legitimate user out and the
 * audit trail would read "user kept entering wrong password",
 * misleading operators. Definition now in `application/password-errors.ts`.
 */
export { MalformedHashError };

// `@node-rs/argon2` exports `Algorithm` as an ambient const enum which
// trips Next.js' `isolatedModules: true`. We use the literal value:
//   Argon2d  = 0
//   Argon2i  = 1
//   Argon2id = 2
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  algorithm: ARGON2ID,
} as const;

let dummyHashPromise: Promise<string> | null = null;

async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hash('dummy_password_for_timing_constant_signin', ARGON2_OPTIONS);
  }
  return dummyHashPromise;
}

export interface PasswordHasher {
  /**
   * Compute an argon2id hash of the supplied plaintext. The returned
   * value is branded as `PasswordHash` so callers can't accidentally
   * swap the (hashed, plaintext) arguments in `verify()` — that
   * mistake would authenticate every wrong password, so the type
   * system enforces the ordering.
   */
  hash(plaintext: string): Promise<PasswordHash>;
  /**
   * Returns `true` if `plaintext` matches `hashed`, `false` if the
   * password is simply wrong. **THROWS `MalformedHashError`** if the
   * stored hash is corrupted (legacy format, encoding drift, DB
   * tamper). Callers in sign-in / change-password MUST catch the
   * typed error specifically — both currently emit a dedicated
   * `password_malformed_hash_detected` audit and skip the
   * failedSignInCount/lockout path so a DB-corruption incident does
   * NOT lock out the legitimate user. See B4 in
   * review-20260517-post-ship-hardening.md.
   */
  verify(hashed: PasswordHash, plaintext: string): Promise<boolean>;
  /**
   * Run a verify against a dummy hash. Used by the sign-in use case
   * when no user matches the supplied email so the response time is
   * indistinguishable from a wrong-password verify.
   */
  verifyDummy(suppliedPassword: string): Promise<void>;
}

class Argon2Hasher implements PasswordHasher {
  async hash(plaintext: string): Promise<PasswordHash> {
    return asPasswordHash(await hash(plaintext, ARGON2_OPTIONS));
  }

  async verify(hashed: PasswordHash, plaintext: string): Promise<boolean> {
    try {
      return await verify(hashed, plaintext);
    } catch (error) {
      // B4 (post-ship 2026-05-17) — promote the malformed-hash signal
      // to a typed error so the caller (sign-in) can skip the
      // failedSignInCount + lockout path. Pre-B4 this branch swallowed
      // the error and returned false, which made the sign-in flow
      // take the wrong-password branch — eventually locking the
      // legitimate user out because of a DB-corruption issue, with an
      // audit trail that misled operators into thinking the user
      // kept typing wrong passwords. Log at ERROR (not WARN) so it
      // crosses the default alerting threshold; the audit event in
      // sign-in completes the 5-year forensic trail.
      logger.error({ err: error }, 'argon2.verify.malformed_hash');
      throw new MalformedHashError(error);
    }
  }

  async verifyDummy(suppliedPassword: string): Promise<void> {
    const dummy = await getDummyHash();
    // Result deliberately ignored; we only care that the verification
    // CPU cost was paid. A native argon2 crash on this path (memory
    // pressure, native-module failure) still must not break the
    // sign-in flow — the timing equality invariant degrades to
    // "no hash ran" which only matters if it happens on every call,
    // and a warn log makes that observable to the oncall dashboard.
    await verify(dummy, suppliedPassword).catch((error: unknown) => {
      logger.warn({ err: error }, 'argon2.verifyDummy.failed');
      return false;
    });
  }
}

export const argon2Hasher: PasswordHasher = new Argon2Hasher();
