/**
 * T037 spec — RenewalLinkToken payload + parser.
 */
import { describe, expect, it } from 'vitest';
import {
  RENEWAL_LINK_TOKEN_VERSION,
  RENEWAL_LINK_TOKEN_TTL_SECONDS,
  buildPayload,
  parsePayload,
  secondsUntilExpiry,
} from '@/modules/renewals/domain/renewal-link-token';

const NOW = new Date('2026-05-01T00:00:00Z');

describe('buildPayload', () => {
  it('produces canonical v=1 payload with iat + iat+TTL exp', () => {
    const p = buildPayload({
      tenantId: 'swecham',
      memberId: 'm1',
      cycleId: 'c1',
      now: NOW,
    });
    expect(p.v).toBe(RENEWAL_LINK_TOKEN_VERSION);
    expect(p.tid).toBe('swecham');
    expect(p.mid).toBe('m1');
    expect(p.cid).toBe('c1');
    expect(p.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(p.exp).toBe(p.iat + RENEWAL_LINK_TOKEN_TTL_SECONDS);
  });
});

describe('parsePayload — happy path', () => {
  it('accepts a fresh-built payload before expiry', () => {
    const p = buildPayload({
      tenantId: 'swecham',
      memberId: 'm1',
      cycleId: 'c1',
      now: NOW,
    });
    const r = parsePayload(p, { expectedTenantId: 'swecham', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tid).toBe('swecham');
      expect(r.value.mid).toBe('m1');
      expect(r.value.cid).toBe('c1');
    }
  });
});

describe('parsePayload — error paths', () => {
  const VALID_BASE = {
    v: 1,
    tid: 'swecham',
    mid: 'm1',
    cid: 'c1',
    iat: Math.floor(NOW.getTime() / 1000),
    exp: Math.floor(NOW.getTime() / 1000) + RENEWAL_LINK_TOKEN_TTL_SECONDS,
  };

  it('wrong version', () => {
    const r = parsePayload(
      { ...VALID_BASE, v: 2 },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('wrong_version');
  });

  it('missing tid', () => {
    const r = parsePayload(
      { ...VALID_BASE, tid: '' },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'missing_field') {
      expect(r.error.field).toBe('tid');
    }
  });

  it('missing mid', () => {
    const r = parsePayload(
      { ...VALID_BASE, mid: undefined },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'missing_field') {
      expect(r.error.field).toBe('mid');
    }
  });

  it('missing cid', () => {
    const r = parsePayload(
      { ...VALID_BASE, cid: undefined },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'missing_field') {
      expect(r.error.field).toBe('cid');
    }
  });

  it('non-numeric iat', () => {
    const r = parsePayload(
      { ...VALID_BASE, iat: NaN },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'missing_field') {
      expect(r.error.field).toBe('iat');
    }
  });

  it('non-numeric exp', () => {
    const r = parsePayload(
      { ...VALID_BASE, exp: 'tomorrow' },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'missing_field') {
      expect(r.error.field).toBe('exp');
    }
  });

  it('exp ≤ iat is malformed', () => {
    const r = parsePayload(
      { ...VALID_BASE, exp: VALID_BASE.iat - 1 },
      { expectedTenantId: 'swecham', now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('malformed_iat_exp');
  });

  it('tenant_mismatch when tid differs from expected', () => {
    const r = parsePayload(VALID_BASE, {
      expectedTenantId: 'other',
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'tenant_mismatch') {
      expect(r.error.expected).toBe('other');
      expect(r.error.got).toBe('swecham');
    }
  });

  it('expired when nowSec >= exp', () => {
    const futureNow = new Date(NOW.getTime() + 35 * 24 * 60 * 60 * 1000); // +35 days
    const r = parsePayload(VALID_BASE, {
      expectedTenantId: 'swecham',
      now: futureNow,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('expired');
  });
});

describe('secondsUntilExpiry', () => {
  it('counts down to expiration', () => {
    const p = buildPayload({
      tenantId: 't',
      memberId: 'm',
      cycleId: 'c',
      now: NOW,
    });
    expect(secondsUntilExpiry(p, NOW)).toBe(RENEWAL_LINK_TOKEN_TTL_SECONDS);
    // 1 hour later → 1 hour less remaining
    const oneHourLater = new Date(NOW.getTime() + 3600_000);
    expect(secondsUntilExpiry(p, oneHourLater)).toBe(
      RENEWAL_LINK_TOKEN_TTL_SECONDS - 3600,
    );
  });

  it('negative when past expiry', () => {
    const p = buildPayload({
      tenantId: 't',
      memberId: 'm',
      cycleId: 'c',
      now: NOW,
    });
    const farFuture = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000); // +60d
    expect(secondsUntilExpiry(p, farFuture)).toBeLessThan(0);
  });
});
