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
import { toast } from '@/lib/toast';
import { ArchiveIcon } from 'lucide-react';
import { Alert, Button, Card, TextField, Textarea } from '@jirawatpyk/aura-react';
import { routeVoidError } from './void-error-routing';
import { PhraseChip } from '../../../_components/phrase-chip';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  /** An 088 SC bill: the confirmation asks for the bill number (board Admin-void). */
  readonly isBill?: boolean;
};

export function VoidConfirmDialog({ invoiceId, documentNumber, isBill = false }: Props) {
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

  // CR-6: initial focus on the reason field — MOUNT ONLY, deliberately split
  // from the Esc effect below. It must NOT share that effect's `pending`
  // dependency: a re-run on the transition's pending true→false flip fires
  // AFTER the `formError` effect above (effects run in declaration order) and
  // stole focus back off the error alert, silently defeating the FR-032
  // "focused, unmissable failure" guarantee for this irreversible mutation.
  useEffect(() => {
    reasonRef.current?.focus();
  }, []);

  // CR-6: Esc → cancel route (re-subscribes on `pending` for a fresh closure).
  useEffect(() => {
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
      //
      // 108 FR-004 (round-5 finding #4) — and say whether the §86/10
      // cancellation notice actually LEFT. `voidInvoice` skips it when the
      // member has no live primary contact; the route reports that as
      // `email_delivery`, and this success path used to ignore the body
      // entirely and navigate away. The void succeeded either way, so this is a
      // warning toast, not an error: the statutory act is done, but nobody was
      // told, and this page is the only place the admin will be looking.
      const body = (await res.json().catch(() => null)) as
        | { email_delivery?: string }
        | null;
      if (body?.email_delivery === 'skipped_no_recipient') {
        toast.warning(t('successWithNumberNoNotice', { number: documentNumber }));
      } else {
        toast.success(t('successWithNumber', { number: documentNumber }));
      }
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
      {/* UX-1 — the terminal-action warning in AURA's danger tone, naming the
        * document (boards Admin-void, -mobile). `role="note"`: it is standing
        * copy, not a live event. */}
      <Alert
        tone="danger"
        role="note"
        title={
          <>
            {t('voiding')} <span className="font-mono">{documentNumber}</span>
          </>
        }
      >
        {t('terminalNotice')}
      </Alert>

      {/* 088 FR-032 — inline, focused failure surface for the irreversible void
          mutation (never a transient toast). The wrapper is the live region
          and takes focus; the AURA alert inside only draws it. A concurrent
          409 shows a "refresh" prompt; other failures a danger alert. */}
      {formError && (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          data-tone={formError.kind === 'failure' ? 'destructive' : 'neutral'}
          className="outline-none"
          data-testid="void-invoice-error"
        >
          <Alert
            role="none"
            tone={formError.kind === 'failure' ? 'danger' : 'info'}
            action={
              formError.kind === 'concurrent' ? (
                <Button type="button" variant="secondary" size="sm" touchHeight onClick={() => router.refresh()}>
                  {t('errors.refreshAction')}
                </Button>
              ) : undefined
            }
          >
            {formError.kind === 'concurrent' ? t('errors.concurrent') : formError.message}
          </Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-[var(--aura-space-5)]">
          <div className="flex flex-col gap-1">
            <Textarea
              id="void-reason"
              ref={reasonRef}
              label={t('reasonLabel')}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              aria-describedby="void-reason-help"
              // UX-3 — surface empty-state invalidity to SR once user has
              // touched and cleared the field (non-empty → empty-after-trim).
              aria-invalid={reason.length > 0 && !reasonValid}
            />
            <p
              id="void-reason-help"
              className="text-xs text-[var(--aura-fg-secondary)]"
              // UX-4 — announce character-counter updates to screen readers.
              aria-live="polite"
            >
              {t('reasonHelp')} ({reason.length}/500)
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <TextField
              id="void-confirm"
              label={t(isBill ? 'confirmCopyBill' : 'confirmCopy')}
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
              // The number chip first, so a screen reader hears what to type.
              aria-describedby={typed.length > 0 && !matches ? 'void-confirm-phrase void-confirm-error' : 'void-confirm-phrase'}
            />
            {/* Board Admin-void: the number in its own chip, with a copy button. */}
            <PhraseChip id="void-confirm-phrase" phrase={confirmPhrase} testId="void-confirm-chip" />
            {typed.length > 0 && !matches && (
              <p id="void-confirm-error" role="alert" className="text-xs text-[var(--aura-fg-danger)]">
                {t('confirmMismatch', { phrase: confirmPhrase })}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* CR-6: Cancel first in the DOM (the safe action first in tab order).
        * From 640px the row ends at the card's edge, Cancel then Void; on a
        * phone the buttons stack full width with Void on top (the mobile
        * board, spec Session 2026-10-02). */}
      <div className="flex justify-end gap-[var(--aura-space-2)] max-sm:flex-col-reverse max-sm:[&>*]:w-full">
        <Button
          type="button"
          variant="secondary"
          touchHeight
          onClick={() => router.push(`/admin/invoices/${invoiceId}`)}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
        {/* A destructive action carries the board's icon (Admin-void; § Button icons). */}
        <Button
          type="submit"
          variant="danger"
          touchHeight
          icon={<ArchiveIcon aria-hidden="true" />}
          loading={pending}
          disabled={!canSubmit}
        >
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
