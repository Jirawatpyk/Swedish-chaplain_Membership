/**
 * `/admin/audit` — which filter the "Invalid filter" state names. Pure helper
 * behind the page's per-field copy (the page-level test covers the wiring).
 */
import { describe, it, expect } from 'vitest';
import {
  invalidAuditFilterField,
  invalidRangeField,
} from '@/app/(staff)/admin/audit/_lib/invalid-filter-field';

const EVENT_TYPES = ['user_signed_in', 'invoice_issued'] as const;
const VALID_UUID = '3f1c2b9e-8a4d-4c1e-9b2a-1d2e3f4a5b6c';
const EMPTY = { from: '', to: '', targetRef: '', eventType: '', cursor: '' };

describe('invalidAuditFilterField', () => {
  it('no filters → null', () => {
    expect(invalidAuditFilterField(EMPTY, EVENT_TYPES)).toBeNull();
  });

  it('all filters valid (From == To is a valid one-day range) → null', () => {
    expect(
      invalidAuditFilterField(
        {
          from: '2026-05-01',
          to: '2026-05-01',
          targetRef: VALID_UUID,
          eventType: 'invoice_issued',
          cursor: 'opaque',
        },
        EVENT_TYPES,
      ),
    ).toBeNull();
  });

  it.each([
    ['from', { from: '2026-02-30' }],
    ['from', { from: 'yesterday' }],
    ['to', { to: '2026-13-01' }],
    ['range', { from: '2026-05-10', to: '2026-05-01' }],
    ['target', { targetRef: 'M-0042' }],
    ['eventType', { eventType: 'not_a_real_event' }],
  ] as const)('names %s for %o', (field, overrides) => {
    expect(invalidAuditFilterField({ ...EMPTY, ...overrides }, EVENT_TYPES)).toBe(field);
  });
});

describe('invalidRangeField (use-case invalid_range after shape validation passed)', () => {
  it('a cursor is present → the cursor is the culprit', () => {
    expect(invalidRangeField({ ...EMPTY, cursor: 'stale' })).toBe('cursor');
  });

  it('no cursor → not attributable (generic copy)', () => {
    expect(invalidRangeField(EMPTY)).toBeNull();
  });
});
