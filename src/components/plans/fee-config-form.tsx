/**
 * T149 — FeeConfigForm (US5).
 *
 * Client component. Renders a simple flat form with:
 *   - Currency code (read-only display + explanatory note — immutable in F2)
 *   - VAT rate (percent input, e.g. "7.50")
 *   - Registration fee (major-units input)
 *   - Save button (disabled for manager role — FR-017 read-only)
 *
 * On submit: PATCH /api/fee-config with `{vat_rate, registration_fee_minor_units}`
 * and a fresh Idempotency-Key. Shows a success toast on 200, classifies
 * errors (403 forbidden / 422 currency_code_immutable_in_f2 / 400 /
 * generic / network) and surfaces them inline.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface FeeConfigFormProps {
  readonly initialValues: {
    readonly currency_code: string;
    readonly vat_rate: number;
    readonly registration_fee_minor_units: number;
  };
  readonly currentUserRole: 'admin' | 'manager' | 'member';
}

function freshIdempotencyKey(): string {
  return `fee-config-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function FeeConfigForm({
  initialValues,
  currentUserRole,
}: FeeConfigFormProps) {
  const t = useTranslations('admin.settings.fees');
  const router = useRouter();
  const isAdmin = currentUserRole === 'admin';

  // VAT stored as decimal (0.0700). UI renders percent (7.00).
  const [vatPercent, setVatPercent] = useState<string>(
    (initialValues.vat_rate * 100).toFixed(2),
  );
  const [registrationFee, setRegistrationFee] = useState<string>(
    (initialValues.registration_fee_minor_units / 100).toFixed(2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isAdmin) return;
    setSubmitting(true);
    setError(null);

    const vatDecimal = Number.parseFloat(vatPercent) / 100;
    const registrationFeeMinor = Math.round(
      Number.parseFloat(registrationFee) * 100,
    );

    if (Number.isNaN(vatDecimal) || vatDecimal < 0 || vatDecimal >= 1) {
      setError(t('errors.validation'));
      setSubmitting(false);
      return;
    }
    if (Number.isNaN(registrationFeeMinor) || registrationFeeMinor < 0) {
      setError(t('errors.validation'));
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch('/api/fee-config', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
        body: JSON.stringify({
          vat_rate: vatDecimal,
          registration_fee_minor_units: registrationFeeMinor,
        }),
      });

      if (res.ok) {
        toast.success(t('toast.success'));
        router.refresh();
        setSubmitting(false);
        return;
      }

      // Error classification
      const body = await res.json().catch(() => ({}) as unknown);
      const code = (body as { error?: { code?: string } }).error?.code;

      if (res.status === 403) {
        setError(t('errors.forbidden'));
      } else if (res.status === 422 && code === 'currency_code_immutable_in_f2') {
        const details = (
          body as {
            error?: { details?: { non_deleted_plan_count?: number } };
          }
        ).error?.details;
        const count = details?.non_deleted_plan_count ?? 0;
        setError(t('errors.currencyImmutable', { count }));
      } else if (res.status === 400) {
        setError(t('errors.validation'));
      } else {
        setError(t('errors.generic'));
      }
    } catch {
      setError(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <div className="space-y-2">
        <Label htmlFor="currency_code">{t('labels.currencyCode')}</Label>
        <Input
          id="currency_code"
          name="currency_code"
          value={initialValues.currency_code}
          disabled
          readOnly
          aria-describedby="currency_code_note"
        />
        <p id="currency_code_note" className="text-xs text-muted-foreground">
          {t('currencyImmutableNote', { currency: initialValues.currency_code })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="vat_rate">{t('labels.vatRate')}</Label>
        <Input
          id="vat_rate"
          name="vat_rate"
          type="number"
          inputMode="decimal"
          min="0"
          max="99.99"
          step="0.01"
          value={vatPercent}
          onChange={(e) => setVatPercent(e.target.value)}
          disabled={!isAdmin || submitting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="registration_fee">{t('labels.registrationFee')}</Label>
        <Input
          id="registration_fee"
          name="registration_fee"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={registrationFee}
          onChange={(e) => setRegistrationFee(e.target.value)}
          disabled={!isAdmin || submitting}
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {isAdmin ? (
        <Button type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('save')}
        </Button>
      ) : null}
    </form>
  );
}
