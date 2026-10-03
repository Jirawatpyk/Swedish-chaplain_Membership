'use client';

/**
 * T114 + T116 — Refund form (F5 Phase 6 / US4 / FR-029).
 *
 * react-hook-form + zod resolver. Composes:
 *   - Amount input — inputmode="decimal", THB units; converted to
 *     satang on submit. Label-above + asterisk + live help-text
 *     "Up to {amount} (paid, less refunds and credit notes)…" per FR-029(b)
 *     and board Admin-refund-full; a valid amount adds the refund summary
 *     (the credit note to be issued — amount excl. VAT and VAT, read from
 *     the server — then refund total, still refundable afterwards) and names
 *     itself on Confirm.
 *   - Reason textarea — 500-char counter; aria-live polite.
 *   - <TypedPhraseConfirm> — renders ONLY when amount === remaining
 *     (full refund) per FR-029(f).
 *   - 0306 — when the amount FULLY credits a MEMBERSHIP invoice (amount ===
 *     the invoice's un-credited headroom), a warning states what Renewals
 *     does next (the period stops counting as paid, but access continues to
 *     period end, then normal reminders) and a Keep / End membership choice
 *     is sent as `membershipEffect`. End takes effect when the refund settles.
 *   - Cancel + Confirm buttons — Cancel default-focused; Confirm
 *     shows spinner while in flight.
 *
 * Submit pipeline:
 *   1. RHF validation (zod) — invalid blocks Confirm.
 *   2. POST /api/refunds/initiate — bigint amount as JSON number.
 *   3. On 201: toast.success with credit-note number; close dialog;
 *      router.refresh() to update payment timeline + status badges.
 *   4. On 4xx/5xx: inline alert above buttons (FR-029(g)) + a toast.
 *
 * Track B — a refund can legitimately carry NO §86/10 ใบลดหนี้ (the invoice was
 * voided, or the buyer holds a §105 receipt). Both success arms above therefore
 * branch on what actually documented the refund; rendering the credit-note copy
 * unconditionally is what produced "credit note  issued" with an empty number.
 */
import { useEffect, useRef, useState, useId, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, RadioGroup, Skeleton, TextField, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
// TYPE-ONLY, and it must stay that way. The invoicing barrel reaches
// server-only modules; a value import here would drag them into a client
// bundle. `import type` is erased at compile time, so this costs nothing at
// runtime while still binding the copy to F4's Domain vocabulary.
import type { CreditNoteWaiverReason } from '@/modules/invoicing';
import { useLocale } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { TypedPhraseConfirm } from './typed-phrase-confirm';
import { useCreditNotePreview } from './use-credit-note-preview';

const REASON_MAX = 500;

/**
 * Track B — the grounds on which a refund carries no §86/10 ใบลดหนี้.
 *
 * Typed against F4 Domain's `CreditNoteWaiverReason` rather than restated as a
 * loose string, so adding a reason there is a COMPILE error here instead of a
 * toast that silently renders the raw i18n key — next-intl does not throw on a
 * missing message, it returns `admin.refund.success.waivedReason.whatever`.
 */
type WaiverReason = CreditNoteWaiverReason;

/**
 * `snake_case` storage contract → `camelCase` i18n leaf. Mechanical on purpose:
 * `scripts/check-i18n-coverage.ts` derives the required key set from the same
 * Domain constant using this same transform, so a reason without copy fails the
 * build rather than reaching an admin.
 */
export function waiverKey(reason: WaiverReason): string {
  return reason.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// THB amount accepted as decimal string (e.g. "5350" or "5350.00").
// Server-side zod gates the satang upper bound (2_000_000_000); client
// schema mirrors the policy.
const buildSchema = (remainingThb: number) =>
  z.object({
    amountThb: z
      .string()
      .min(1, 'amountRequired')
      .regex(/^\d+(\.\d{1,2})?$/, 'amountFormat')
      .refine((s) => {
        const n = Number(s);
        return Number.isFinite(n) && n > 0 && n <= remainingThb;
      }, 'amountRange'),
    reason: z
      .string()
      .min(1, 'reasonRequired')
      .max(REASON_MAX, 'reasonTooLong')
      .regex(/^[^\r\n]+$/, 'reasonSingleLine'),
  });

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

type Props = {
  readonly paymentId: string;
  /** The invoice the refund credits — keys the credit-note preview read. */
  readonly invoiceId: string;
  /** F4 waives this document's credit note (known at page load): skip the read. */
  readonly creditNoteWaiverReason?: WaiverReason | null;
  readonly memberCompanyName: string;
  readonly remainingRefundableSatang: bigint;
  readonly currencyCode: string;
  /** 0306 — only a MEMBERSHIP invoice's full refund asks Keep / End. */
  readonly invoiceSubject: 'membership' | 'event';
  /**
   * 0306 — the invoice's un-credited headroom (`total − credited`). A refund
   * of exactly this amount fully credits the invoice, which is what
   * withdraws the paid period.
   */
  readonly invoiceHeadroomSatang: bigint;
  readonly onClose: () => void;
  /** The request is in flight: the dialog stays open (no Escape or scrim close). */
  readonly onPendingChange?: (pending: boolean) => void;
};

type MembershipEffect = 'keep' | 'cancel_membership';

/** `membership_end` outcomes the refund route reports (0306). */
const MEMBERSHIP_END_OUTCOMES = [
  'ended',
  'scheduled',
  'deferred',
  'no_open_cycle',
  'failed',
] as const;
type MembershipEndOutcome = (typeof MEMBERSHIP_END_OUTCOMES)[number];

/** `0.0700` → `7%` / `7 %` (display of the invoice's stored rate; no money maths). */
function formatVatRatePercent(rate: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(Number(rate));
}

// Display-only formatting via the canonical `formatSatangThb` helper
// (`src/lib/format-thb.ts`). Server-side accounting arithmetic stays
// in satang.

export function RefundForm({
  paymentId,
  invoiceId,
  creditNoteWaiverReason = null,
  memberCompanyName,
  remainingRefundableSatang,
  currencyCode,
  invoiceSubject,
  invoiceHeadroomSatang,
  onClose,
  onPendingChange,
}: Props) {
  const t = useTranslations('admin.refund');
  const tForm = useTranslations('admin.refund.form');
  const tFormErr = useTranslations('admin.refund.form.errors');
  const tError = useTranslations('admin.refund.error');
  const locale = useLocale();
  const router = useRouter();
  const remainingThb = Number(remainingRefundableSatang) / 100;
  // Stabilise the schema reference so zodResolver doesn't re-validate
  // unrelated re-renders (RHF runs the resolver each time `resolver`
  // identity changes). Cheap to memoise; the schema only needs to
  // rebuild when `remainingThb` itself changes.
  const schema = useMemo(() => buildSchema(remainingThb), [remainingThb]);

  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    onPendingChange?.(submitting);
  }, [submitting, onPendingChange]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [typedPhrase, setTypedPhrase] = useState('');
  // 0306 — default Keep: ending a membership is never the silent default.
  const [membershipEffect, setMembershipEffect] = useState<MembershipEffect>('keep');

  const amountId = useId();
  const reasonId = useId();
  const reasonHelpId = `${reasonId}-help`;
  // Never ends in `-help`: tests/e2e/helpers/refund.ts reads the first `[id$="-help"]`.
  const creditNoteTitleId = `${amountId}-credit-note-title`;

  // Move focus to the server-rejection alert so a keyboard/SR admin whose
  // focus is on the (re-enabled) Confirm button is taken to the reason
  // (audit refund focus suggestion). role="alert" already announces it.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isValid, touchedFields },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { amountThb: '', reason: '' },
    // FR-029(c) — error MESSAGES surface only after the field has
    // been touched (blurred ≥1 time, gated by `touchedFields` below
    // at each error-render site). Validation FREQUENCY stays on
    // every change so RHF `isValid` updates real-time → Confirm
    // button enables as soon as both fields hold valid values
    // without forcing the user to tab away from the last input.
    // This satisfies BOTH the spec literal (errors on blur) AND
    // the spec's "Submit disabled until both fields valid" line.
    mode: 'onChange',
  });

  const amountValue = useWatch({ control, name: 'amountThb' });
  const reasonValue = useWatch({ control, name: 'reason' }) ?? '';

  // Full-refund detection: convert THB → satang and compare to
  // remaining. Uses BigInt arithmetic on the parsed integer satang to
  // avoid float-equality drift (e.g. 5350.00 → 535000n exact).
  const amountSatang: bigint | null = (() => {
    if (!/^\d+(\.\d{1,2})?$/.test(amountValue ?? '')) return null;
    const [whole = '0', frac = ''] = (amountValue ?? '').split('.');
    const fracPadded = (frac + '00').slice(0, 2);
    try {
      return BigInt(whole) * 100n + BigInt(fracPadded || '0');
    } catch {
      return null;
    }
  })();

  const isFullRefund =
    amountSatang !== null && amountSatang === remainingRefundableSatang;
  // 0306 — the refund fully credits a MEMBERSHIP invoice (withdraws the paid
  // period). Keyed on the INVOICE headroom, the same test the server applies
  // before accepting `cancel_membership`.
  const isFullMembershipRefund =
    invoiceSubject === 'membership' &&
    amountSatang !== null &&
    amountSatang === invoiceHeadroomSatang;
  // Board Admin-refund-full / -partial: a valid amount within the headroom
  // gets the refund summary and names itself on Confirm. Display only — the
  // request still carries `amountSatang` and the server re-checks the cap.
  const summaryAmountSatang =
    amountSatang !== null && amountSatang > 0n && amountSatang <= remainingRefundableSatang ? amountSatang : null;
  // "Credit note to be issued" — the server's split for this amount, printed
  // as received (no VAT arithmetic here). Nothing shows for a waived (§105
  // receipt, voided invoice) or blocked document, or if the read fails.
  const creditNotePreview = useCreditNotePreview(invoiceId, summaryAmountSatang, creditNoteWaiverReason);
  const expectedPhrase = `REFUND ${memberCompanyName}`;
  const phraseMatches = typedPhrase === expectedPhrase;

  // Confirm enables only when:
  //   1. RHF schema is valid (amount + reason)
  //   2. NOT a full refund OR typed-phrase matches (full-refund gate)
  //   3. NOT submitting
  const canSubmit =
    isValid && !submitting && (!isFullRefund || phraseMatches);

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    if (amountSatang === null) return;
    setSubmitting(true);
    setSubmitError(null);
    // I5: track success-path entry so the
    // `finally` block knows whether to keep the spinner alive
    // (parent unmounts via onClose → setSubmitting(false) is a no-op
    // safe for unmounted components, React 19 silently ignores) or
    // reset it for the failure-stays-open paths.
    let succeeded = false;
    try {
      const res = await fetch('/api/refunds/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId,
          amountSatang: Number(amountSatang),
          reason: values.reason.trim(),
          // Only sent when the choice was shown; a partial / event refund
          // never touches membership.
          ...(isFullMembershipRefund ? { membershipEffect } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; remainingSatang?: string };
        };
        const code = body.error?.code ?? 'internal_error';
        // Money-remediation F-3 — NOT a failure. Stripe SETTLED this refund;
        // only the credit note is outstanding, and the stale-pending sweep
        // retries it automatically. The generic branch below would render it
        // inside a destructive InlineAlert titled "Couldn't issue the refund"
        // (`error.title`), which is false and is exactly the read that made an
        // admin click again and double-refund the member. Terminate the dialog
        // the same way the 202 pending path does — no retry affordance at all.
        // `admin.refund.error.f4_bridge_deferred` is still REQUIRED to exist
        // (the check:i18n route-code gate enforces it) as the fallback if this
        // special case is ever removed.
        if (code === 'f4_bridge_deferred') {
          toast.success(t('success.deferredToast'));
          succeeded = true;
          onClose();
          router.refresh();
          return;
        }
        // Surface the localised message inline + as a toast so the
        // admin sees it whether their focus is in or out of the
        // dialog.
        const msg = (() => {
          try {
            // Round-2 review fix (#36): `refund_exceeds_remaining` (409 —
            // returned when the refundable balance shrank between page load and
            // submit, e.g. a concurrent refund settled) is the ONE server error
            // code whose message needs a {remaining} ICU arg. Pre-fix this path
            // called tError(code) with NO param, so next-intl could not format
            // the placeholder and surfaced the raw message key. Supply the arg,
            // mirroring the client-side zod `amountMessage` path below. The
            // client's `remainingRefundableSatang` may be slightly stale in the
            // race, but the definitive guard is server-side; showing the
            // localised balance text beats a raw token. Every other route code
            // has no placeholder, so `tError(code)` is correct for them.
            // The 409 carries the server's authoritative cap
            // (min(payment, invoice headroom)); quote it when present so a
            // cap shrunk by a credit note is not mis-stated.
            if (code === 'refund_exceeds_remaining') {
              const serverRemaining = body.error?.remainingSatang;
              return tError('refund_exceeds_remaining', {
                remaining: formatSatangThb(
                  serverRemaining !== undefined && /^\d+$/.test(serverRemaining)
                    ? BigInt(serverRemaining)
                    : remainingRefundableSatang,
                  locale,
                  currencyCode,
                ),
              });
            }
            return tError(code);
          } catch {
            return tError('internal_error');
          }
        })();
        setSubmitError(msg);
        toast.error(msg);
        return;
      }
      const body = (await res.json()) as {
        membership_end?: string;
        refund: {
          status?: string;
          creditNoteNumber?: string | null;
          // Track B — the 201 reports what documented the refund as a union,
          // so a waived refund cannot be rendered as an issued credit note
          // with an empty number. Optional here because the 202 arm has no
          // credit note yet and sends the decision as a bare reason instead.
          creditNote?:
            | { kind: 'issued'; id: string; number: string }
            | { kind: 'waived'; reason: WaiverReason };
          creditNoteWaiverReason?: WaiverReason | null;
        };
      };
      // #1 (2026-07-11) — an async Stripe refund returns 202 with a
      // `pending` row (no credit note yet). Show an "awaiting confirmation"
      // toast; the `charge.refund.updated` webhook books the credit note
      // once the refund settles. A synchronous `succeeded` refund (201)
      // carries the credit-note number.
      if (res.status === 202 || body.refund.status === 'pending') {
        // Track B — the waiver decision is made at pre-flight, so even a
        // still-settling refund knows whether a §86/10 will ever follow.
        // Telling this admin "the credit note is issued once the refund
        // settles" would be false for the whole life of that refund.
        const pendingWaiver = body.refund.creditNoteWaiverReason ?? null;
        if (pendingWaiver) {
          // `warning`, not `success`: the money went back, but the message is a
          // CAUTION — an output-VAT adjustment is now owed. The green check of
          // `toast.success` reads as "all done"; the triangle of `toast.warning`
          // matches "succeeded, but act". `closeButton` is REQUIRED alongside
          // `duration: Infinity` — a toast that never auto-dismisses and has no
          // focusable dismiss control strands a keyboard/screen-reader admin
          // under it on every subsequent screen (WCAG 2.1.1 / ux-standards §4.2).
          toast.warning(t('success.pendingWaivedToast'), {
            description: t(`success.waivedReason.${waiverKey(pendingWaiver)}`),
            duration: Infinity,
            closeButton: true,
          });
        } else {
          toast.success(t('success.pendingToast'));
        }
      } else if (body.refund.creditNote?.kind === 'waived') {
        // No credit note exists and none ever will. The description carries
        // the ground AND the consequence — an output-VAT adjustment is now
        // owed that nothing in this system performs. It does NOT tell the
        // admin how to file: whether that VAT may be reduced at all, by what
        // instrument, and in which ภ.พ.30 month are open questions for the
        // chamber's accountant. Turning an unanswered tax question into an
        // instruction would be a worse lie than the one being removed here.
        //
        // `warning` + persistent + `closeButton`: this is a caution, it is the
        // only moment the admin is told, and it must be dismissible by keyboard
        // and screen reader — see the pending-waived arm above for the full
        // reasoning.
        toast.warning(t('success.waivedToast'), {
          description: t(
            `success.waivedReason.${waiverKey(body.refund.creditNote.reason)}`,
          ),
          duration: Infinity,
          closeButton: true,
        });
      } else {
        toast.success(
          t('success.toast', { number: body.refund.creditNoteNumber ?? '' }),
        );
      }
      // 0306 — what happened to the membership (only when End was chosen).
      const membershipEnd = body.membership_end;
      if (
        membershipEnd !== undefined &&
        (MEMBERSHIP_END_OUTCOMES as readonly string[]).includes(membershipEnd)
      ) {
        toast.info(t(`membership.outcome.${membershipEnd as MembershipEndOutcome}`));
      }
      succeeded = true;
      onClose();
      router.refresh();
    } catch (e) {
      const msg = tError('internal_error');
      setSubmitError(msg);
      toast.error(msg);
       
      // network/parse errors during dev; pino in production.
      console.error('refund submit failed', e);
    } finally {
      // Always reset submitting so a stale spinner cannot freeze the
      // dialog if `onClose` or `router.refresh` throws after success.
      // React 19 ignores setState on an unmounted component, so this
      // is safe even when the dialog has already been torn down.
      void succeeded;
      setSubmitting(false);
    }
  };

  // Cancel takes the first focus per FR-029(d) (destructive dialogs default
  // to the safe action): AURA's modal focuses `[data-autofocus]` on open.

  // Map RHF zod-resolver error codes to localised messages. The
  // resolver puts the `message` field straight into errors; we
  // translate at render time.
  //
  // FR-029(c): error messages surface only AFTER the field has been
  // touched (blurred ≥1 time). RHF's `touchedFields` flips on first
  // blur; gating both `aria-invalid` and the inline error <p> on it
  // prevents the "type one wrong char → instant red error" anti-
  // pattern while still letting `isValid` (used for Confirm-gating)
  // track validity continuously.
  const amountError =
    touchedFields.amountThb && errors.amountThb?.message;
  const reasonError = touchedFields.reason && errors.reason?.message;

  // Resolve raw zod codes to LOCALISED copy. Previously only `amountRange`
  // was translated and the other codes (amountRequired/amountFormat,
  // reasonRequired/…) rendered verbatim — leaking developer tokens to users
  // in every locale on a money action (audit XF-02). Unknown codes fall back
  // to the generic localised message rather than a raw token.
  const amountMessage: string | null = !amountError
    ? null
    : amountError === 'amountRange'
      ? tError('refund_exceeds_remaining', {
          remaining: formatSatangThb(
            remainingRefundableSatang,
            locale,
            currencyCode,
          ),
        })
      : amountError === 'amountRequired' || amountError === 'amountFormat'
        ? tFormErr(amountError)
        : tError('internal_error');
  const reasonMessage: string | null = !reasonError
    ? null
    : reasonError === 'reasonRequired' ||
        reasonError === 'reasonTooLong' ||
        reasonError === 'reasonSingleLine'
      ? tFormErr(reasonError)
      : tError('internal_error');

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-6"
      noValidate
    >
      {/* Amount field — inputmode="decimal" so mobile keyboards show
        * the right layout; THB live-help shows the maximum refundable. */}
      <div className="flex flex-col gap-1">
        <TextField
          id={amountId}
          label={tForm('amount.label')}
          required
          type="text"
          inputMode="decimal"
          // Native iOS form-validation hint — belt + braces with the
          // zod resolver. Mirrors `inputMode="decimal"` mobile UX.
          pattern="\d+(\.\d{1,2})?"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={tForm('amount.placeholder')}
          aria-describedby={
            amountError ? `${amountId}-error ${amountId}-help` : `${amountId}-help`
          }
          aria-required="true"
          aria-invalid={Boolean(amountError)}
          data-testid="refund-form-amount"
          {...register('amountThb')}
        />
        <p id={`${amountId}-help`} className="text-xs text-[var(--aura-fg-secondary)]">
          {tForm('amount.maximumHelp', {
            amount: formatSatangThb(remainingRefundableSatang, locale, currencyCode),
          })}
        </p>
        {amountMessage && (
          <p id={`${amountId}-error`} className="text-xs text-[var(--aura-fg-danger)]" role="alert">
            {amountMessage}
          </p>
        )}
      </div>

      {summaryAmountSatang !== null && (
        <div
          data-testid="refund-summary"
          className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-[var(--aura-space-3)]"
        >
          <p className="text-xs font-semibold text-[var(--aura-fg-secondary)]">{tForm('summary.title')}</p>
          {/* F4 waived the credit note (§105 receipt, voided invoice): say so
              before Confirm, as a plain note. No filing advice — that is the
              accountant's call (see the waived toasts below). */}
          {creditNotePreview.status === 'none' && creditNotePreview.waivedReason !== null && (
            <p data-testid="refund-summary-no-credit-note" className="text-sm text-[var(--aura-fg-secondary)]">
              {tForm(`summary.noCreditNote.${waiverKey(creditNotePreview.waivedReason)}`)}
            </p>
          )}
          {(creditNotePreview.status === 'loading' || creditNotePreview.status === 'ready') && (
            // One layout for loading and ready — only the values swap for a
            // skeleton — so the totals below never shift while typing.
            <div
              role="group"
              aria-labelledby={creditNoteTitleId}
              aria-busy={creditNotePreview.status === 'loading'}
              data-testid={creditNotePreview.status === 'ready' ? 'refund-summary-credit-note' : 'refund-summary-credit-note-loading'}
              className="flex flex-col gap-[var(--aura-space-1)]"
            >
              <p id={creditNoteTitleId} className="text-xs font-medium text-[var(--aura-fg-secondary)]">
                {tForm('summary.creditNoteTitle')}
              </p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-1)] text-sm text-[var(--aura-fg-secondary)]">
                <dt>{tForm('summary.creditNoteNet')}</dt>
                <dd className="text-end tabular-nums">
                  {creditNotePreview.status === 'ready' ? (
                    formatSatangThb(creditNotePreview.split.netSatang, locale, currencyCode)
                  ) : (
                    <Skeleton variant="text" width="8ch" />
                  )}
                </dd>
                <dt>
                  {(() => {
                    const rate = creditNotePreview.status === 'ready' ? creditNotePreview.split.vatRate : creditNotePreview.vatRate;
                    return rate === null
                      ? tForm('summary.creditNoteVatPending')
                      : tForm('summary.creditNoteVat', { rate: formatVatRatePercent(rate, locale) });
                  })()}
                </dt>
                <dd className="text-end tabular-nums">
                  {creditNotePreview.status === 'ready' ? (
                    formatSatangThb(creditNotePreview.split.vatSatang, locale, currencyCode)
                  ) : (
                    <Skeleton variant="text" width="6ch" />
                  )}
                </dd>
              </dl>
              {creditNotePreview.status === 'loading' && (
                <span className="sr-only">{tForm('summary.creditNoteLoading')}</span>
              )}
            </div>
          )}
          <dl
            className={`grid grid-cols-[1fr_auto] gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-1)] text-sm${
              creditNotePreview.status === 'loading' ||
              creditNotePreview.status === 'ready' ||
              (creditNotePreview.status === 'none' && creditNotePreview.waivedReason !== null)
                ? ' border-t border-[var(--aura-border-subtle)] pt-[var(--aura-space-2)]'
                : ''
            }`}
          >
            <dt className="font-semibold">{tForm('summary.total')}</dt>
            <dd className="text-end font-semibold tabular-nums">
              {formatSatangThb(summaryAmountSatang, locale, currencyCode)}
            </dd>
            <dt>{tForm('summary.after')}</dt>
            <dd className="text-end tabular-nums">
              {formatSatangThb(remainingRefundableSatang - summaryAmountSatang, locale, currencyCode)}
            </dd>
          </dl>
        </div>
      )}

      {/* 0306 — a full refund of a membership invoice withdraws the paid
          period. Say what Renewals will do next, and let staff end the
          membership instead of letting it run to period end. */}
      {isFullMembershipRefund && (
        <Alert tone="warning" role="note" title={t('membership.warningTitle')} data-testid="refund-membership-warning">
          <div className="flex flex-col gap-3">
            <p>{t('membership.warningBody')}</p>
            <RadioGroup
              label={t('membership.legend')}
              name={`${amountId}-membership`}
              value={membershipEffect}
              onChange={(v) => setMembershipEffect(v === 'cancel_membership' ? 'cancel_membership' : 'keep')}
              options={[
                { value: 'keep', label: t('membership.keep.label'), description: t('membership.keep.description') },
                {
                  value: 'cancel_membership',
                  label: t('membership.end.label'),
                  description: t('membership.end.description'),
                },
              ]}
            />
          </div>
        </Alert>
      )}

      {/* Reason — single-line textarea (server enforces no CR/LF too) */}
      <div className="flex flex-col gap-1">
        <Textarea
          id={reasonId}
          label={tForm('reason.label')}
          required
          rows={3}
          maxLength={REASON_MAX}
          placeholder={tForm('reason.placeholder')}
          aria-describedby={
            reasonError ? `${reasonId}-error ${reasonHelpId}` : reasonHelpId
          }
          aria-required="true"
          aria-invalid={Boolean(reasonError)}
          data-testid="refund-form-reason"
          {...register('reason')}
        />
        {reasonMessage && (
          <p
            id={`${reasonId}-error`}
            className="text-xs text-[var(--aura-fg-danger)]"
            role="alert"
          >
            {reasonMessage}
          </p>
        )}
        {/* Visual counter — sighted users see live updates per keystroke. */}
        <p
          id={reasonHelpId}
          className="text-xs text-[var(--aura-fg-secondary)]"
          aria-hidden="true"
        >
          {tForm('reason.charCount', { count: reasonValue.length })}
        </p>
        {/* R3 UX H-2 (2026-04-28): SR-only threshold announcer.
            Fires only at 450/490/500 chars to avoid per-keystroke
            audio flood. Mirrors the SR_THRESHOLDS pattern from
            hard-cap-prompt.tsx. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {[450, 490, 500].includes(reasonValue.length)
            ? tForm('reason.charCount', { count: reasonValue.length })
            : ''}
        </p>
      </div>

      {/* Typed-phrase gate — only on full refund (FR-029(f)). */}
      {isFullRefund && (
        <TypedPhraseConfirm
          companyName={memberCompanyName}
          value={typedPhrase}
          onChange={setTypedPhrase}
        />
      )}

      {/* Submit error — inline alert above buttons (FR-029(g)). */}
      {submitError && (
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          {/* Generic headline so a known business rejection (e.g. "refund in
            * progress") isn't mislabelled "unexpected error"; the specific
            * localised reason is the body. */}
          <Alert tone="danger" title={t('error.title')} data-testid="refund-form-error">
            {submitError}
          </Alert>
        </div>
      )}

      {/* The buttons stick to the bottom of the dialog's scrolling body, so a
          long form never scrolls them away and focusing Cancel on open does
          not scroll the summary out of view; on a phone they stack full
          width, the primary action on top (ux-standards § 11.1). */}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-[var(--aura-space-2)] bg-[var(--aura-bg-surface)] py-[var(--aura-space-3)] max-sm:flex-col-reverse max-sm:[&>*]:w-full">
        <Button type="button" variant="secondary" touchHeight data-autofocus disabled={submitting} onClick={onClose}>
          {t('dialog.cancel')}
        </Button>
        <Button
          type="submit"
          variant="danger"
          touchHeight
          icon="rotate-ccw"
          loading={submitting}
          disabled={!canSubmit}
          data-testid="refund-form-confirm"
        >
          {submitting
            ? t('dialog.processing')
            : summaryAmountSatang !== null
              ? t('dialog.confirmAmount', { amount: formatSatangThb(summaryAmountSatang, locale, currencyCode) })
              : t('dialog.confirm')}
        </Button>
      </div>
    </form>
  );
}
