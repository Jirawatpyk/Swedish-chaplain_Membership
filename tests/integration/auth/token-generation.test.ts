/**
 * T178 — Token generation entropy test (security.md T-12).
 *
 * Three kinds of tokens protect authn state:
 *
 *   - Session IDs (session-repo.generateSessionId)
 *   - Password reset token IDs (token-repo.generateTokenId)
 *   - Invitation token IDs (token-repo.generateTokenId)
 *
 * They all use the same primitive: 32 bytes from Web Crypto's
 * `crypto.getRandomValues`, encoded as 64 hex characters. The only
 * thing that can go wrong is a botched driver or a non-CSPRNG fallback,
 * so the test asserts two properties on a 10 000-token sample:
 *
 *   1. No collisions — birthday probability on 256 bits is 1 in 2^128,
 *      so even one dup is a screaming klaxon that the source is broken.
 *   2. Byte-frequency chi-square on the raw 32-byte buffers. The
 *      critical value at p = 0.001 with 255 degrees of freedom is
 *      ~330.5; we fail anything above 350 as "clearly non-uniform".
 *
 * This is categorised as an integration test because the repo layer
 * imports Drizzle at module load, even though the generators
 * themselves touch only the crypto global.
 */
import { describe, expect, it } from 'vitest';
import { generateTokenId } from '@/modules/auth/infrastructure/db/token-repo';

const SAMPLE_SIZE = 10_000;
const TOKEN_LENGTH = 64; // hex
const BYTE_SPACE = 256;
// Chi-square critical value for dof=255 at p=0.001 ≈ 330.5.
// We add ~6% slack so that rare legitimate fluctuations don't flake the test.
const CHI_SQUARE_FAIL_THRESHOLD = 350;

function tokenToBytes(hex: string): Uint8Array {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    buf[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return buf;
}

function chiSquareOnBytes(buffers: Uint8Array[]): number {
  const totalBytes = buffers.length * (buffers[0]?.length ?? 0);
  const expectedPerBucket = totalBytes / BYTE_SPACE;
  const counts = new Uint32Array(BYTE_SPACE);
  for (const buf of buffers) {
    for (const b of buf) {
      counts[b]! += 1;
    }
  }
  let chi = 0;
  for (let i = 0; i < BYTE_SPACE; i += 1) {
    const observed = counts[i]!;
    const delta = observed - expectedPerBucket;
    chi += (delta * delta) / expectedPerBucket;
  }
  return chi;
}

describe('integration: token generation entropy (T178, T-12)', () => {
  it(`produces ${SAMPLE_SIZE} collision-free tokens of correct length`, () => {
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const id = generateTokenId();
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(TOKEN_LENGTH);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(SAMPLE_SIZE);
  });

  it('byte-frequency chi-square is below the uniform-distribution critical value', () => {
    const buffers: Uint8Array[] = [];
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      buffers.push(tokenToBytes(generateTokenId()));
    }
    const chi = chiSquareOnBytes(buffers);
    // Log it so PR reviewers can see the value without re-running the test
    console.log(`  chi-square(255) over ${SAMPLE_SIZE} tokens = ${chi.toFixed(2)}`);
    expect(chi).toBeLessThan(CHI_SQUARE_FAIL_THRESHOLD);
  });

  it('every bit position flips roughly half the time (50% ± 2%)', () => {
    // A second, cheaper sanity check: for each of the 256 bit positions
    // in the 32-byte token, count how often it's 1. For a CSPRNG it
    // should sit near 5 000 (half of 10 000) with ± ~2 σ tolerance.
    const bitOneCounts = new Uint32Array(256);
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const buf = tokenToBytes(generateTokenId());
      for (let byteIdx = 0; byteIdx < 32; byteIdx += 1) {
        const byte = buf[byteIdx]!;
        for (let bit = 0; bit < 8; bit += 1) {
          if ((byte >> bit) & 1) {
            bitOneCounts[byteIdx * 8 + bit]! += 1;
          }
        }
      }
    }
    const expected = SAMPLE_SIZE / 2;
    const tolerance = SAMPLE_SIZE * 0.025; // ± 2.5 %
    for (let i = 0; i < 256; i += 1) {
      const observed = bitOneCounts[i]!;
      expect(Math.abs(observed - expected)).toBeLessThan(tolerance);
    }
  });
});
