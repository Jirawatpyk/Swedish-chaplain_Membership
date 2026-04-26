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
import { useState, useId, useMemo } from 'react';
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
  readonly invoiceId: string;
  readonly invoiceDocumentNumber: string;
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
  invoiceId,
  memberCompanyName,
  remainingRefundableSatang,
  currencyCode,
  onClose,
}: Props) {
  const t = useTranslations('admin.refund');
  const tForm = useTranslations('admin.refund.form');
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

  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { amountThb: '', reason: '' },
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
    try {
      const res = await fetch('/api/refunds/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId,
          // API takes integer satang; we already parsed it above.
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
            return tError(code);
          } catch {
            return tError('internal_error');
          }
        })();
        setSubmitError(msg);
        toast.error(msg);
        setSubmitting(false);
        return;
      }
      const body = (await res.json()) as {
        refund: { creditNoteNumber: string };
      };
      toast.success(
        t('success.toast', { number: body.refund.creditNoteNumber }),
      );
      onClose();
      // Refresh server data so the payment timeline + status badges
      // reflect the new credit-note + payment.status transitions.
      router.refresh();
    } catch (e) {
      const msg = tError('internal_error');
      setSubmitError(msg);
      toast.error(msg);
      setSubmitting(false);
      // eslint-disable-next-line no-console -- surface unexpected
      // network/parse errors during dev; pino in production.
      console.error('refund submit failed', e);
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
  const amountError = errors.amountThb?.message;
  const reasonError = errors.reason?.message;

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
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={tForm('amount.placeholder')}
          aria-describedby={`${amountId}-help`}
          aria-invalid={Boolean(amountError)}
          data-testid="refund-form-amount"
          {...register('amountThb')}
        />
        <p
          id={`${amountId}-help`}
          className="text-xs text-muted-foreground"
          aria-live="polite"
        >
          {tForm('amount.maximumHelp', {
            amount: formatSatangThb(remainingRefundableSatang, locale, currencyCode),
          })}
        </p>
        {amountError && (
          <p className="text-xs text-destructive" role="alert">
            {amountError === 'amountRange'
              ? tError('refund_exceeds_remaining', {
                  remaining: formatSatangThb(
                    remainingRefundableSatang,
                    locale,
                    currencyCode,
                  ),
                })
              : amountError}
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
          aria-describedby={reasonHelpId}
          aria-invalid={Boolean(reasonError)}
          data-testid="refund-form-reason"
          {...register('reason')}
        />
        <p
          id={reasonHelpId}
          className="text-xs text-muted-foreground"
          aria-live="polite"
        >
          {tForm('reason.charCount', { count: reasonValue.length })}
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
        <InlineAlert tone="destructive" data-testid="refund-form-error">
          <InlineAlertTitle>{t('error.internal_error')}</InlineAlertTitle>
          <InlineAlertDescription>{submitError}</InlineAlertDescription>
        </InlineAlert>
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
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          )}
          {submitting ? t('dialog.processing') : t('dialog.confirm')}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
