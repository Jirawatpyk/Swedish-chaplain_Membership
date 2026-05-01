/**
 * Unit tests — `IanaTimezone` branded VO + smart constructors.
 *
 * Validates:
 *   - `asIanaTimezone` returns ok/err around the IANA registry boundary
 *   - `unsafeIanaTimezone` throws with a stable error-message format
 *     for invalid literals (so callers that pattern-match the message
 *     don't break silently on rename)
 */
import { describe, expect, it } from 'vitest';
import {
  asIanaTimezone,
  getTenantTimezone,
  hasExplicitTenantTimezone,
  unsafeIanaTimezone,
} from '@/modules/tenants';

describe('asIanaTimezone (parse-do-not-validate constructor)', () => {
  it.each([
    'Asia/Bangkok',
    'Europe/Stockholm',
    'UTC',
    'America/New_York',
    'Pacific/Auckland',
  ])('returns ok for valid IANA id %s', (id) => {
    const r = asIanaTimezone(id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(id);
  });

  // Note: js-joda accepts GMT/UTC offset literals (e.g. `GMT+7`,
  // `+07:00`) as valid `ZoneId`s, so they're NOT in the negative
  // cases below. The brand only rejects strings that ZoneId.of()
  // throws on.
  it.each(['Foo/Bar', 'Asia/Bankgok', '', 'random-string', 'NotAZone/X'])(
    'returns err for invalid id %s',
    (id) => {
      const r = asIanaTimezone(id);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('iana.invalid');
        expect(r.error.raw).toBe(id);
      }
    },
  );
});

describe('hasExplicitTenantTimezone (Application-layer fallback gate)', () => {
  it('returns true for known tenant slug (swecham)', () => {
    expect(hasExplicitTenantTimezone('swecham')).toBe(true);
  });

  it.each(['unknown-tenant', '', '__proto__', 'constructor'])(
    'returns false for unknown / unsafe slug %s',
    (slug) => {
      expect(hasExplicitTenantTimezone(slug)).toBe(false);
    },
  );

  it('getTenantTimezone returns DEFAULT for unknown slug (fallback contract)', () => {
    // The Application-layer caller (`compute-quota-counter.ts`) gates
    // a `logger.warn` on `hasExplicitTenantTimezone === false`. Verify
    // the value returned for the unknown slug matches the documented
    // Asia/Bangkok fallback so the warn payload is meaningful.
    expect(getTenantTimezone('unknown-tenant')).toBe('Asia/Bangkok');
  });
});

describe('unsafeIanaTimezone (build-time-known cast)', () => {
  it('returns the brand for valid literals', () => {
    expect(unsafeIanaTimezone('Asia/Bangkok')).toBe('Asia/Bangkok');
    expect(unsafeIanaTimezone('UTC')).toBe('UTC');
  });

  it('throws with a stable message format on invalid literal', () => {
    expect(() => unsafeIanaTimezone('Foo/Bar')).toThrow(
      'unsafeIanaTimezone: invalid IANA tz literal "Foo/Bar"',
    );
  });
});
