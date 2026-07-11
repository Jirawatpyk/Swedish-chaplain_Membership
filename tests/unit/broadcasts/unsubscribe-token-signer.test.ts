/**
 * Bug #8 (2026-07-10) — unsubscribe token no longer embeds the recipient's
 * plaintext email in the (readable) URL. The email is AES-256-GCM encrypted
 * (`emlEnc`) with a key derived from `UNSUBSCRIBE_TOKEN_SECRET`, so a reader
 * of a CDN/proxy/mail-scanner access log cannot recover it. `verify()` still
 * returns the decrypted `emailLower`, so no downstream consumer changes.
 * Legacy plaintext `eml` tokens (valid forever, FR-030) remain honoured.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import { env } from '@/lib/env';
import { unsubscribeTokenSigner } from '@/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { unsafeBrandTenantSlug } from '@/modules/tenants';

const tenantId = unsafeBrandTenantSlug('test-tenant');
const broadcastIdStr = '33333333-3333-3333-3333-333333333333';
const broadcastId = asBroadcastId(broadcastIdStr);
const email = 'alice@example.com';

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodePayloadSegment(token: string): Record<string, unknown> {
  const seg = token.split('.')[1]!;
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('unsubscribe token signer — bug #8 (no plaintext email in token URL)', () => {
  it('round-trips: sign → verify returns the same emailLower + tenant + lang', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId,
      broadcastId,
      emailLower: unsafeBrandEmailLower(email),
      lang: 'en',
    });
    const res = unsubscribeTokenSigner.verify(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.emailLower).toBe(email);
      expect(res.value.tenantId).toBe(tenantId);
      expect(res.value.lang).toBe('en');
    }
  });

  it('token payload does NOT contain the plaintext email (privacy / CHK024)', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId,
      broadcastId,
      emailLower: unsafeBrandEmailLower(email),
    });
    const rawDecoded = Buffer.from(
      token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(rawDecoded).not.toContain(email);
    expect(rawDecoded).not.toContain('alice');
    expect(rawDecoded).not.toContain('@');

    const parsed = decodePayloadSegment(token);
    expect(parsed['tid']).toBe(tenantId);
    expect(typeof parsed['emlEnc']).toBe('string');
    // New tokens NEVER carry the legacy plaintext claim.
    expect(parsed['eml']).toBeUndefined();
  });

  it('two tokens for the same email differ (random IV → not a stable tracking id)', () => {
    const t1 = unsubscribeTokenSigner.sign({
      tenantId,
      broadcastId,
      emailLower: unsafeBrandEmailLower(email),
    });
    const t2 = unsubscribeTokenSigner.sign({
      tenantId,
      broadcastId,
      emailLower: unsafeBrandEmailLower(email),
    });
    expect(t1).not.toBe(t2);
    // ...but both still resolve to the same email.
    const r1 = unsubscribeTokenSigner.verify(t1);
    const r2 = unsubscribeTokenSigner.verify(t2);
    expect(r1.ok && r2.ok && r1.value.emailLower === r2.value.emailLower).toBe(
      true,
    );
  });

  it('legacy plaintext `eml` token (pre-fix) still verifies (backward compat)', () => {
    const rawPayload = {
      v: 1,
      tid: tenantId,
      bid: broadcastIdStr,
      eml: email,
      lang: 'en',
      iat: 1_700_000_000,
    };
    const b64Payload = b64url(Buffer.from(JSON.stringify(rawPayload)));
    const mac = b64url(
      createHmac('sha256', env.broadcasts.unsubscribeTokenSecret)
        .update(b64Payload)
        .digest(),
    );
    const legacyToken = `v1.${b64Payload}.${mac}`;

    const res = unsubscribeTokenSigner.verify(legacyToken);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.emailLower).toBe(email);
  });

  it('tampered MAC fails closed (never yields a wrong email)', () => {
    const token = unsubscribeTokenSigner.sign({
      tenantId,
      broadcastId,
      emailLower: unsafeBrandEmailLower(email),
    });
    const [v, p, mac] = token.split('.') as [string, string, string];
    const tampered = `${v}.${p}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    const res = unsubscribeTokenSigner.verify(tampered);
    expect(res.ok).toBe(false);
  });
});
