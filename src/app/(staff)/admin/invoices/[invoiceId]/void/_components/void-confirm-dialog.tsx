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
import type { FeedbackTone } from '@jirawatpyk/aura-react';
import { isReadOnlyRefusal, readProblemCode } from '@/lib/http/read-only-refusal';
import { routeVoidError } from './void-error-routing';
import { PhraseChip } from '../../../_components/phrase-chip';
import { refreshWhenOnline } from '../../../_components/refresh-when-online';
import { isUnknownOutcome, MONEY_POST_TIMEOUT_MS } from '../../../_components/unknown-outcome';
import { useStillWorking } from '../../../_components/use-still-working';

type VoidFormError =
  | { readonly kind: 'concurrent' }
  // #61 — no trustworthy answer: the void commits before its Phase-2 work, so
  // a drop, the timeout or a 5xx naming no refusal may come after it voided.
  | { readonly kind: 'unconfirmed' }
  // The READ_ONLY_MODE freeze refused it: nothing was written.
  | { readonly kind: 'readOnly' }
  | { readonly kind: 'failure'; readonly message: string };

/** One tone per kind; a new kind must pick one (the wrapper's `data-tone` follows). */
const VOID_ERROR_TONE = {
  concurrent: { alert: 'info', wrapper: 'neutral' },
  unconfirmed: { alert: 'warning', wrapper: 'warning' },
  readOnly: { alert: 'warning', wrapper: 'warning' },
  failure: { alert: 'danger', wrapper: 'destructive' },
} as const satisfies Record<VoidFormError['kind'], { alert: FeedbackTone; wrapper: string }>;

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  /** An 088 SC bill: the confirmation asks for the bill number (board Admin-void). */
  readonly isBill?: boolean;
};

export function VoidConfirmDialog({ invoiceId, documentNumber, isBill = false }: Props) {
  const t = useTranslations('admin.invoices.void');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();
  const stillWorking = useStillWorking(pending);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  // 088 T021a / FR-032 — voiding RETIRES the §87 document number (terminal,
  // irreversible-in-effect), so a failure MUST NOT be a transient toast: it is
  // surfaced INLINE via a focused role="alert". A concurrent 409 (already
  // voided/paid) shows an inline "already voided — refresh".
  const [formError, setFormError] = useState<VoidFormError | null>(null);
  // #61 — Refresh was pressed offline: it runs once the connection is back.
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  // Set before the POST, synchronously: `pending` flips only on the next
  // render, so a second submit in the same tick would otherwise void twice.
  const inFlightRef = useRef(false);
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
    if (!canSubmit || inFlightRef.current) return;
    setFormError(null);
    setWaitingForConnection(false);
    inFlightRef.current = true;
    startTransition(async () => {
      // Held after a success: the page navigates away.
      let voided = false;
      try {
        let res: Response;
        try {
          res = await fetch(`/api/invoices/${invoiceId}/void`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voidReason: reason.trim() }),
            signal: AbortSignal.timeout(MONEY_POST_TIMEOUT_MS),
          });
        } catch {
          // #61 — no response (a drop or the timeout): the void may have
          // committed. A retry is safe (the server refuses a voided invoice),
          // but check first.
          setFormError({ kind: 'unconfirmed' });
          return;
        }
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          // The write freeze refused it: nothing ran (its flat body names no code).
          if (isReadOnlyRefusal(res.status, body)) {
            setFormError({ kind: 'readOnly' });
            return;
          }
          const problem = readProblemCode(body);
          // #61 — a 5xx naming no refusal may come after the void committed.
          if (isUnknownOutcome(res.status, problem)) {
            setFormError({ kind: 'unconfirmed' });
            return;
          }
          // Route codes are nested; a flat string is not one (read-only aside).
          const code = problem?.shape === 'nested' ? problem.code : undefined;
          // FR-032 — the void is irreversible (§87 number retired), so route the
          // failure to an INLINE focused role="alert" (the page stays put); a
          // concurrent 409 (already voided/paid) shows the "already voided —
          // refresh" prompt instead of a raw error.
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
        voided = true;
        router.push(`/admin/invoices/${invoiceId}`);
      } finally {
        if (!voided) inFlightRef.current = false;
      }
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
          data-tone={VOID_ERROR_TONE[formError.kind].wrapper}
          className="outline-none"
          data-testid="void-invoice-error"
        >
          <Alert
            role="none"
            tone={VOID_ERROR_TONE[formError.kind].alert}
            action={
              formError.kind === 'concurrent' || formError.kind === 'unconfirmed' ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  touchHeight
                  aria-disabled={waitingForConnection || undefined}
                  onClick={() => {
                    if (waitingForConnection) return;
                    // This page answers notFound() once the invoice is no
                    // longer issued, so a refresh would land on a 404: open
                    // the invoice instead (#727 review). Offline, a navigation
                    // falls onto the browser's offline page, so wait for the
                    // connection (#48); the page stays mounted, so the wait
                    // clears when it runs.
                    const outcome = refreshWhenOnline(
                      { refresh: () => router.push(`/admin/invoices/${invoiceId}`) },
                      () => setWaitingForConnection(false),
                    );
                    if (outcome === 'waiting') setWaitingForConnection(true);
                  }}
                >
                  {waitingForConnection ? t('errors.waitingForConnection') : t('errors.openInvoiceAction')}
                </Button>
              ) : undefined
            }
          >
            {formError.kind === 'concurrent'
              ? t('errors.concurrent')
              : formError.kind === 'unconfirmed'
                ? t('errors.unconfirmed')
                : formError.kind === 'readOnly'
                  ? `${tErrors('readOnlyMode')} ${tErrors('readOnlyNothingChanged')}`
                  : formError.message}
          </Alert>
        </div>
      )}
      {/* #61 — the offline wait and the 10 s "still working" note, announced
          once, outside the alert region; visible too, so nobody closes the
          tab during a long wait. */}
      <div role="status" aria-live="polite" className="min-h-5 text-sm text-[var(--aura-fg-secondary)]">
        {waitingForConnection
          ? t('errors.waitingForConnection')
          : stillWorking
            ? t('errors.stillWorking')
            : ''}
      </div>

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
              // Board Admin-void: the number in its own chip, with a copy
              // button, between the label and the box (AURA 5.31 labelAddon).
              // The addon stays out of the description so the copy button's
              // name isn't read; the chip's id comes first instead.
              labelAddon={<PhraseChip id="void-confirm-phrase" phrase={confirmPhrase} testId="void-confirm-chip" />}
              labelAddonDescribes={false}
              aria-describedby={typed.length > 0 && !matches ? 'void-confirm-phrase void-confirm-error' : 'void-confirm-phrase'}
            />
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
      <div className="flex justify-end gap-[var(--aura-space-2)] max-sm:flex-col-reverse">
        <Button
          type="button"
          variant="secondary"
          fullWidth="below-sm"
          onClick={() => router.push(`/admin/invoices/${invoiceId}`)}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
        {/* A destructive action carries the board's icon (Admin-void; § Button icons). */}
        <Button
          type="submit"
          variant="danger"
          fullWidth="below-sm"
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
