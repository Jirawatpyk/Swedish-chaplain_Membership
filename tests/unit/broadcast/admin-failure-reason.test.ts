/**
 * F119 PR-A — every `failure_reason` a writer stores has a STAFF sentence in
 * all three locales.
 *
 * The detail page reads `admin.broadcasts.review.failureReason.<token>` with a
 * dynamic key, which `check:i18n` cannot see, and falls back to `generic`
 * through `t.has` — so a token without its sentence would render the generic
 * line silently. This walks the writers' own vocabulary against the REAL
 * catalogues.
 *
 * Writers: both dispatch legs (`MEMBER_FACING_FAILURE_REASONS` — the import
 * leg's tokens, which the legacy leg's tokens are a subset of), the legacy
 * leg's two composites (`retry_budget_exhausted_after_1h:…`,
 * `resend_resource_missing:…`), and `reconcile-stuck-sending`
 * (`resend_resource_404`, `no_resend_resource_attached`).
 */
import { describe, expect, it } from 'vitest';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { failureReasonToken } from '@/components/broadcast/admin/failure-reason';
import { MEMBER_FACING_FAILURE_REASONS } from '@/modules/broadcasts/application/use-cases/build-audience-tick';

const CATALOGUES = { en: enMessages, th: thMessages, sv: svMessages } as const;

/** `admin.broadcasts.review.failureReason` in one locale. */
function sentences(locale: keyof typeof CATALOGUES): Readonly<Record<string, unknown>> {
  return (
    CATALOGUES[locale] as unknown as {
      admin: { broadcasts: { review: { failureReason: Record<string, unknown> } } };
    }
  ).admin.broadcasts.review.failureReason;
}

const STORED_VALUES = [
  ...MEMBER_FACING_FAILURE_REASONS,
  'retry_budget_exhausted_after_1h:server_5xx:upstream',
  'resend_resource_missing:audience',
  'resend_resource_404',
  'no_resend_resource_attached',
] as const;

describe('admin failure-reason sentences (F119 PR-A)', () => {
  it.each(['en', 'th', 'sv'] as const)('%s: every stored reason has its own sentence, distinct from the generic one', (locale) => {
    const catalogue = sentences(locale);
    const generic = catalogue['generic'];
    expect(typeof generic).toBe('string');
    for (const stored of STORED_VALUES) {
      const token = failureReasonToken(stored);
      expect(token, stored).not.toBeNull();
      const text = catalogue[token!];
      expect(typeof text, `${locale}/${stored}`).toBe('string');
      expect(text, `${locale}/${stored}`).not.toBe(generic);
    }
  });

  it('a stored value that names no token (provider free text, empty, NULL) answers null — the page then reads generic', () => {
    expect(failureReasonToken('Resend said: 422 invalid from address <x@y.z>')).toBeNull();
    expect(failureReasonToken('')).toBeNull();
    expect(failureReasonToken(null)).toBeNull();
    expect(failureReasonToken('retry_budget_exhausted_after_1h:api:x')).toBe('retry_budget_exhausted');
    expect(failureReasonToken('resend_resource_missing:audience')).toBe('resend_resource_missing');
  });
});
