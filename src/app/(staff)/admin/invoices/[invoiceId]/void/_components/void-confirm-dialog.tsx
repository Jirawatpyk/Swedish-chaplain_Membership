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
 *
 * CR-6 (review 2026-04-27): F4 ships this as a dedicated route
 * (`/void` page) rather than an `<AlertDialog>` modal — converting to
 * a modal would require routing rework and is a F4 carry-over item
 * out of F5 scope. We apply the modal-equivalent UX guarantees that
 * `<AlertDialog>` would otherwise enforce:
 *   - Cancel button rendered FIRST in tab order (Cancel-as-default).
 *   - Escape key invokes Cancel (router.push back to detail).
 *   - Initial focus on the reason textarea so the user starts typing
 *     instead of landing on the destructive Submit.
 */
import { useState, useTransition, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';
import { routeVoidError } from './void-error-routing';

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
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  // 088 T021a / FR-032 — voiding RETIRES the §87 document number (terminal,
  // irreversible-in-effect), so a failure MUST NOT be a transient toast: it is
  // surfaced INLINE via a focused role="alert". A concurrent 409 (already
  // voided/paid) shows an inline "already voided — refresh".
  const [formError, setFormError] = useState<
    { readonly kind: 'concurrent' } | { readonly kind: 'failure'; readonly message: string } | null
  >(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  // CR-6: focus the reason field on mount + Esc → cancel route.
  useEffect(() => {
    reasonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) {
        e.preventDefault();
        router.push(`/admin/invoices/${invoiceId}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [invoiceId, pending, router]);

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
    setFormError(null);
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
        // FR-032 — the void is irreversible (§87 number retired), so route the
        // failure to an INLINE focused role="alert" (the dialog stays open); a
        // concurrent 409 (already voided/paid elsewhere) shows the "already
        // voided — refresh" prompt instead of a raw error.
        const routing = routeVoidError(code);
        if (routing.kind === 'concurrent') {
          setFormError({ kind: 'concurrent' });
        } else {
          const message =
            routing.messageKey === 'errors.codeFallback' && routing.codeArg
              ? t('errors.codeFallback', { code: routing.codeArg })
              : t(routing.messageKey as 'errors.unknown');
          setFormError({ kind: 'failure', message });
        }
        return;
      }
      // FR-032 — doc-specific success toast: the invoice's document number is
      // known here (it IS the typed-phrase gate), so name it.
      toast.success(t('successWithNumber', { number: documentNumber }));
      router.push(`/admin/invoices/${invoiceId}`);
    });
  }, [canSubmit, invoiceId, reason, documentNumber, t, router]);

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
      <InlineAlert tone="destructive">
        <AlertTriangleIcon aria-hidden="true" />
        <InlineAlertTitle>
          {t('voiding')}{' '}
          <span className="font-mono">{documentNumber}</span>
        </InlineAlertTitle>
        <InlineAlertDescription>{t('terminalNotice')}</InlineAlertDescription>
      </InlineAlert>

      {/* 088 FR-032 — inline, focused failure surface for the irreversible void
          mutation (never a transient toast). `tabIndex={-1}` + the focus effect
          move focus here so the admin cannot miss it. A concurrent 409 shows a
          "refresh" prompt; other failures show a destructive alert. */}
      {formError && (
        <InlineAlert
          ref={errorRef}
          tabIndex={-1}
          tone={formError.kind === 'failure' ? 'destructive' : 'neutral'}
          className="outline-none"
          data-testid="void-invoice-error"
        >
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          {formError.kind === 'concurrent' ? (
            <InlineAlertDescription className="flex flex-col items-start gap-2">
              <span>{t('errors.concurrent')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-[44px]"
                onClick={() => router.refresh()}
              >
                {t('errors.refreshAction')}
              </Button>
            </InlineAlertDescription>
          ) : (
            <InlineAlertDescription>{formError.message}</InlineAlertDescription>
          )}
        </InlineAlert>
      )}

      <div className="grid gap-2">
        <Label htmlFor="void-reason">{t('reasonLabel')}</Label>
        <Textarea
          id="void-reason"
          ref={reasonRef}
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

      {/* CR-6: Cancel-first DOM order matches AlertDialog default
        * (safer destructive action). Visual order on desktop is still
        * Cancel-then-Submit; on mobile they stack naturally. */}
      <div className="flex flex-row-reverse items-center justify-end gap-2 sm:flex-row sm:justify-start">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/admin/invoices/${invoiceId}`)}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!canSubmit}
          aria-busy={pending}
        >
          {pending && (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
