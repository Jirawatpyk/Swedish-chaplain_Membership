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

describe('getTenantTimezone (env-driven, MTA+STD)', () => {
  it('returns the env.tenant.timezone value regardless of slug', () => {
    // Test fixture sets `TENANT_TIMEZONE=Asia/Bangkok`. The slug is
    // informational only — every deployment serves one tenant whose
    // tz lives on env. F12 multi-tenant migration will swap this for
    // a per-slug config-port read.
    expect(getTenantTimezone('swecham')).toBe('Asia/Bangkok');
  });

  it.each(['unknown-tenant', '', 'jcc', 'future-stockholm'])(
    'returns the same env value for any slug (%s) — no per-slug map',
    (slug) => {
      expect(getTenantTimezone(slug)).toBe('Asia/Bangkok');
    },
  );
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
