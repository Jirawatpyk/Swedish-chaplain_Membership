/**
 * F9 audit-viewer filter validation (dashboard bug hunt 2026-07-11 + review).
 *
 * `target_user_id` is a UUID column and `event_type` is a Postgres enum column,
 * so a non-UUID `targetRef` or an unknown `eventType` (member number, name,
 * typo, or tampered URL) reaches Postgres as an invalid cast (22P02) and throws
 * — 500-ing the audit page instead of the graceful invalid-filter state. These
 * guards gate both up front.
 */
import { describe, expect, it } from 'vitest';
import {
  isValidTargetRef,
  isValidEventTypeFilter,
} from '@/lib/audit-filter-validation';

describe('isValidTargetRef', () => {
  it('accepts an empty value (no target filter applied)', () => {
    expect(isValidTargetRef('')).toBe(true);
  });

  it('accepts a well-formed UUID (case-insensitive)', () => {
    expect(isValidTargetRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isValidTargetRef('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects non-UUID free text that would crash the uuid cast', () => {
    expect(isValidTargetRef('SCCM-0042')).toBe(false);
    expect(isValidTargetRef('Jane Doe')).toBe(false);
    expect(isValidTargetRef('123')).toBe(false);
    expect(isValidTargetRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301-extra')).toBe(false);
    expect(isValidTargetRef('garbage3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(false);
    expect(isValidTargetRef('3f2504e0-4f89-41d3-9a0c-0305e82c3301\n')).toBe(false);
  });
});

describe('isValidEventTypeFilter', () => {
  const ALLOWED = ['member_created', 'payment_succeeded', 'plan-cross-tenant-probe'];

  it('accepts an empty value (no event-type filter applied)', () => {
    expect(isValidEventTypeFilter('', ALLOWED)).toBe(true);
  });

  it('accepts a known event type (incl. hyphenated enum values)', () => {
    expect(isValidEventTypeFilter('member_created', ALLOWED)).toBe(true);
    expect(isValidEventTypeFilter('plan-cross-tenant-probe', ALLOWED)).toBe(true);
  });

  it('rejects an unknown value that would crash the enum cast (22P02)', () => {
    expect(isValidEventTypeFilter('bogus', ALLOWED)).toBe(false);
    expect(isValidEventTypeFilter('member_created; DROP TABLE', ALLOWED)).toBe(false);
  });
});
