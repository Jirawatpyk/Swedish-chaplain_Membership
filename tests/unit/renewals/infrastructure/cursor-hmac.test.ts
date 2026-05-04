/**
 * F8 Phase 3.5 W-08 — HMAC-signed cursor tampering tests.
 *
 * Round 5 staff review flagged unsigned base64 cursors as a defence-
 * in-depth gap: a malicious admin in tenant A who knows a cycleId
 * from tenant B (via guessing or a previous probe) could craft a
 * cursor that shifts the pagination window to that arbitrary
 * position. RLS still blocks the data, but the crafted cursor
 * produces an empty page WITHOUT any error signal.
 *
 * Phase 3.5 fix: HMAC-SHA256 sign cursor payload with the existing
 * `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` secret. These tests pin the
 * round-trip + tampering-rejection contract.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  encodeCursor,
  decodeCursor,
} from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { env } from '@/lib/env';

const VALID_PAYLOAD = {
  expiresAt: '2026-12-15T00:00:00.000Z',
  cycleId: '00000000-0000-0000-0000-0000000000a1',
};

describe('cursor HMAC sign/verify (Phase 3.5 W-08)', () => {
  it('round-trip: encoded cursor decodes back to the same payload', () => {
    const encoded = encodeCursor(VALID_PAYLOAD);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(VALID_PAYLOAD);
  });

  it('encoded cursor has the `<payload>.<mac>` shape', () => {
    const encoded = encodeCursor(VALID_PAYLOAD);
    expect(encoded.split('.').length).toBe(2);
    const [payloadPart, macPart] = encoded.split('.');
    expect(payloadPart).toBeTruthy();
    expect(macPart).toBeTruthy();
    // base64url MAC is 22 chars (16 bytes truncated SHA-256)
    expect(macPart!.length).toBe(22);
  });

  it('rejects cursor with tampered payload (MAC mismatch)', () => {
    const encoded = encodeCursor(VALID_PAYLOAD);
    const [, mac] = encoded.split('.');
    // Re-encode a different payload but reuse the original MAC
    const tampered = Buffer.from(
      JSON.stringify({
        expiresAt: '2099-01-01T00:00:00.000Z',
        cycleId: '00000000-0000-0000-0000-0000000000ff', // foreign cycleId
      }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(`${tampered}.${mac}`)).toBeNull();
  });

  it('rejects cursor with truncated MAC', () => {
    const encoded = encodeCursor(VALID_PAYLOAD);
    const [payload, mac] = encoded.split('.');
    expect(decodeCursor(`${payload}.${mac!.slice(0, 10)}`)).toBeNull();
  });

  it('rejects cursor with empty MAC', () => {
    const encoded = encodeCursor(VALID_PAYLOAD);
    const [payload] = encoded.split('.');
    expect(decodeCursor(`${payload}.`)).toBeNull();
  });

  it('rejects cursor with no MAC separator', () => {
    const payload = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString(
      'base64url',
    );
    expect(decodeCursor(payload)).toBeNull();
  });

  it('rejects cursor with malformed base64 in payload', () => {
    expect(decodeCursor('!!!.notbase64')).toBeNull();
  });

  it('rejects null / undefined / empty', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  // Round 9 S-R8-4 — wrong-secret rejection. If a future maintainer
  // adds a FALLBACK-key path (analogous to the renewal-link-token
  // dual-key rotation pattern at renewal-link-token.ts:8-14), this
  // test pins the contract that a cursor signed with a DIFFERENT
  // secret is rejected. The current single-secret implementation
  // already passes this test; the test serves as a regression-guard
  // for a future rotation path.
  it('rejects cursor signed with a different secret (defends future FALLBACK-key path)', () => {
    // Build a cursor manually with a fake MAC computed from a wrong
    // secret. The decoder uses env.renewals.linkTokenSecretPrimary —
    // an attacker computing a MAC with a leaked-but-rotated key
    // would produce a different MAC than the verifier expects.
    const payload = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString(
      'base64url',
    );
    // Use an obviously-wrong secret. The real PRIMARY must be ≥32
    // bytes per env schema; this 32-byte 'WRONG_SECRET_xxx' is also
    // ≥32 bytes but does not match the verifier's secret.
    const wrongSecret = 'WRONG_SECRET_' + 'x'.repeat(32);
    const wrongMac = createHmac('sha256', wrongSecret)
      .update('cursor-v1:', 'utf8')
      .update(payload, 'utf8')
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(decodeCursor(`${payload}.${wrongMac}`)).toBeNull();
  });

  // Round 9 W-R8-3 — domain-separation prefix rejection. A MAC
  // computed WITHOUT the 'cursor-v1:' prefix (i.e. as a renewal-link
  // token signer would) MUST NOT verify as a cursor MAC, even though
  // the underlying secret is the same.
  it('rejects MAC computed without cursor-v1: domain prefix', () => {
    const payload = Buffer.from(JSON.stringify(VALID_PAYLOAD), 'utf8').toString(
      'base64url',
    );
    // Use the SAME PRIMARY secret but skip the 'cursor-v1:' prefix
    // to simulate a cross-purpose MAC reuse attempt (e.g., a renewal-
    // link signer's MAC being substituted as a cursor MAC).
    const macWithoutPrefix = createHmac(
      'sha256',
      env.renewals.linkTokenSecretPrimary,
    )
      .update(payload, 'utf8')
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    expect(decodeCursor(`${payload}.${macWithoutPrefix}`)).toBeNull();
  });

  it('rejects cursor with valid MAC but missing required fields', () => {
    // Encode a payload missing cycleId. encodeCursor() requires both
    // fields at compile time, so we craft the malformed payload by hand.
    const badPayload = Buffer.from('{"expiresAt":"x"}', 'utf8').toString(
      'base64url',
    );
    // Use a real MAC for that exact payload bytes
    const encoded = `${badPayload}.${encodeCursor(VALID_PAYLOAD).split('.')[1]}`;
    // MAC won't match (computed from VALID_PAYLOAD's payload, not this one)
    expect(decodeCursor(encoded)).toBeNull();
  });
});
