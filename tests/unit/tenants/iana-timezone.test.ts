/**
 * Unit tests — `IanaTimezone` branded VO + smart constructors.
 *
 * Validates:
 *   - `asIanaTimezone` returns ok/err around the IANA registry boundary
 *   - parity with js-joda `ZoneId.of` for IANA region ids — the VO is
 *     `Intl`-based (so the tenants barrel stays out of client bundles) but
 *     its output feeds js-joda on the server, so the two must agree
 *   - `unsafeIanaTimezone` throws with a stable error-message format
 *     for invalid literals (so callers that pattern-match the message
 *     don't break silently on rename)
 */
import { describe, expect, it } from 'vitest';
import { ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import {
  asIanaTimezone,
  unsafeIanaTimezone,
} from '@/modules/tenants';

describe('asIanaTimezone (parse-do-not-validate constructor)', () => {
  it.each([
    'Asia/Bangkok',
    'Europe/Stockholm',
    'UTC',
    'America/New_York',
    'Pacific/Auckland',
    'Asia/Calcutta', // tzdb link — accepted as-is, not canonicalised
    'Etc/GMT-7',
    'Etc/UTC',
  ])('returns ok for valid IANA id %s', (id) => {
    const r = asIanaTimezone(id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(id);
  });

  // IANA ids are case-sensitive for js-joda (and every downstream
  // `ZoneId.of`), while `Intl` resolves them case-insensitively — the VO
  // must reject a mis-cased id rather than brand it. Surrounding
  // whitespace is rejected by both.
  it.each([
    'Foo/Bar',
    'Asia/Bankgok',
    '',
    'random-string',
    'NotAZone/X',
    'asia/bangkok',
    'ASIA/BANGKOK',
    'etc/utc',
    ' Asia/Bangkok',
    'Asia/Bangkok ',
  ])(
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

  // Offset / `Z` literals are NOT IANA ids. js-joda's `ZoneId.of` accepts
  // them; `Intl` does not — and neither does the `TENANT_TIMEZONE` boot
  // validator in `src/lib/env.ts` (same `Intl.DateTimeFormat` check), so
  // they can never reach this VO in production. Pinned so the choice is
  // explicit.
  it.each(['GMT+7', 'UTC+7', 'Z'])('returns err for offset literal %s', (id) => {
    expect(asIanaTimezone(id).ok).toBe(false);
  });
});

describe('asIanaTimezone — parity with js-joda ZoneId.of for IANA region ids', () => {
  function zoneIdAccepts(id: string): boolean {
    try {
      ZoneId.of(id);
      return true;
    } catch {
      return false;
    }
  }

  it.each([
    'Asia/Bangkok',
    'Europe/Stockholm',
    'UTC',
    'Etc/UTC',
    'Etc/GMT-7',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'Pacific/Auckland',
    'Asia/Calcutta',
    'US/Pacific',
    'Foo/Bar',
    'Asia/Bankgok',
    'asia/bangkok',
    'ASIA/BANGKOK',
    'etc/utc',
    ' Asia/Bangkok',
    '',
  ])('agrees with ZoneId.of for %j', (id) => {
    expect(asIanaTimezone(id).ok).toBe(zoneIdAccepts(id));
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
