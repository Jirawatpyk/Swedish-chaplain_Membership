'use client';

/**
 * T102 — Void-invoice confirm client component (F4 / US5 Phase 9).
 *
 * FR-040 — typed-phrase confirmation. Unlike credit-note (which types
 * "CREDIT" because the CN number is only known post-commit), the
 * invoice's document number IS known here — so we require the admin
 * to type the EXACT document number. This catches wrong-row mistakes
 * (admin clicking void on the wrong invoice in the directory) which
 * is the #1 real-world void error.
 */
import { useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangleIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
};

export function VoidConfirmDialog({ invoiceId, documentNumber }: Props) {
  const t = useTranslations('admin.invoices.void');
  const locale = useLocale();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

  // Typed-phrase = invoice document number (case-insensitive locale
  // compare, mirrors issue-invoice-dialog).
  const confirmPhrase = documentNumber;
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  const reasonValid = reason.trim().length > 0 && reason.trim().length <= 500;
  const canSubmit = reasonValid && matches && !pending;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voidReason: reason.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code;
        toast.error(t('errors.failed'), {
          description: code ? t('errors.codeFallback', { code }) : t('errors.unknown'),
        });
        return;
      }
      toast.success(t('success'));
      router.push(`/admin/invoices/${invoiceId}`);
    });
  }, [canSubmit, invoiceId, reason, t, router]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-6"
    >
      {/* UX-1 — destructive Alert gives terminal-action warning
        * the visual weight it deserves (AlertTriangle + destructive
        * palette). Previous muted-card treatment under-signalled the
        * irreversibility of void vs the rest of the form copy. */}
      <Alert variant="destructive">
        <AlertTriangleIcon aria-hidden="true" />
        <AlertTitle>
          {t('voiding')}{' '}
          <span className="font-mono">{documentNumber}</span>
        </AlertTitle>
        <AlertDescription>{t('terminalNotice')}</AlertDescription>
      </Alert>

      <div className="grid gap-2">
        <Label htmlFor="void-reason">{t('reasonLabel')}</Label>
        <Textarea
          id="void-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          required
          aria-describedby="void-reason-help"
          // UX-3 — surface empty-state invalidity to SR once user has
          // touched and cleared the field (non-empty → empty-after-trim).
          aria-invalid={reason.length > 0 && !reasonValid}
        />
        <p
          id="void-reason-help"
          className="text-xs text-muted-foreground"
          // UX-4 — announce character-counter updates to screen readers.
          aria-live="polite"
        >
          {t('reasonHelp')} ({reason.length}/500)
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="void-confirm">
          {t('confirmCopy', { phrase: confirmPhrase })}
        </Label>
        <Input
          id="void-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={confirmPhrase}
          autoComplete="off"
          inputMode="text"
          enterKeyHint="done"
          autoCorrect="off"
          // UX-2 — DO NOT force uppercase: the compare is already
          // locale-aware case-insensitive (toLocaleUpperCase above).
          // Forcing characters-uppercase breaks mixed-case document
          // numbers on mobile keyboards.
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={typed.length > 0 && !matches}
          aria-describedby={
            typed.length > 0 && !matches ? 'void-confirm-error' : undefined
          }
        />
        {typed.length > 0 && !matches && (
          <p id="void-confirm-error" role="alert" className="text-xs text-destructive">
            {t('confirmMismatch', { phrase: confirmPhrase })}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="destructive" disabled={!canSubmit}>
          {pending ? t('submitting') : t('submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/admin/invoices/${invoiceId}`)}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
