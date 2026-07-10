/**
 * F9 audit-viewer filter validation (dashboard bug hunt 2026-07-11).
 *
 * Bug 4: `target_user_id` is a UUID column, so a non-UUID `targetRef` (a member
 * number, name, typo, or tampered URL) reached Postgres as an invalid-uuid cast
 * (22P02) and threw — 500-ing the whole audit page instead of the graceful
 * invalid-filter state. `isValidTargetRef` gates it up front.
 */
import { describe, expect, it } from 'vitest';
import { isValidTargetRef } from '@/app/(staff)/admin/audit/_lib/audit-filter-validation';

describe('isValidTargetRef', () => {
  it('accepts an empty value (no target filter applied)', () => {
    expect(isValidTargetRef('')).toBe(true);
  });

  it('accepts a well-formed UUID', () => {
    expect(isValidTargetRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    // case-insensitive
    expect(isValidTargetRef('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects non-UUID free text that would crash the uuid cast', () => {
    expect(isValidTargetRef('SCCM-0042')).toBe(false);
    expect(isValidTargetRef('Jane Doe')).toBe(false);
    expect(isValidTargetRef('123')).toBe(false);
    // a UUID with the wrong shape (extra segment) must not slip through
    expect(isValidTargetRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301-extra')).toBe(false);
  });
});
