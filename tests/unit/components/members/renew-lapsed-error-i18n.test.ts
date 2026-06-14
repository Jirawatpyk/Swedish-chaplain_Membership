/**
 * 068-f8-completion (code-review fix / cluster D) — i18n coverage pin for the
 * `RenewLapsedMemberDialog` error-toast set.
 *
 * THE BUG: the dialog did
 *   `t(\`toast.error.${code}\`, { fallback: t('toast.error.server_error') })`
 * but next-intl's 2nd `t()` arg is interpolation VALUES, not options — there
 * is no `fallback` option. So a route error code WITHOUT a `toast.error.*` key
 * (`rate_limited`, `invalid_body`, `invalid_input`) rendered the raw dotted
 * key path + logged MISSING_MESSAGE.
 *
 * THE FIX: (1) add the missing keys for EVERY code the route emits; (2)
 * replace the bogus `{ fallback }` with `t.has(...) ? t(...) : t('server_error')`.
 *
 * This test converts the "keep route + i18n in sync" comment into CI. Unit
 * tests mock next-intl (t() never throws on a missing key) and `check:i18n`
 * is parity-only, so a forgotten EN key for a new route error code would pass
 * every gate and render the raw key at runtime. EN is the canonical locale (a
 * missing EN key is the crash class; TH/SV parity is `check:i18n`'s job).
 *
 * The dialog also guards with `t.has(...)`, so an UNKNOWN future code falls
 * back to `server_error` — but EVERY code in `RENEW_LAPSED_ERROR_CODES` is one
 * the route ACTUALLY emits, so each MUST resolve to its own copy (not the
 * generic server_error fallback).
 */
import { describe, expect, it } from 'vitest';
import { RENEW_LAPSED_ERROR_CODES } from '@/components/members/renew-lapsed-error-codes';
import en from '@/i18n/messages/en.json';

const errors = (
  en as unknown as {
    admin: {
      members: {
        detail: { renewLapsed: { toast: { error: Record<string, string | undefined> } } };
      };
    };
  }
).admin.members.detail.renewLapsed.toast.error;

describe('RenewLapsedMemberDialog error set — EN i18n coverage (cluster D)', () => {
  it('every route-emittable error code has a non-empty admin.members.detail.renewLapsed.toast.error.* EN key', () => {
    const missing = RENEW_LAPSED_ERROR_CODES.filter(
      (code) => typeof errors[code] !== 'string' || errors[code]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty EN copy for renew-lapsed error code(s): ${missing.join(', ')} — ` +
        'the route emits these in `{ error: { code } }`; add ' +
        '`admin.members.detail.renewLapsed.toast.error.<code>` to en.json ' +
        '(+ th/sv for check:i18n parity) or the toast renders the raw dotted ' +
        'key path (the bug this test guards).',
    ).toEqual([]);
  });

  it('the three previously-missing codes are now present (rate_limited / invalid_body / invalid_input)', () => {
    // These were the codes the bogus `{ fallback }` could not resolve.
    expect(typeof errors['rate_limited']).toBe('string');
    expect(typeof errors['invalid_body']).toBe('string');
    expect(typeof errors['invalid_input']).toBe('string');
  });

  it('the server_error fallback key exists (the t.has(...) fallback target)', () => {
    expect(typeof errors['server_error']).toBe('string');
    expect(errors['server_error']!.length).toBeGreaterThan(0);
  });
});
