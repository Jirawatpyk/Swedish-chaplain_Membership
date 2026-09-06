import { describe, expect, it } from 'vitest';
import {
  asContactId,
  contactMarketing,
  contactPrimacy,
  deriveMarketingState,
  isPreferredLanguage,
  MARKETING_OPT_OUT_SOURCES,
  RECEIVES_MARKETING,
  tryContactId,
} from '@/modules/members/domain/contact';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';

/**
 * 108 PR-D (US4 / data-model § 1) — the per-contact marketing opt-out is a
 * CORRELATED sub-shape exactly like `contactPrimacy`: the three columns are
 * all null (receives marketing) or all set. `contactMarketing()` is the
 * construct-surface backstop of the DB CHECK
 * `contacts_marketing_opt_out_correlated` (migration 0294).
 */
describe('contactMarketing — correlated opt-out sub-shape (108 PR-D)', () => {
  const at = new Date('2026-09-06T00:00:00Z');
  const uid = 'a6c5b1a2-0000-4000-8000-000000000001' as UserId;

  it('all null → receives marketing (the no-backfill default, FR-027)', () => {
    expect(contactMarketing(null, null, null)).toEqual({
      optedOutAt: null,
      source: null,
      byUserId: null,
    });
  });

  it('RECEIVES_MARKETING is the all-null shape', () => {
    expect(RECEIVES_MARKETING).toEqual({ optedOutAt: null, source: null, byUserId: null });
  });

  it('staff opt-out → { optedOutAt, source: staff, byUserId }', () => {
    expect(contactMarketing(at, 'staff', uid)).toEqual({
      optedOutAt: at,
      source: 'staff',
      byUserId: uid,
    });
  });

  it('self opt-out → source self', () => {
    expect(contactMarketing(at, 'self', uid).source).toBe('self');
  });

  it('exposes exactly the two sources the DB CHECK admits', () => {
    expect([...MARKETING_OPT_OUT_SOURCES]).toEqual(['staff', 'self']);
  });

  it.each([
    ['only optedOutAt', at, null, null],
    ['only source', null, 'staff', null],
    ['only byUserId', null, null, uid],
    ['optedOutAt + source, no actor', at, 'self', null],
    ['optedOutAt + actor, no source', at, null, uid],
  ] as const)('throws on a partial row (%s) — DB CHECK contacts_marketing_opt_out_correlated', (_label, a, s, u) => {
    expect(() => contactMarketing(a, s, u)).toThrow(/contacts_marketing_opt_out_correlated/);
  });

  it('throws on an unknown source', () => {
    expect(() => contactMarketing(at, 'import', uid)).toThrow(/source/);
  });
});

/**
 * FR-025 / FR-031 / FR-031a — the DISPLAYED marketing state is derived, never
 * stored: suppression (the person's own unsubscribe) beats a staff opt-out,
 * which beats "on"; an unreadable suppression list yields "status
 * unavailable" on every surface, never a guessed on/off.
 */
describe('deriveMarketingState — suppression > opt-out > on', () => {
  const at = new Date('2026-09-06T00:00:00Z');
  const uid = 'a6c5b1a2-0000-4000-8000-000000000001' as UserId;

  it('receives + not suppressed → on', () => {
    expect(deriveMarketingState(RECEIVES_MARKETING, false)).toBe('on');
  });

  it('staff opt-out → off_by_staff', () => {
    expect(deriveMarketingState(contactMarketing(at, 'staff', uid), false)).toBe('off_by_staff');
  });

  it('self opt-out → off_by_contact', () => {
    expect(deriveMarketingState(contactMarketing(at, 'self', uid), false)).toBe('off_by_contact');
  });

  it('suppressed wins over a staff opt-out (FR-025: unsubscribe always wins)', () => {
    expect(deriveMarketingState(contactMarketing(at, 'staff', uid), true)).toBe('unsubscribed');
  });

  it('suppressed + receives → unsubscribed', () => {
    expect(deriveMarketingState(RECEIVES_MARKETING, true)).toBe('unsubscribed');
  });

  it('unknown suppression → unavailable, even when opted out (FR-031a: neither on nor off)', () => {
    expect(deriveMarketingState(RECEIVES_MARKETING, 'unknown')).toBe('unavailable');
    expect(deriveMarketingState(contactMarketing(at, 'staff', uid), 'unknown')).toBe('unavailable');
  });
});

describe('contactPrimacy — discriminated-union narrowing (M5)', () => {
  const at = new Date('2026-04-15T00:00:00Z');

  it('primary → { isPrimary: true, removedAt: null }', () => {
    expect(contactPrimacy(true, null)).toEqual({
      isPrimary: true,
      removedAt: null,
    });
  });

  it('non-primary active → { isPrimary: false, removedAt: null }', () => {
    expect(contactPrimacy(false, null)).toEqual({
      isPrimary: false,
      removedAt: null,
    });
  });

  it('non-primary removed → { isPrimary: false, removedAt }', () => {
    expect(contactPrimacy(false, at)).toEqual({
      isPrimary: false,
      removedAt: at,
    });
  });

  it('throws on the DB-invariant violation primary + removed', () => {
    expect(() => contactPrimacy(true, at)).toThrow(
      /primary contact cannot be removed/,
    );
  });
});

describe('isPreferredLanguage', () => {
  it('accepts en / th / sv', () => {
    expect(isPreferredLanguage('en')).toBe(true);
    expect(isPreferredLanguage('th')).toBe(true);
    expect(isPreferredLanguage('sv')).toBe(true);
  });
  it('rejects others', () => {
    expect(isPreferredLanguage('fr')).toBe(false);
    expect(isPreferredLanguage(null)).toBe(false);
    expect(isPreferredLanguage(42)).toBe(false);
  });
});

describe('asContactId', () => {
  it('brands a raw string as ContactId', () => {
    const id = asContactId('c-001');
    expect(id).toBe('c-001');
  });
});

describe('tryContactId', () => {
  it('returns ok for a valid UUID', () => {
    const result = tryContactId('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('normalises to lowercase', () => {
    const result = tryContactId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns err for a non-UUID string', () => {
    const result = tryContactId('not-a-uuid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_contact_id');
  });

  it('returns err for null / number / undefined', () => {
    expect(tryContactId(null).ok).toBe(false);
    expect(tryContactId(42).ok).toBe(false);
    expect(tryContactId(undefined).ok).toBe(false);
  });
});

