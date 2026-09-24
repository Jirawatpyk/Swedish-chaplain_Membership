'use client';

/**
 * ux-standards § 6.4 — a refusal that keeps a dialog open is surfaced inline
 * AND focused: the field it names (`field: 'reason'`, when the caller passes
 * that field's ref), else the form-level line — an `InlineError` /
 * `InlineWarning`, focusable via its `tabIndex={-1}` — found by its id.
 *
 * Keyed on the refusal VALUE: callers store a fresh object per refusal (and
 * clear it at the start of every request), so a repeated refusal focuses
 * again. Shared by the member sign-off dialogs and, since PR #392 review D8,
 * the staff schedule and start-version confirmations.
 */
import { useEffect } from 'react';

export function useFocusRefusal(
  refusal: object | null,
  formErrorId: string,
  field?: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (refusal === null) return;
    const namesField = 'field' in refusal && refusal.field === 'reason';
    if (namesField && field !== undefined) field.current?.focus();
    else document.getElementById(formErrorId)?.focus();
  }, [refusal, field, formErrorId]);
}
