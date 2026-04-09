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
  hash(plaintext: string): Promise<string>;
  verify(hashed: string, plaintext: string): Promise<boolean>;
  /**
   * Run a verify against a dummy hash. Used by the sign-in use case
   * when no user matches the supplied email so the response time is
   * indistinguishable from a wrong-password verify.
   */
  verifyDummy(suppliedPassword: string): Promise<void>;
}

class Argon2Hasher implements PasswordHasher {
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  async verify(hashed: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(hashed, plaintext);
    } catch {
      // verify throws if the hash string is malformed (corrupted DB row,
      // legacy format). Treat that as authentication failure rather than
      // crashing the server.
      return false;
    }
  }

  async verifyDummy(suppliedPassword: string): Promise<void> {
    const dummy = await getDummyHash();
    // Result deliberately ignored; we only care that the verification
    // CPU cost was paid.
    await verify(dummy, suppliedPassword).catch(() => false);
  }
}

export const argon2Hasher: PasswordHasher = new Argon2Hasher();
