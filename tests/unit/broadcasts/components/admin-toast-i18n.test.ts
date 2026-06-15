/**
 * F7-I18N-1 — EN i18n coverage pin for the admin broadcast moderation
 * toast set (approve / reject / clear-halt dialogs).
 *
 * `approve-dialog.tsx`, `reject-dialog.tsx`, and `clear-halt-dialog.tsx`
 * each call `tToast(<key>)` on the `admin.broadcasts.toast` namespace for
 * their success / 409-race / error branches. Unit tests mock next-intl
 * (t() never throws on a missing key) and `check:i18n` is parity-only
 * (not code-ref-aware), so a key the component reads but that is ABSENT
 * from en.json passes every gate and renders the raw dotted key path
 * ('admin.broadcasts.toast.approved') in the toast at runtime.
 *
 * EN is the canonical locale (a missing EN key is the wrong-copy class;
 * TH/SV parity is `check:i18n`'s job). We assert against the REAL en.json
 * so a key removal/rename fails this test — mirrors the F8 #18 pattern at
 * `tests/unit/app/admin/renewals/pending-reactivation-error-i18n.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';

const toast = (
  en as unknown as {
    admin: { broadcasts: { toast: Record<string, string | undefined> } };
  }
).admin.broadcasts.toast;

// Keys read by the admin moderation dialogs:
//   approve-dialog.tsx   → approved (success) · concurrentRace (409) · error
//   reject-dialog.tsx    → rejected (success) · concurrentRace (409) · error
//   clear-halt-dialog.tsx→ clearHalted (success) · error
const REQUIRED_TOAST_KEYS = [
  'approved',
  'rejected',
  'concurrentRace',
  'clearHalted',
  'error',
] as const;

describe('admin broadcast moderation toasts — EN i18n coverage (F7-I18N-1)', () => {
  it('every toast key the approve/reject/clear-halt dialogs read has a non-empty EN string', () => {
    const missing = REQUIRED_TOAST_KEYS.filter(
      (k) => typeof toast[k] !== 'string' || toast[k]!.length === 0,
    );
    expect(
      missing,
      `Missing/empty admin.broadcasts.toast EN key(s): ${missing.join(', ')} — ` +
        'the approve/reject/clear-halt dialogs call tToast(<key>) on these; add ' +
        'them to en.json (+ th/sv for check:i18n parity) or the toast renders ' +
        'the raw dotted key path at runtime.',
    ).toEqual([]);
  });
});
