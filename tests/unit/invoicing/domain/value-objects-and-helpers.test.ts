/**
 * F4 Domain value-objects-and-helpers — small VO + helper coverage.
 *
 * Batches `sha256-hex` + `tenant-identity-snapshot` into one file (same
 * pattern as `tests/unit/payments/domain/value-objects-and-helpers.
 * test.ts`) since each VO is small enough not to warrant a dedicated
 * test file.
 *
 * Authored 2026-05-17 as part of the F4 Domain coverage push (plan
 * `jolly-shimmying-sundae.md` Phase B) — closes gaps surfaced by the
 * polish retrospective so the F4 Domain blanket 100% threshold can
 * be added at Phase C.
 */
import { describe, it, expect } from 'vitest';
import {
  Sha256Hex,
  type Sha256Hex as Sha256HexType,
} from '@/modules/invoicing/domain/value-objects/sha256-hex';
import {
  makeTenantIdentitySnapshot,
  type TenantIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import {
  PRO_RATE_POLICIES,
  isProRatePolicy,
  asProRatePolicyUnsafe,
  type ProRatePolicy,
} from '@/modules/invoicing/domain/value-objects/pro-rate-policy';

describe('Sha256Hex.parse — Result form for boundary code', () => {
  const validDigest = 'a'.repeat(64); // 64 lowercase hex chars

  it('accepts a 64-char lowercase hex digest', () => {
    const r = Sha256Hex.parse(validDigest);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(validDigest);
    }
  });

  it('accepts a real SHA-256 digest pattern', () => {
    // Standard "abc" → SHA-256 fixture
    const digest =
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const r = Sha256Hex.parse(digest);
    expect(r.ok).toBe(true);
  });

  it('rejects uppercase hex (must be lowercase per RE_SHA256)', () => {
    const r = Sha256Hex.parse('A'.repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('malformed');
      expect(r.error.raw).toBe('A'.repeat(64));
    }
  });

  it('rejects too-short input (63 chars)', () => {
    const r = Sha256Hex.parse('a'.repeat(63));
    expect(r.ok).toBe(false);
  });

  it('rejects too-long input (65 chars)', () => {
    const r = Sha256Hex.parse('a'.repeat(65));
    expect(r.ok).toBe(false);
  });

  it('rejects non-hex chars (g+)', () => {
    const r = Sha256Hex.parse('g'.repeat(64));
    expect(r.ok).toBe(false);
  });

  it('rejects empty string', () => {
    const r = Sha256Hex.parse('');
    expect(r.ok).toBe(false);
  });

  it('preserves raw input on error for diagnostics', () => {
    const malformed = 'not-a-digest';
    const r = Sha256Hex.parse(malformed);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.raw).toBe(malformed);
    }
  });
});

describe('Sha256Hex.ofUnsafe — throwing form for trusted producer paths', () => {
  const validDigest = 'a'.repeat(64);

  it('returns branded value on valid input', () => {
    const v: Sha256HexType = Sha256Hex.ofUnsafe(validDigest);
    expect(v).toBe(validDigest);
  });

  it('throws on malformed input with truncated raw in message', () => {
    expect(() => Sha256Hex.ofUnsafe('definitely-not-a-sha256-hex-digest')).toThrow(
      /expected 64-char lowercase hex/i,
    );
  });

  it('throws on too-short input', () => {
    expect(() => Sha256Hex.ofUnsafe('a'.repeat(63))).toThrow();
  });

  it('truncates the raw value in error message to 16 chars + ellipsis', () => {
    let caught: Error | null = null;
    try {
      Sha256Hex.ofUnsafe('xyz'.repeat(40)); // 120 chars
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // Message contains first 16 chars + ellipsis, not the full 120
    expect(caught!.message).toContain('xyzxyzxyzxyzxyzx');
    expect(caught!.message).toContain('…');
    // Full input length is NOT in the message
    expect(caught!.message).not.toContain('xyz'.repeat(40));
  });
});

describe('makeTenantIdentitySnapshot', () => {
  const validSnapshot: TenantIdentitySnapshot = {
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    legal_name_en: 'Thailand-Swedish Chamber of Commerce',
    tax_id: '0993000123456',
    address_th: '99/1 ถนนพระราม 4 กรุงเทพมหานคร',
    address_en: '99/1 Rama IV Rd, Bangkok',
    logo_blob_key: 'tenants/swecham/logo.png',
  };

  it('returns a frozen copy of the input', () => {
    const snap = makeTenantIdentitySnapshot(validSnapshot);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('preserves all 6 fields verbatim', () => {
    const snap = makeTenantIdentitySnapshot(validSnapshot);
    expect(snap.legal_name_th).toBe(validSnapshot.legal_name_th);
    expect(snap.legal_name_en).toBe(validSnapshot.legal_name_en);
    expect(snap.tax_id).toBe(validSnapshot.tax_id);
    expect(snap.address_th).toBe(validSnapshot.address_th);
    expect(snap.address_en).toBe(validSnapshot.address_en);
    expect(snap.logo_blob_key).toBe(validSnapshot.logo_blob_key);
  });

  it('accepts null logo_blob_key (tenant without logo)', () => {
    const snap = makeTenantIdentitySnapshot({
      ...validSnapshot,
      logo_blob_key: null,
    });
    expect(snap.logo_blob_key).toBeNull();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('returns a NEW object (does not return the input reference — caller-isolation)', () => {
    const snap = makeTenantIdentitySnapshot(validSnapshot);
    expect(snap).not.toBe(validSnapshot);
    expect(snap).toEqual(validSnapshot);
  });

  it('throws on attempted mutation (frozen)', () => {
    const snap = makeTenantIdentitySnapshot(validSnapshot);
    // In strict mode, assigning to a frozen object throws TypeError.
    // Vitest runs in strict mode via tsconfig.
    expect(() => {
      (snap as { tax_id: string }).tax_id = 'tampered';
    }).toThrow(TypeError);
  });
});

describe('ProRatePolicy enum + validators', () => {
  // The existing pro-rate-policy.test.ts file tests the wrong source
  // (`calculate-pro-rate-factor.ts`); the actual pro-rate-policy.ts
  // file had no direct test until 2026-05-17 (Phase B coverage push).
  it('PRO_RATE_POLICIES enumerates exactly 3 values', () => {
    expect(PRO_RATE_POLICIES).toEqual(['none', 'monthly', 'daily']);
    expect(PRO_RATE_POLICIES).toHaveLength(3);
  });

  it('isProRatePolicy returns true for all valid members', () => {
    expect(isProRatePolicy('none')).toBe(true);
    expect(isProRatePolicy('monthly')).toBe(true);
    expect(isProRatePolicy('daily')).toBe(true);
  });

  it('isProRatePolicy returns false for unknown values', () => {
    expect(isProRatePolicy('weekly')).toBe(false);
    expect(isProRatePolicy('')).toBe(false);
    expect(isProRatePolicy('NONE')).toBe(false); // case-sensitive
  });

  it('asProRatePolicyUnsafe returns branded value for valid input', () => {
    const v: ProRatePolicy = asProRatePolicyUnsafe('monthly');
    expect(v).toBe('monthly');
  });

  it('asProRatePolicyUnsafe throws on invalid input with helpful message', () => {
    expect(() => asProRatePolicyUnsafe('quarterly')).toThrow(
      /invalid quarterly/,
    );
  });
});
