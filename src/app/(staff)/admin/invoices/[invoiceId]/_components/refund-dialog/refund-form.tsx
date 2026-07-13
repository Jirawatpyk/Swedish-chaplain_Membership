'use client';

/**
 * T114 + T116 — Refund form (F5 Phase 6 / US4 / FR-029).
 *
 * react-hook-form + zod resolver. Composes:
 *   - Amount input — inputmode="decimal", THB units; converted to
 *     satang on submit. Label-above + asterisk + live help-text
 *     "Maximum refundable: {amount} THB" per FR-029(b).
 *   - Reason textarea — 500-char counter; aria-live polite.
 *   - <TypedPhraseConfirm> — renders ONLY when amount === remaining
 *     (full refund) per FR-029(f).
 *   - Cancel + Confirm buttons — Cancel default-focused; Confirm
 *     shows spinner while in flight.
 *
 * Submit pipeline:
 *   1. RHF validation (zod) — invalid blocks Confirm.
 *   2. POST /api/refunds/initiate — bigint amount as JSON number.
 *   3. On 201: sonner.success with credit-note number; close dialog;
 *      router.refresh() to update payment timeline + status badges.
 *   4. On 4xx/5xx: inline alert above buttons (FR-029(g)) + sonner.
 */
import { useEffect, useRef, useState, useId, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import {
  AlertDialogCancel,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';
import { useLocale } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { TypedPhraseConfirm } from './typed-phrase-confirm';

const REASON_MAX = 500;

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
  readonly memberCompanyName: string;
  readonly remainingRefundableSatang: bigint;
  readonly currencyCode: string;
  readonly onClose: () => void;
};

// Display-only formatting via the canonical `formatSatangThb` helper
// (`src/lib/format-thb.ts`). Server-side accounting arithmetic stays
// in satang.

export function RefundForm({
  paymentId,
  memberCompanyName,
  remainingRefundableSatang,
  currencyCode,
  onClose,
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [typedPhrase, setTypedPhrase] = useState('');

  const amountId = useId();
  const reasonId = useId();
  const reasonHelpId = `${reasonId}-help`;

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
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code ?? 'internal_error';
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
            if (code === 'refund_exceeds_remaining') {
              return tError('refund_exceeds_remaining', {
                remaining: formatSatangThb(
                  remainingRefundableSatang,
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
        refund: { status?: string; creditNoteNumber?: string };
      };
      // #1 (2026-07-11) — an async Stripe refund returns 202 with a
      // `pending` row (no credit note yet). Show an "awaiting confirmation"
      // toast; the `charge.refund.updated` webhook books the credit note
      // once the refund settles. A synchronous `succeeded` refund (201)
      // carries the credit-note number.
      if (res.status === 202 || body.refund.status === 'pending') {
        toast.success(t('success.pendingToast'));
      } else {
        toast.success(
          t('success.toast', { number: body.refund.creditNoteNumber ?? '' }),
        );
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

  // Cancel button gets default focus per FR-029(d) (destructive
  // dialogs default to safe action) — Radix's focus-scope autofocuses
  // the first tabbable child of <AlertDialogContent>, and we render
  // <AlertDialogCancel> before the destructive Confirm button, so no
  // explicit focus management is required.

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
      <div className="grid gap-2">
        <Label htmlFor={amountId}>
          {tForm('amount.label')} <span aria-hidden="true">*</span>
        </Label>
        <Input
          id={amountId}
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
        <p
          id={`${amountId}-help`}
          className="text-xs text-muted-foreground"
        >
          {tForm('amount.maximumHelp', {
            amount: formatSatangThb(remainingRefundableSatang, locale, currencyCode),
          })}
        </p>
        {amountMessage && (
          <p id={`${amountId}-error`} className="text-xs text-destructive" role="alert">
            {amountMessage}
          </p>
        )}
      </div>

      {/* Reason — single-line textarea (server enforces no CR/LF too) */}
      <div className="grid gap-2">
        <Label htmlFor={reasonId}>
          {tForm('reason.label')} <span aria-hidden="true">*</span>
        </Label>
        <Textarea
          id={reasonId}
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
            className="text-xs text-destructive"
            role="alert"
          >
            {reasonMessage}
          </p>
        )}
        {/* Visual counter — sighted users see live updates per keystroke. */}
        <p
          id={reasonHelpId}
          className="text-xs text-muted-foreground"
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
          <InlineAlert tone="destructive" data-testid="refund-form-error">
            {/* Generic headline so a known business rejection (e.g. "refund in
              * progress") isn't mislabelled "unexpected error"; the specific
              * localised reason lives in the description. */}
            <InlineAlertTitle>{t('error.title')}</InlineAlertTitle>
            <InlineAlertDescription>{submitError}</InlineAlertDescription>
          </InlineAlert>
        </div>
      )}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={submitting}>
          {t('dialog.cancel')}
        </AlertDialogCancel>
        <Button
          type="submit"
          variant="destructive"
          disabled={!canSubmit}
          aria-busy={submitting}
          data-testid="refund-form-confirm"
        >
          {submitting && (
            <Loader2Icon
              className="size-4 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {submitting ? t('dialog.processing') : t('dialog.confirm')}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
