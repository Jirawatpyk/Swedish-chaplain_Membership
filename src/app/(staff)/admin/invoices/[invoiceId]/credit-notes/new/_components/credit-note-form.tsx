'use client';

/**
 * T080 — Issue Credit Note client form (F4 / US6).
 *
 * FR-040 — typed-phrase confirmation ("CREDIT" since the credit-note
 * document number is ONLY known post-commit). Same locale-case-insensitive
 * compare as `issue-invoice-dialog.tsx` / `archive-member-button`.
 *
 * UX:
 *  - Amount input in THB (decimal), converted to satang on submit.
 *  - Reason textarea (required, 1-500 char).
 *  - Remainder display: shows how much of the invoice total is still
 *    creditable (invoice.total − invoice.credited_total).
 *  - Typed-phrase confirmation before the Submit button enables.
 *  - Post-commit: toast + router.refresh() + navigate to invoice detail.
 *  - Payment channel shown in the summary. When the invoice has a refundable
 *    online (card / PromptPay) payment, a warning steers staff to Issue
 *    refund — a credit note moves no money, yet it consumes the headroom the
 *    refund is capped at — and submit requires an explicit acknowledgement
 *    (mirrors the server's `online_payment_refundable` guard).
 */
import { useEffect, useMemo, useRef, useState, useTransition, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Button, Card, Checkbox, Dialog, RadioGroup, TextField, Textarea, buttonClass } from '@jirawatpyk/aura-react';
import type { FeedbackTone } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { formatSatangThb } from '@/lib/format-thb';
import { isReadOnlyRefusal, readProblemCode } from '@/lib/http/read-only-refusal';
import { routeCreditNoteError } from './credit-note-error-routing';
import { cancelPendingRefresh, refreshWhenOnline } from '../../../../_components/refresh-when-online';
import { isUnknownOutcome, MONEY_POST_TIMEOUT_MS } from '../../../../_components/unknown-outcome';
import { useStillWorking } from '../../../../_components/use-still-working';

type CreditNoteFormError =
  | { readonly kind: 'concurrent' }
  // #61 — no trustworthy answer: the note commits before `requestMembershipEnd`
  // runs, so a drop, the timeout or a 5xx naming no refusal may come after a
  // §86/10 note was minted.
  // `amount` names the attempt's credit; `refusal` is what refused a retry
  // made before the key lookup (the attempt stays open, #728 review).
  | { readonly kind: 'unconfirmed'; readonly amount: string; readonly refusal?: string }
  // The READ_ONLY_MODE freeze refused it: nothing was written.
  | { readonly kind: 'readOnly' }
  | { readonly kind: 'failure'; readonly message: string };

/** One tone per kind; a new kind must pick one (the wrapper's `data-tone` follows). */
const CREDIT_NOTE_ERROR_TONE = {
  concurrent: { alert: 'info', wrapper: 'neutral' },
  unconfirmed: { alert: 'warning', wrapper: 'warning' },
  readOnly: { alert: 'warning', wrapper: 'warning' },
  failure: { alert: 'danger', wrapper: 'destructive' },
} as const satisfies Record<CreditNoteFormError['kind'], { alert: FeedbackTone; wrapper: string }>;

/** F-2 (2026-07-08) — membership-effect intent, mirrors the use-case's enum. */
type MembershipEffect = 'keep' | 'cancel_membership';

/** #66 — the request one issue attempt sends, every time, under its key. */
type AttemptRequest = {
  readonly invoiceId: string;
  readonly creditTotalSatang: string;
  readonly reason: string;
  readonly membershipEffect?: MembershipEffect;
  readonly onlinePaymentRefundAcknowledged?: true;
  readonly idempotencyKey: string;
};
type Attempt = { readonly key: string; readonly body: string; readonly request: AttemptRequest };

/**
 * #728 review — after an unknown outcome, only these refusals end the attempt:
 * the use case makes them under the invoice lock, after the key lookup missed,
 * so no note exists under the key. `invoice_not_found` can come before the
 * lookup, but a note's invoice is its RESTRICT FK parent: no invoice, no note. Anything else (a rate limit, the session,
 * the write freeze, the pre-tx refund guards, a 5xx) keeps the key and the lock.
 */
const ENDS_ATTEMPT_AFTER_UNKNOWN: ReadonlySet<string> = new Set([
  'invalid_status',
  'credit_exceeds_remainder',
  'concurrent_state_change',
  'receipt_not_creditable',
  'receipt_not_rendered',
  'membership_effect_required',
  'invoice_not_found',
  'no_snapshot_on_invoice',
  'invalid_event_invoice',
  'settings_missing',
  'overflow',
  // Task 68 — the key was closed with "Start over": nothing will be issued.
  'attempt_abandoned',
]);

/** The replay and Start over toasts outlast the move to the invoice (R123). */
const LASTING_TOAST_MS = 10_000;

/** The stored attempt for this invoice, or null (a malformed one is dropped). */
function readStoredAttempt(storageKey: string, invoiceId: string): Attempt | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { key?: unknown; body?: unknown };
    if (typeof parsed.key === 'string' && typeof parsed.body === 'string') {
      const request = JSON.parse(parsed.body) as Partial<AttemptRequest>;
      if (
        request.idempotencyKey === parsed.key &&
        request.invoiceId === invoiceId &&
        typeof request.creditTotalSatang === 'string' &&
        /^[1-9]\d*$/.test(request.creditTotalSatang) &&
        typeof request.reason === 'string'
      ) {
        return { key: parsed.key, body: parsed.body, request: request as AttemptRequest };
      }
    }
  } catch {
    // Malformed: dropped below.
  }
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing to drop.
  }
  return null;
}

/**
 * How the invoice was paid: an online F5 payment (`card` / `promptpay`) or a
 * manually-recorded method. `null` when it could not be determined.
 */
export type CreditNotePaymentChannel =
  | 'card'
  | 'promptpay'
  | 'bank_transfer'
  | 'cheque'
  | 'cash'
  | 'other';

/**
 * Whether an online payment on the invoice still has refundable money —
 * `unknown` when the payments read failed (treated like `refundable`, matching
 * the server's fail-closed guard).
 */
export type OnlineRefundState = 'none' | 'refundable' | 'unknown';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly remainingSatang: string;
  readonly currencySymbol: string;
  /**
   * F-2 (2026-07-08) — the membership-effect radio only ever shows for a
   * `'membership'` invoice whose credited amount fully credits it; an
   * `'event'` invoice never asks.
   */
  readonly invoiceSubject: 'membership' | 'event';
  readonly paymentChannel: CreditNotePaymentChannel | null;
  readonly onlineRefundState: OnlineRefundState;
};

/** The creditable remainder via the shared THB formatter ("38,520.00 THB"). */
function formatRemaining(satang: string, locale: string, currency: string): string {
  // SG-1 — clamp negatives to 0 defensively. Under normal state the
  // remainder is always ≥ 0 (DB CHECK `invoices_credited_total_in_range`
  // enforces it), but a stale-server-render race mid-rollup could
  // momentarily surface a negative value. Showing "0.00" reads
  // cleaner than "-0.01" and matches the enforce policy's own
  // `remainingSatang < 0n ? 0n` clamp.
  const raw = BigInt(satang);
  return formatSatangThb(raw < 0n ? 0n : raw, locale, currency);
}

export function CreditNoteForm({
  invoiceId,
  documentNumber,
  remainingSatang,
  currencySymbol,
  invoiceSubject,
  paymentChannel,
  onlineRefundState,
}: Props) {
  const t = useTranslations('admin.creditNotes.new');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const [amountThb, setAmountThb] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  // F-2 (2026-07-08) — default 'keep' per the design doc; only read/sent when
  // `showMembershipEffect` is true (see below).
  const [membershipEffect, setMembershipEffect] = useState<MembershipEffect>('keep');
  const [onlineRefundAcknowledged, setOnlineRefundAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();
  const stillWorking = useStillWorking(pending);

  // 088 T021a / FR-032 — issuing a credit note MINTS a §87 tax-document number
  // in-tx and moves the invoice to credited; it cannot be rolled back
  // client-side, so a failure MUST NOT be a transient toast: it is surfaced
  // INLINE via a focused role="alert" so the admin cannot miss it. A concurrent
  // 409 is shown as an inline "already credited/voided — refresh".
  const [formError, setFormError] = useState<CreditNoteFormError | null>(null);
  // Bumped on every unconfirmed answer: the alert is keyed on it, so a retry
  // that comes back unconfirmed again is announced again and takes focus.
  const [alertSeq, setAlertSeq] = useState(0);
  // #61 / #66 — after an unknown outcome the attempt is locked: every field is
  // read-only and the submit disabled, so no DIFFERENT request goes out under
  // the attempt's idempotency key; the alert offers "Try again" (the same
  // request, the same key: the server answers with the note already issued,
  // if any) and "Open invoice".
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  // An offline action waits for the connection (#48); one of the two at a time.
  const [waitingFor, setWaitingFor] = useState<'open' | 'retry' | null>(null);
  // Set before the POST, synchronously: `pending` flips only on the next
  // render, so a second submit in the same tick would otherwise mint twice.
  const inFlightRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  const confirmPhrase = t('confirmPhrase');
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  const proposedSatang = useMemo(() => {
    if (!amountThb.trim()) return null;
    // THB decimal → satang. Enforce half-away-from-zero via toFixed(2).
    const n = Number(amountThb);
    if (!Number.isFinite(n) || n <= 0) return null;
    const [intPart, fracPartRaw = '00'] = n.toFixed(2).split('.');
    const fracPadded = (fracPartRaw + '00').slice(0, 2);
    return BigInt(intPart!) * 100n + BigInt(fracPadded);
  }, [amountThb]);

  const remainingBi = BigInt(remainingSatang);
  const exceedsRemainder =
    proposedSatang !== null && proposedSatang > remainingBi;

  const amountValid =
    proposedSatang !== null && proposedSatang > 0n && !exceedsRemainder;
  const reasonValid = reason.trim().length > 0 && reason.trim().length <= 500;
  // F-2 (2026-07-08) — a FULL credit is exactly the remainder (the
  // `exceedsRemainder` check above already blocks anything greater).
  // Mirrors the use-case's own `isFullCredit` derivation server-side.
  const isFullCredit = proposedSatang !== null && proposedSatang === remainingBi;
  // #728 round 2 (UX M-B) — a locked attempt shows the choice it carries even
  // when the remainder read after a reload no longer makes it a full credit.
  const [attemptEffect, setAttemptEffect] = useState<MembershipEffect | null>(null);
  const showMembershipEffect =
    invoiceSubject === 'membership' && (isFullCredit || (outcomeUnknown && attemptEffect !== null));
  // Any amount, not just a full credit: a partial CN of X makes X of the
  // online payment unrefundable the same way.
  const requiresOnlineAck = onlineRefundState !== 'none';
  const canSubmit =
    amountValid &&
    reasonValid &&
    matches &&
    (!requiresOnlineAck || onlineRefundAcknowledged) &&
    !outcomeUnknown &&
    !pending;

  // #66 — one issue attempt: its idempotency key and the exact request sent
  // under it, kept in sessionStorage (written before each POST) until the
  // server gives a definite answer. A reload restores it locked, so "Try
  // again" resends the same request — never a new amount under an old key.
  // Storage can be unavailable (private mode, blocked site data): the
  // in-memory copy still covers retries on this page.
  const attemptRef = useRef<Attempt | null>(null);
  // Sticky per attempt: an outcome was unknown at least once, so a note may
  // exist under the key and only a refusal made after the key lookup ends it.
  const unknownRef = useRef(false);
  const storageKey = `cn-attempt:${invoiceId}`;
  const saveAttempt = useCallback(
    (attempt: Attempt) => {
      attemptRef.current = attempt;
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify({ key: attempt.key, body: attempt.body }));
      } catch {
        // In-memory only.
      }
    },
    [storageKey],
  );
  const endAttempt = useCallback(() => {
    attemptRef.current = null;
    unknownRef.current = false;
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      // Nothing stored.
    }
  }, [storageKey]);

  const formatAmount = useCallback(
    (attempt: Attempt) => formatSatangThb(BigInt(attempt.request.creditTotalSatang), locale, currencySymbol),
    [locale, currencySymbol],
  );
  const failureText = useCallback(
    (failure: CreditNoteFormError): string =>
      failure.kind === 'concurrent'
        ? t('errors.concurrent')
        : failure.kind === 'readOnly'
          ? `${tErrors('readOnlyMode')} ${tErrors('readOnlyNothingChanged')}`
          : failure.kind === 'failure'
            ? failure.message
            : '',
    [t, tErrors],
  );
  // After a closed attempt the next note needs its own typed confirmation and
  // acknowledgement, and starts from no stored membership effect.
  const disarmForNewNote = useCallback(() => {
    setAttemptEffect(null);
    setTyped('');
    setOnlineRefundAcknowledged(false);
  }, []);
  const markUnknown = useCallback(
    (attempt: Attempt, refusal?: string) => {
      unknownRef.current = true;
      setOutcomeUnknown(true);
      setAttemptEffect(attempt.request.membershipEffect ?? null);
      setFormError({ kind: 'unconfirmed', amount: formatAmount(attempt), ...(refusal ? { refusal } : {}) });
      setAlertSeq((n) => n + 1);
    },
    [formatAmount],
  );

  // #66 — a stored attempt means an earlier page never heard a definite
  // answer: restore it locked, with its values, so the admin finishes it.
  useEffect(() => {
    const stored = readStoredAttempt(storageKey, invoiceId);
    if (!stored) return;
    attemptRef.current = stored;
    const { request } = stored;
    const satang = BigInt(request.creditTotalSatang);
    setAmountThb(`${satang / 100n}.${(satang % 100n).toString().padStart(2, '0')}`);
    setReason(request.reason);
    // The typed phrase is NOT restored (FR-040): if this attempt ends on a
    // definite refusal, a new note still needs the admin to type it.
    if (request.membershipEffect) setMembershipEffect(request.membershipEffect);
    if (request.onlinePaymentRefundAcknowledged === true) setOnlineRefundAcknowledged(true);
    markUnknown(stored);
    // Mount only: the attempt is read once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = useCallback((attempt: Attempt, { retry }: { readonly retry: boolean }) => {
    if (inFlightRef.current) return;
    // A retry keeps the alert on screen while it runs (#728 review, UX M1).
    if (!retry) setFormError(null);
    // A navigation queued offline must not fire after this new attempt.
    cancelPendingRefresh();
    setWaitingFor(null);
    inFlightRef.current = true;
    saveAttempt(attempt);
    startTransition(async () => {
      // Held after a success: the page navigates away.
      let issued = false;
      try {
        let res: Response;
        try {
          res = await fetch('/api/credit-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: attempt.body,
            signal: AbortSignal.timeout(MONEY_POST_TIMEOUT_MS),
          });
        } catch {
          // #61 / #66 — no response (a drop or the timeout): the note may have
          // been issued. Keep the attempt; "Try again" resends it.
          markUnknown(attempt);
          return;
        }
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => ({}));
          // The write freeze refused it: nothing ran (its flat body names no code).
          const readOnly = isReadOnlyRefusal(res.status, body);
          const problem = readProblemCode(body);
          // #61 — a 5xx naming no refusal may come after the note was minted.
          if (!readOnly && isUnknownOutcome(res.status, problem)) {
            markUnknown(attempt);
            return;
          }
          // Route codes are nested; a flat string is not one (read-only aside).
          const code = problem?.shape === 'nested' ? problem.code : undefined;
          // FR-032 — the credit-note mint is irreversible, so route the failure to
          // an INLINE focused role="alert" (the form stays put); a concurrent 409
          // (voided / fully-credited / remainder-shrank) shows the "already
          // credited/voided — open the invoice" prompt.
          const routing = routeCreditNoteError(code);
          const failure: CreditNoteFormError = readOnly
            ? { kind: 'readOnly' }
            : routing.kind === 'concurrent'
              ? { kind: 'concurrent' }
              : {
                  kind: 'failure',
                  message:
                    routing.messageKey === 'errors.codeFallback' && routing.codeArg
                      ? t('errors.codeFallback', { code: routing.codeArg })
                      : t(routing.messageKey as 'errors.unknown'),
                };
          // #728 review (Thai-tax H-1) — after an unknown outcome, a refusal
          // made BEFORE the key lookup (rate limit, session, the write
          // freeze, the pre-tx refund guards) says nothing about the first
          // attempt: keep the key and the lock, and say what refused this try.
          if (unknownRef.current && (readOnly || code === undefined || !ENDS_ATTEMPT_AFTER_UNKNOWN.has(code))) {
            // Named as this try's refusal, so "nothing was changed" is not read
            // as "no note was issued" (UX L-4).
            markUnknown(attempt, t('errors.retryRefused', { reason: failureText(failure) }));
            return;
          }
          // A definite answer for this attempt: no note under its key.
          endAttempt();
          setOutcomeUnknown(false);
          // Closed by Start over in another tab: the same unlock as here.
          if (code === 'attempt_abandoned') disarmForNewNote();
          setFormError(failure);
          return;
        }
        endAttempt();
        // FR-032 — doc-specific success toast interpolating the freshly-minted
        // credit-note number (`document_number`, known only post-commit).
        // MEDIUM-5 — the email-delivery signal rides alongside: a
        // `skipped_no_recipient` value means the CN is still fully issued but the
        // buyer has no email on file, so the auto-email was skipped (non-blocking
        // description). `membership_end` (0306) is the same kind of non-blocking
        // signal for the requested end of the member's coverage. All fields come
        // from ONE parse of the success body.
        const successBody = (await res.json().catch(() => ({}))) as {
          document_number?: string | null;
          email_delivery?: string;
          membership_end?: string;
          replayed?: boolean;
        };
        const cnNumber =
          typeof successBody.document_number === 'string' && successBody.document_number
            ? successBody.document_number
            : null;
        // #66 — a replay answered with the note an earlier attempt issued.
        const title =
          successBody.replayed === true
            ? cnNumber
              ? t('successAlreadyIssued', { number: cnNumber })
              : t('successAlreadyIssuedNoNumber')
            : cnNumber
              ? t('successWithNumber', { number: cnNumber })
              : t('success');
        const noticeParts: string[] = [];
        if (successBody.email_delivery === 'skipped_no_recipient') {
          noticeParts.push(t('emailSkippedNoRecipient'));
        }
        // 0306 — the outcome of ending the member's coverage (present only when
        // staff chose to end it). `ended` confirms; the rest explain what is
        // still pending or needs follow-up. The credit note is issued either way.
        const membershipEndKey = (
          {
            ended: 'membershipEnd.ended',
            deferred: 'membershipEnd.deferred',
            no_open_cycle: 'membershipEnd.noOpenCycle',
            failed: 'membershipEnd.failed',
          } as const
        )[successBody.membership_end as 'ended' | 'deferred' | 'no_open_cycle' | 'failed'];
        if (membershipEndKey !== undefined) {
          noticeParts.push(t(membershipEndKey));
        }
        const lasting = successBody.replayed === true ? { duration: LASTING_TOAST_MS } : {};
        if (noticeParts.length > 0) {
          toast.success(title, { description: noticeParts.join(' '), ...lasting });
        } else if (successBody.replayed === true) {
          toast.success(title, lasting);
        } else {
          toast.success(title);
        }
        // Destination page (`/admin/invoices/[id]`) is a server component
        // that fetches fresh on mount; `router.refresh()` here would
        // invalidate the abandoned form route, not the target. Drop it.
        issued = true;
        router.push(`/admin/invoices/${invoiceId}`);
      } finally {
        if (!issued) inFlightRef.current = false;
      }
    });
  }, [disarmForNewNote, endAttempt, failureText, invoiceId, markUnknown, router, saveAttempt, t]);

  const submit = useCallback(() => {
    if (!canSubmit || proposedSatang === null) return;
    const key = crypto.randomUUID();
    const request: AttemptRequest = {
      invoiceId,
      creditTotalSatang: proposedSatang.toString(),
      reason: reason.trim(),
      // F-2 — only sent when the radio is actually shown; partial
      // credits and event invoices never touch membership, so the
      // field is omitted rather than sent-but-ignored.
      ...(showMembershipEffect ? { membershipEffect } : {}),
      ...(requiresOnlineAck && onlineRefundAcknowledged
        ? { onlinePaymentRefundAcknowledged: true }
        : {}),
      // #66 — the attempt's key (kept until a definite answer).
      idempotencyKey: key,
    };
    post({ key, body: JSON.stringify(request), request }, { retry: false });
  }, [
    canSubmit,
    proposedSatang,
    invoiceId,
    reason,
    showMembershipEffect,
    membershipEffect,
    requiresOnlineAck,
    onlineRefundAcknowledged,
    post,
  ]);

  // #66 — resend the unconfirmed attempt exactly (same key), so a note that was
  // already issued comes back instead of a second one.
  const retry = useCallback(() => {
    if (attemptRef.current) post(attemptRef.current, { retry: true });
  }, [post]);

  // Task 68 — "Start over": the server closes the key under the invoice lock
  // (or hands back the note the attempt had issued). The form never unlocks
  // on its own: the original request may still commit.
  const [startOverOpen, setStartOverOpen] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  // Set once the attempt was closed: the dialog's trigger is gone, so focus
  // goes to the amount the admin re-enters.
  const startedOverRef = useRef(false);
  const startOverFinalFocus = useCallback(
    (): HTMLElement | null => (startedOverRef.current ? document.getElementById('cn-amount') : null),
    [],
  );
  const startOver = useCallback(async () => {
    const attempt = attemptRef.current;
    if (!attempt || startingOver || inFlightRef.current) return;
    setStartingOver(true);
    const stayLocked = (refusal = t('startOver.failed')) => {
      setStartOverOpen(false);
      markUnknown(attempt, refusal);
    };
    try {
      let res: Response;
      try {
        res = await fetch('/api/credit-notes/attempts/abandon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoiceId, idempotencyKey: attempt.key }),
          signal: AbortSignal.timeout(MONEY_POST_TIMEOUT_MS),
        });
      } catch {
        stayLocked();
        return;
      }
      const raw: unknown = await res.json().catch(() => ({}));
      // The write freeze refused it: nothing ran, and trying again cannot work
      // until it lifts, so say so rather than "Start over again".
      if (!res.ok && isReadOnlyRefusal(res.status, raw)) {
        stayLocked(`${tErrors('readOnlyMode')} ${tErrors('readOnlyNothingChanged')}`);
        return;
      }
      const body = (res.ok ? raw : {}) as {
        outcome?: string;
        document_number?: string | null;
      };
      if (body.outcome === 'issued') {
        // The attempt had issued its note: the same answer as a replay.
        endAttempt();
        setStartOverOpen(false);
        toast.success(
          body.document_number
            ? t('successAlreadyIssued', { number: body.document_number })
            : t('successAlreadyIssuedNoNumber'),
          { duration: LASTING_TOAST_MS },
        );
        router.push(`/admin/invoices/${invoiceId}`);
        return;
      }
      if (body.outcome === 'abandoned') {
        endAttempt();
        startedOverRef.current = true;
        setOutcomeUnknown(false);
        setFormError(null);
        disarmForNewNote();
        setStartOverOpen(false);
        toast.success(t('startOver.done'), { duration: LASTING_TOAST_MS });
        return;
      }
      stayLocked();
    } finally {
      setStartingOver(false);
    }
  }, [disarmForNewNote, endAttempt, invoiceId, markUnknown, router, startingOver, t, tErrors]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // method="post" — CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx
      method="post"
      className="flex flex-col gap-6"
    >
      {/* 088 FR-032 — inline, focused failure surface for the irreversible §87
          credit-note mint (never a transient toast). `tabIndex={-1}` + the focus
          effect move focus here so the admin cannot miss it. A concurrent 409
          shows a "refresh" prompt; other failures show a destructive alert. */}
      {formError && (
        // The wrapper is the live region and takes focus; the AURA alert
        // inside only draws it (`role="none"`, so it is announced once).
        <div
          key={alertSeq}
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          data-tone={CREDIT_NOTE_ERROR_TONE[formError.kind].wrapper}
          className="outline-none"
          data-testid="credit-note-error"
        >
          <Alert
            role="none"
            tone={CREDIT_NOTE_ERROR_TONE[formError.kind].alert}
            action={
              formError.kind === 'concurrent' || formError.kind === 'unconfirmed' ? (
                <div className="flex flex-wrap gap-[var(--aura-space-2)]">
                {/* #66 — the attempt carries an idempotency key, so resending it
                    cannot issue a second note: the server answers with the
                    one already issued, if any. */}
                {formError.kind === 'unconfirmed' && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    touchHeight
                    // aria-disabled, not disabled: the button keeps focus while
                    // the retry runs (#728 review, UX M1).
                    loading={pending}
                    aria-disabled={pending || waitingFor !== null || undefined}
                    onClick={() => {
                      if (pending || waitingFor !== null) return;
                      // Offline, the POST would fail at once and read as
                      // unconfirmed again: wait for the connection (UX M3).
                      const outcome = refreshWhenOnline({ refresh: retry }, () => setWaitingFor(null));
                      if (outcome === 'waiting') setWaitingFor('retry');
                    }}
                  >
                    {waitingFor === 'retry' ? t('errors.waitingForConnection') : t('errors.retryAction')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  touchHeight
                  aria-disabled={waitingFor !== null || undefined}
                  onClick={() => {
                    if (waitingFor !== null) return;
                    // Go to the invoice: it lists the notes, and this page
                    // answers notFound() for a fully credited or voided
                    // invoice, so a refresh could land on a 404 (#727
                    // review). Offline, a navigation falls onto the browser's
                    // offline page, so wait for the connection (#48); the
                    // page stays mounted, so the wait clears when it runs.
                    const outcome = refreshWhenOnline(
                      { refresh: () => router.push(`/admin/invoices/${invoiceId}`) },
                      () => setWaitingFor(null),
                    );
                    if (outcome === 'waiting') setWaitingFor('open');
                  }}
                >
                  {waitingFor === 'open' ? t('errors.waitingForConnection') : t('errors.openInvoiceAction')}
                </Button>
                {formError.kind === 'unconfirmed' && (
                  <Dialog
                    role="alertdialog"
                    open={startOverOpen}
                    onOpen={() => {
                      startedOverRef.current = false;
                      setStartOverOpen(true);
                    }}
                    onClose={() => setStartOverOpen(false)}
                    dismissible={!startingOver}
                    finalFocus={startOverFinalFocus}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        touchHeight
                        aria-disabled={pending || startingOver || waitingFor !== null || undefined}
                      >
                        {t('startOver.action')}
                      </Button>
                    }
                    title={t('startOver.title')}
                    description={t('startOver.body')}
                    footer={
                      <>
                        <Button
                          type="button"
                          variant="secondary"
                          data-autofocus
                          aria-disabled={startingOver || undefined}
                          onClick={() => setStartOverOpen(false)}
                        >
                          {t('startOver.cancel')}
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          loading={startingOver}
                          onClick={() => void startOver()}
                        >
                          {t('startOver.confirm')}
                        </Button>
                      </>
                    }
                  />
                )}
                </div>
              ) : undefined
            }
          >
            {formError.kind === 'concurrent'
              ? t('errors.concurrent')
              : formError.kind === 'unconfirmed'
                ? (
                    <div className="flex flex-col gap-[var(--aura-space-2)]">
                      {formError.refusal && <p>{formError.refusal}</p>}
                      <p>{t('errors.unconfirmed', { amount: formError.amount })}</p>
                    </div>
                  )
                : failureText(formError)}
          </Alert>
        </div>
      )}
      {/* #61 — the offline wait and the 10 s "still working" note, announced
          once, outside the alert region; visible too, so nobody closes the
          tab during a long wait. */}
      {/* R124: idle, it is empty and `empty:-mt-*` cancels the stack gap
          before it, so the form shows one gap, not gap + row + gap. While a
          request runs it reserves its line, so a later "still working" line
          moves nothing. It stays mounted: a live region added or unhidden as
          its text arrives is skipped by some screen readers. */}
      <div role="status" aria-live="polite" className={`text-sm text-[var(--aura-fg-secondary)] ${pending || waitingFor !== null ? 'min-h-5' : 'empty:-mt-6'}`}>
        {waitingFor !== null
          ? t('errors.waitingForConnection')
          : stillWorking
            ? t('errors.stillWorking')
            : null}
      </div>
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-5)]">
          <div className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-3 text-sm">
            <p className="text-[var(--aura-fg-secondary)]">
              {t('againstInvoice')}{' '}
              <span className="font-mono font-medium text-[var(--aura-fg-primary)]">
                {documentNumber}
              </span>
            </p>
            <p className="mt-1">
              {t('remainingLabel')}{' '}
              <span className="font-medium tabular-nums">
                {formatRemaining(remainingSatang, locale, currencySymbol)}
              </span>
            </p>
            <p className="mt-1">
              {t('paidViaLabel')}{' '}
              <span className="font-medium" data-testid="cn-payment-channel">
                {t(`paymentChannel.${paymentChannel ?? 'unknown'}`)}
              </span>
            </p>
          </div>

          {/* A credit note moves NO money. On an online-paid invoice the refund is
              the Issue refund action (it issues its own credit note); a manual
              credit note here also shrinks what that action can still refund. */}
          {requiresOnlineAck && (
            <Alert
              tone="warning"
              role="note"
              data-testid="cn-online-payment-warning"
              title={onlineRefundState === 'unknown' ? t('onlinePayment.unknownTitle') : t('onlinePayment.title')}
            >
              <div className="flex flex-col items-start gap-3">
                <p>{onlineRefundState === 'unknown' ? t('onlinePayment.unknownBody') : t('onlinePayment.body')}</p>
                <Link
                  href={`/admin/invoices/${invoiceId}?refund=1`}
                  className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
                >
                  {t('onlinePayment.refundAction')}
                </Link>
                <Checkbox
                  checked={onlineRefundAcknowledged}
                  disabled={outcomeUnknown}
                  onChange={(checked: boolean) => setOnlineRefundAcknowledged(checked)}
                >
                  {t('onlinePayment.acknowledge')}
                </Checkbox>
              </div>
            </Alert>
          )}

          <div className="flex flex-col gap-1">
            <TextField
              id="cn-amount"
              label={t('amountLabel')}
              required
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amountThb}
              readOnly={outcomeUnknown}
              onChange={(e) => setAmountThb(e.target.value)}
              suffix={currencySymbol}
              aria-describedby="cn-amount-help"
              // A locked attempt's amount is not an input error: after a reload
              // the remainder may already reflect the note it issued (UX M-A).
              aria-invalid={!outcomeUnknown && (exceedsRemainder || (amountThb.length > 0 && !amountValid))}
            />
            <p id="cn-amount-help" className="text-xs text-[var(--aura-fg-secondary)]">
              {t('amountHelp')}
            </p>
            {exceedsRemainder && !outcomeUnknown && (
              <p role="alert" className="text-xs text-[var(--aura-fg-danger)]">
                {t('exceedsRemainder', {
                  remaining: formatRemaining(remainingSatang, locale, currencySymbol),
                })}
              </p>
            )}
          </div>

          {/* F-2 (2026-07-08) — mandatory intent capture, shown ONLY for a full
              credit on a membership invoice (partial credits + event invoices
              never touch membership). Defaults to 'keep', so the field is
              NEVER actually "missing" a value — `required`/`aria-required` is
              deliberately OMITTED: Base UI's hidden native radio inputs carry
              no shared `name` attribute, so a `required` unchecked sibling
              blocks native HTML5 form submission entirely (a real cross-
              browser bug, not just a jsdom quirk — verified by an RTL
              submit-never-fires regression during development). Fieldset +
              legend alone give the group an accessible name (WCAG) — that is
              sufficient since a valid selection always exists. */}
          {showMembershipEffect && (
            <div data-testid="cn-membership-effect-fieldset">
              <RadioGroup
                label={t('membershipEffect.legend')}
                name="cn-membership-effect"
                value={membershipEffect}
                disabled={outcomeUnknown}
                onChange={(v) => setMembershipEffect(v === 'cancel_membership' ? 'cancel_membership' : 'keep')}
                options={[
                  // Option 1b — 'keep' is a paperwork correction where the member
                  // was NOT refunded, so renewal coverage is retained.
                  { value: 'keep', label: t('membershipEffect.keep.label'), description: t('membershipEffect.keep.description') },
                  // This option triggers an F8 cascade that cancels the member's
                  // in-flight renewal cycles; its description says so.
                  {
                    value: 'cancel_membership',
                    label: t('membershipEffect.cancelMembership.label'),
                    description: t('membershipEffect.cancelMembership.description'),
                  },
                ]}
              />
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Textarea
              id="cn-reason"
              label={t('reasonLabel')}
              required
              value={reason}
              readOnly={outcomeUnknown}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              aria-describedby="cn-reason-help"
              // W1-10 (a11y): surface validity to AT like the amount/confirm fields.
              aria-invalid={reason.length > 0 && !reasonValid}
            />
            <p id="cn-reason-help" className="text-xs text-[var(--aura-fg-secondary)]">
              {t('reasonHelp')} ({reason.length}/500)
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <TextField
              id="cn-confirm"
              label={t('confirmCopy', { phrase: confirmPhrase })}
              value={typed}
              readOnly={outcomeUnknown}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmPhrase}
              autoComplete="off"
              inputMode="text"
              enterKeyHint="done"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !matches}
              aria-describedby={typed.length > 0 && !matches ? 'cn-confirm-error' : undefined}
            />
            {typed.length > 0 && !matches && (
              <p id="cn-confirm-error" role="alert" className="text-xs text-[var(--aura-fg-danger)]">
                {t('confirmMismatch', { phrase: confirmPhrase })}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Cancel then the primary action, at the card's end (board
          Admin-credit-note). On a phone they stack full width, the primary
          action on top (ux-standards § 11.1, as the void page); Cancel stays
          first in the DOM, so it is first in the tab order. */}
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
        <Button type="submit" variant="primary" icon="check" fullWidth="below-sm" loading={pending} disabled={!canSubmit}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
      {/* A disabled button can't take focus, so say why it is disabled. */}
      {outcomeUnknown && (
        <p className="-mt-4 text-end text-xs text-[var(--aura-fg-secondary)] max-sm:text-start" data-testid="cn-locked-hint">
          {t('submitLockedHint')}
        </p>
      )}
      {requiresOnlineAck && !onlineRefundAcknowledged && !outcomeUnknown && (
        <p className="-mt-4 text-end text-xs text-[var(--aura-fg-secondary)] max-sm:text-start" data-testid="cn-ack-required-hint">
          {t('onlinePayment.ackRequiredHint')}
        </p>
      )}
    </form>
  );
}
