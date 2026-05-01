/**
 * T140 / T141 — HMAC unsubscribe-token signer + verifier unit tests
 * (F7 US4).
 *
 * Verifies the security boundary of the public unsubscribe token:
 *   - Round-trip: sign(payload) → verify(token) returns the same payload.
 *   - Tampered MAC: byte-flipped MAC fails with `token.bad_signature`.
 *   - Tampered payload (post-sign): payload edit fails MAC check.
 *   - Wrong version prefix: returns `token.unsupported_version`.
 *   - Malformed token (not 3 parts): returns `token.malformed`.
 *   - Truncated/junk MAC: still returns `token.bad_signature` (constant-time
 *     compare guard; we don't leak length via timing-mismatch path).
 *   - `peekTokenTenantId` returns the tid WITHOUT verifying HMAC, but
 *     never accepts a structurally invalid token.
 *
 * NOTE: this test imports the signer through the module barrel rather
 * than the deep path so the ESLint barrel guard stays satisfied for the
 * test file (mirror of webhook-verifier test pattern).
 */
import { describe, expect, it } from 'vitest';

import {
  unsubscribeTokenSigner,
  peekTokenTenantId,
} from '@/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

const TENANT_ID = 'test-tenant';
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');
const recipient = unsafeBrandEmailLower('alice@example.com');

describe('unsubscribeTokenSigner.sign / verify', () => {
  it('round-trip preserves payload (tenantId, broadcastId, emailLower, lang)', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
      lang: 'th',
    });
    expect(token.startsWith('v1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);

    const result = unsubscribeTokenSigner.verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantId).toBe(TENANT_ID);
    expect(result.value.broadcastId).toBe(broadcastId);
    expect(result.value.emailLower).toBe(recipient);
    expect(result.value.lang).toBe('th');
  });

  it('round-trip omits lang when not provided', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const result = unsubscribeTokenSigner.verify(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lang).toBeUndefined();
  });

  it('byte-flipped MAC fails with token.bad_signature', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const [version, payload, mac] = token.split('.') as [string, string, string];
    // Flip the last char of the mac. base64url charset → predictable swap.
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    const tampered = `${version}.${payload}.${flipped}`;
    const result = unsubscribeTokenSigner.verify(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('token.bad_signature');
  });

  it('tampered payload (re-encoded JSON, original MAC) fails verification', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const [version, , mac] = token.split('.') as [string, string, string];
    // Forge a payload that claims a different tenant
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        tid: 'OTHER_TENANT',
        bid: broadcastId,
        eml: recipient,
        iat: 1,
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = unsubscribeTokenSigner.verify(`${version}.${forged}.${mac}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('token.bad_signature');
  });

  it('wrong version prefix returns token.unsupported_version', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const [, payload, mac] = token.split('.') as [string, string, string];
    const result = unsubscribeTokenSigner.verify(`v9.${payload}.${mac}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The HMAC is over the `payload` string regardless of version, so
    // the verifier first checks version (cheap) before MAC.
    expect(result.error.kind).toBe('token.unsupported_version');
  });

  it('malformed token (not 3 parts) returns token.malformed', () => {
    const result = unsubscribeTokenSigner.verify('v1.onlytwoparts');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('token.malformed');
  });

  it('empty token returns token.malformed', () => {
    const result = unsubscribeTokenSigner.verify('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('token.malformed');
  });

  it('truncated MAC returns token.bad_signature (no length leak via mismatch path)', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const [version, payload, mac] = token.split('.') as [string, string, string];
    const truncated = `${version}.${payload}.${mac.slice(0, -5)}`;
    const result = unsubscribeTokenSigner.verify(truncated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('token.bad_signature');
  });
});

describe('peekTokenTenantId', () => {
  it('returns tenantId WITHOUT verifying HMAC', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    expect(peekTokenTenantId(token)).toBe(TENANT_ID);
  });

  it('returns tid even on tampered MAC (peek precedes verify by design)', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId: TENANT_ID,
      broadcastId,
      emailLower: recipient,
    });
    const [version, payload] = token.split('.') as [string, string, string];
    const tampered = `${version}.${payload}.invalid_mac`;
    expect(peekTokenTenantId(tampered)).toBe(TENANT_ID);
  });

  it('returns null on structurally invalid token', () => {
    expect(peekTokenTenantId('not-a-token')).toBeNull();
    expect(peekTokenTenantId('v9.abc.def')).toBeNull();
    expect(peekTokenTenantId('')).toBeNull();
  });

  it('returns null on payload missing tid field', () => {
    const noTid = Buffer.from(
      JSON.stringify({ v: 1, bid: broadcastId, eml: recipient, iat: 1 }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(peekTokenTenantId(`v1.${noTid}.fakemac`)).toBeNull();
  });
});
