/**
 * Unit test: member input-hardening at the application write boundaries
 * (branch 066 — PR #196 review follow-up).
 *
 *  - `updateContactFieldsSchema.date_of_birth`: must be '' (clear) or a real
 *    'YYYY-MM-DD' calendar date, so an unparseable string can't reach
 *    `new Date(...).toISOString()` (opaque 500) and a non-ISO string can't be
 *    stored a day off (local-time parse).
 *  - `selfUpdateSchema.website`: the member self-service PATCH is the live
 *    stored-XSS source — a `javascript:`/`data:` scheme must be rejected at the
 *    boundary (the render sink `safeExternalHref` is the definitive guard).
 */
import { describe, expect, it } from 'vitest';
import { updateContactFieldsSchema } from '@/modules/members/application/use-cases/contact-crud';
import { selfUpdateSchema } from '@/modules/members/application/use-cases/member-self-update';

describe('updateContactFieldsSchema — date_of_birth boundary', () => {
  it('accepts a valid ISO calendar date, empty string, and null', () => {
    expect(updateContactFieldsSchema.safeParse({ date_of_birth: '2005-06-15' }).success).toBe(true);
    expect(updateContactFieldsSchema.safeParse({ date_of_birth: '' }).success).toBe(true);
    expect(updateContactFieldsSchema.safeParse({ date_of_birth: null }).success).toBe(true);
    // omitted entirely (optional) is fine
    expect(updateContactFieldsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unparseable, non-ISO, and overflow dates', () => {
    for (const bad of [
      'garbage',
      '2005', // year only → new Date parses as local ms epoch, off-by
      '06/15/2005', // US format → local-time parse, day drift
      '2005-6-5', // not zero-padded
      '2020-13-45', // impossible month/day → Invalid Date
      '2020-02-30', // overflow → new Date rolls to Mar 1 (would store a day off)
    ]) {
      expect(
        updateContactFieldsSchema.safeParse({ date_of_birth: bad }).success,
        `expected ${bad} to be rejected`,
      ).toBe(false);
    }
  });
});

describe('selfUpdateSchema — website scheme guard', () => {
  it('rejects javascript:/data:/vbscript: schemes (stored-XSS source)', () => {
    for (const bad of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      expect(
        selfUpdateSchema.safeParse({ website: bad }).success,
        `expected ${bad} to be rejected`,
      ).toBe(false);
    }
  });

  it('accepts http(s), scheme-less, empty, and null website values', () => {
    for (const okv of ['https://example.com', 'http://x.io', 'example.com', '', null]) {
      expect(
        selfUpdateSchema.safeParse({ website: okv }).success,
        `expected ${String(okv)} to be accepted`,
      ).toBe(true);
    }
  });
});
