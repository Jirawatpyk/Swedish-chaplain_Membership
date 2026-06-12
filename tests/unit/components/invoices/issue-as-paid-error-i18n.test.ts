/**
 * 065 review follow-up [types review, item 5] — i18n coverage pin for the
 * AUTO-GROWING as-paid error display set used by event-fee-form.tsx.
 *
 * The form derives its toast-copy set from the canonical
 * `ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES` (wave-4 S19 codes leaf) with two
 * deliberate deltas:
 *
 *   - MINUS `registration_lookup_failed` — internal verification error, not
 *     operator-fixable; stays on the codeFallback toast (no copy key).
 *   - PLUS `'invalid'` — the route-level 400 zod reject, not a use-case code.
 *
 * Because the set AUTO-GROWS (a new error variant on the use-case union
 * flows through the codes leaf into the form automatically), the invariant
 * "every display code has `admin.invoices.issueAsPaid.errors.*` copy" was
 * previously enforced ONLY by a comment on the leaf ("add its errors.* copy
 * in all three locales when one is introduced"). Unit tests mock next-intl
 * (t() never throws on a missing key) and `check:i18n` is parity-only, so a
 * forgotten key would pass every gate and crash MISSING_MESSAGE at runtime
 * on the first toast for that code. This test converts the comment into CI:
 * EN is the canonical locale (a missing EN key is the crash class; TH/SV
 * parity is `check:i18n`'s job).
 *
 * 065 QC S10 — this test now imports `AS_PAID_ERROR_CODES` from the form's
 * OWN leaf module (`as-paid-error-codes.ts`) instead of rebuilding the
 * arithmetic locally. Previously it hand-copied the `+ 'invalid' /
 * − registration_lookup_failed` arithmetic, so it only validated its OWN
 * copy against en.json — a change to the form's real set would NOT be caught.
 * Pinning against the actual constant closes that false-confidence gap. The
 * leaf is a pure `.ts` module (no React import graph), so this stays a fast
 * unit `.ts` file; the composition pins below still assert the arithmetic is
 * exactly `+ 'invalid' / − registration_lookup_failed` against the canonical
 * leaf, so a one-sided edit to the form's set is surfaced here.
 */
import { describe, expect, it } from 'vitest';
import { ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid-codes';
import { AS_PAID_ERROR_CODES } from '@/app/(staff)/admin/invoices/new/_components/as-paid-error-codes';
import en from '@/i18n/messages/en.json';

// The form's ACTUAL display set (imported, not re-derived).
const DISPLAY_CODES: readonly string[] = AS_PAID_ERROR_CODES;

const errors = en.admin.invoices.issueAsPaid.errors as Record<string, string | undefined>;

describe('issueAsPaid error display set — EN i18n coverage (065 item 5 / QC S10)', () => {
  it('every display code has a non-empty admin.invoices.issueAsPaid.errors.* EN key', () => {
    const missing = DISPLAY_CODES.filter(
      (code) => typeof errors[code] !== 'string' || errors[code]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty EN copy for as-paid error code(s): ${missing.join(', ')} — ` +
        'a new IssueEventInvoiceAsPaidError variant flows into the form ' +
        'AUTOMATICALLY via the codes leaf; add ' +
        '`admin.invoices.issueAsPaid.errors.<code>` to en.json (+ th/sv for ' +
        'check:i18n parity) or the first toast for it crashes MISSING_MESSAGE.',
    ).toEqual([]);
  });

  it('the fallback + transport keys exist (codeFallback / unknown / network)', () => {
    // codeFallback renders unmapped codes ("Error code: {code}"), unknown is
    // the generic toast, network is the S4 fetch-rejection guidance — all
    // three are reachable on EVERY submit regardless of the display set.
    expect(typeof errors['codeFallback']).toBe('string');
    expect(typeof errors['unknown']).toBe('string');
    expect(typeof errors['network']).toBe('string');
  });

  it('the imported set matches the form arithmetic: leaf − registration_lookup_failed + invalid', () => {
    // Reconstruct the EXPECTED arithmetic from the canonical leaf and assert
    // the form's real exported set equals it. If the form's set ever drifts
    // (e.g. a delta is added/removed), this fails — the arithmetic is no
    // longer hand-copied, it is asserted against the source of truth.
    const expected = [
      'invalid',
      ...ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES.filter(
        (code) => code !== 'registration_lookup_failed',
      ),
    ];
    expect(AS_PAID_ERROR_CODES).toEqual(expected);
  });

  it('display-set composition: excludes registration_lookup_failed (codeFallback-only by design)', () => {
    expect(DISPLAY_CODES).not.toContain('registration_lookup_failed');
    // …and the EXCLUSION is still meaningful: the code must still exist on
    // the canonical leaf (if it is ever renamed/removed there, the filter
    // silently becomes a no-op — surface that here).
    expect(ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES).toContain('registration_lookup_failed');
  });

  it("display-set composition: includes the route-level 'invalid' (400 zod reject, not a use-case code)", () => {
    expect(DISPLAY_CODES).toContain('invalid');
    expect(ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES).not.toContain('invalid');
  });
});
