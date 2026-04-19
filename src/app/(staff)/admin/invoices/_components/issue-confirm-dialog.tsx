/**
 * T058 — Issue-confirm panel (F4 FR-040).
 *
 * Rendered inside the dedicated `/issue` route — NOT a true modal
 * dialog (hence the *Panel* rename). The `/issue` URL IS the
 * confirmation surface; the typed-phrase + summary forces deliberate
 * review before the irreversible §87 sequence allocation.
 *
 * a11y: `aria-describedby` points at the surrounding summary card so
 * AT users hear "Confirm issuance for <doc#>, <member>, THB <amount>"
 * BEFORE the input gains focus. Reduced-motion + focus-ring handled
 * by the shared shadcn primitives.
 *
 * Localised confirm phrase (UX-H3): the phrase the admin must type is
 * pulled from i18n (`t('confirmPhrase')`), not hard-coded English —
 * a Thai admin on a TH-locale UI sees "ออก" / an SV admin sees
 * "UTFÄRDA". Case-insensitive comparison uses the user's locale via
 * `toLocaleUpperCase()`.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export function IssueConfirmPanel({
  invoiceId,
  summaryId,
}: {
  invoiceId: string;
  /**
   * DOM id of the invoice summary element on the parent page — wired
   * via `aria-describedby` so screen readers narrate the numbers
   * BEFORE the typed-phrase input takes focus.
   */
  summaryId?: string;
}) {
  const t = useTranslations('admin.invoices.issue');
  const locale = useLocale();
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

  // Phrase is locale-sourced; fold-case compares via the user's
  // locale so Turkish-style I/i-dotting and Thai vowel forms both
  // resolve predictably.
  const confirmPhrase = t('confirmPhrase');
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  function issue() {
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/issue`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        toast.error(t('errors.failed'), {
          description: code ? t('errors.codeFallback', { code }) : t('errors.unknown'),
        });
        return;
      }
      toast.success(t('success'));
      router.push(`/admin/invoices/${invoiceId}`);
      router.refresh();
    });
  }

  return (
    <div
      className="flex flex-col gap-4"
      aria-describedby={summaryId}
      role="group"
      aria-labelledby="issue-confirm-heading"
    >
      <p id="issue-confirm-heading" className="text-sm font-medium">
        {t('confirmCopy', { phrase: confirmPhrase })}
      </p>
      <div>
        <Label htmlFor="confirm">{t('typeToConfirm')}</Label>
        <Input
          id="confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={confirmPhrase}
          autoComplete="off"
          aria-invalid={typed.length > 0 && !matches}
        />
      </div>
      <Button onClick={issue} disabled={!matches || pending}>
        {pending ? t('issuing') : t('issueButton')}
      </Button>
    </div>
  );
}

// Back-compat: the old name is still referenced by the /issue page
// until the route-refactor task lands. Re-export so existing imports
// keep working without a codemod.
export { IssueConfirmPanel as IssueConfirmDialog };
