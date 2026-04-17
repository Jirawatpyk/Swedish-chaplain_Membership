import { describe, expect, it } from 'vitest';
import {
  asOverrideReason,
  isOverrideReasonCode,
  OVERRIDE_REASON_CODES,
} from '@/modules/members/domain/value-objects/override-reason';

describe('OverrideReason', () => {
  it.each(['board_approved', 'pending_renewal_grace', 'data_correction'] as const)(
    'accepts enum code %s without note',
    (code) => {
      const r = asOverrideReason(code, null);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.code).toBe(code);
    },
  );

  it('accepts enum + optional note', () => {
    const r = asOverrideReason('board_approved', '  see minutes 2026-04-10  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.note).toBe('see minutes 2026-04-10');
  });

  it('rejects unknown code', () => {
    const r = asOverrideReason('not_a_real_code', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('override.invalid_code');
  });

  it('other requires a note', () => {
    const r = asOverrideReason('other', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('override.note_required_for_other');
  });

  it('other accepts non-empty note', () => {
    const r = asOverrideReason('other', 'regulatory exception');
    expect(r.ok).toBe(true);
  });

  it('rejects note >500 chars', () => {
    const r = asOverrideReason('board_approved', 'x'.repeat(501));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('override.note_too_long');
  });

  it('treats undefined note the same as null', () => {
    const r = asOverrideReason('board_approved', undefined);
    expect(r.ok).toBe(true);
  });

  it('isOverrideReasonCode type-guard', () => {
    for (const c of OVERRIDE_REASON_CODES) expect(isOverrideReasonCode(c)).toBe(true);
    expect(isOverrideReasonCode('xxx')).toBe(false);
    expect(isOverrideReasonCode(null)).toBe(false);
  });
});
