'use client';

/**
 * F114 — the Group B change-request form (US1 AS1/AS3/AS4/AS8, FR-002,
 * FR-006, FR-007, FR-010, FR-034; T040). Rendered by /portal/edit when the
 * tenant gate is `approval`.
 *
 *   - Group B only: the person's own contact fields for every contact with a
 *     login; the company fields ONLY for the primary contact — a secondary
 *     sees a "contact your primary contact" note instead (FR-002).
 *   - Sends the WHOLE Group B set the caller may propose; the server diffs
 *     against the current record (FR-007), so `nothing_to_submit` /
 *     `already_pending` come back as outcomes, announced inline through a
 *     live region rather than a toast (FR-034).
 *   - Server field issues (422 `validation_error`) map back onto the field by
 *     their zod path; the message shown is LOCALISED, never the raw token.
 *   - Carries the GDPR Art. 13 / PDPA § 23 notice with the privacy-notice link
 *     (FR-010).
 *   - 320 px: single column; sections are real fieldsets with legends.
 */
import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Controller, useForm, type Path } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InlineAlert } from '@/components/ui/inline-alert';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import { Textarea } from '@/components/ui/textarea';
import { boundedText, requiredText, type Translator } from '@/lib/zod-i18n';
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';
import { normalizeWebsiteUrl } from '@/modules/members/domain/change-request/field-rules';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type ChangeRequestFormValues = {
  firstName: string;
  lastName: string;
  phone: string;
  roleTitle: string;
  companyName: string;
  website: string;
  description: string;
  regLine1: string;
  regLine2: string;
  regSubDistrict: string;
  regCity: string;
  regProvince: string;
  regPostalCode: string;
  billLine1: string;
  billLine2: string;
  billSubDistrict: string;
  billCity: string;
  billProvince: string;
  billPostalCode: string;
  billCountry: string;
};

function buildSchema(tv: Translator, tf: (key: string) => string, canProposeCompanyFields: boolean) {
  const line = (max: number) => boundedText(tv, max);
  const base = {
    firstName: requiredText(tv, 100),
    lastName: requiredText(tv, 100),
    phone: line(20).refine((v) => isAcceptablePhoneInput(v), { message: tf('errors.phone') }),
    roleTitle: line(100),
  };
  if (!canProposeCompanyFields) {
    return z.object({
      ...base,
      companyName: z.string(),
      website: z.string(),
      description: z.string(),
      regLine1: z.string(),
      regLine2: z.string(),
      regSubDistrict: z.string(),
      regCity: z.string(),
      regProvince: z.string(),
      regPostalCode: z.string(),
      billLine1: z.string(),
      billLine2: z.string(),
      billSubDistrict: z.string(),
      billCity: z.string(),
      billProvince: z.string(),
      billPostalCode: z.string(),
      billCountry: z.string(),
    });
  }
  return z.object({
    ...base,
    companyName: requiredText(tv, 200),
    website: line(200).refine(
      (v) => {
        const n = normalizeWebsiteUrl(v);
        if (typeof n !== 'string' || n === '') return true;
        try {
          new URL(n);
          return /^https?:$/i.test(new URL(n).protocol);
        } catch {
          return false;
        }
      },
      { message: tf('errors.website') },
    ),
    description: line(2000),
    regLine1: line(200),
    regLine2: line(200),
    regSubDistrict: line(100),
    regCity: line(100),
    regProvince: line(100),
    regPostalCode: line(20),
    billLine1: line(200),
    billLine2: line(200),
    billSubDistrict: line(100),
    billCity: line(100),
    billProvince: line(100),
    billPostalCode: line(20),
    billCountry: z.string().refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), { message: tf('errors.country') }),
  });
}

const nullable = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/** The wire body (contracts § 2): the whole Group B set the caller may propose. */
export function buildProposalBody(values: ChangeRequestFormValues, canProposeCompanyFields: boolean) {
  const contact = {
    first_name: values.firstName.trim(),
    last_name: values.lastName.trim(),
    phone: nullable(values.phone),
    role_title: nullable(values.roleTitle),
  };
  if (!canProposeCompanyFields) return { contact };
  return {
    contact,
    company: {
      company_name: values.companyName.trim(),
      website: nullable(values.website),
      description: nullable(values.description),
      registered_address: {
        line1: nullable(values.regLine1),
        line2: nullable(values.regLine2),
        sub_district: nullable(values.regSubDistrict),
        city: nullable(values.regCity),
        province: nullable(values.regProvince),
        postal_code: nullable(values.regPostalCode),
      },
      billing_address: {
        line1: nullable(values.billLine1),
        line2: nullable(values.billLine2),
        sub_district: nullable(values.billSubDistrict),
        city: nullable(values.billCity),
        province: nullable(values.billProvince),
        postal_code: nullable(values.billPostalCode),
        country: nullable(values.billCountry)?.toUpperCase() ?? null,
      },
    },
  };
}

/** zod issue path (`contact.phone`, `company.billing_address.country`) → form field. */
const PATH_TO_FIELD: Readonly<Record<string, Path<ChangeRequestFormValues>>> = {
  'contact.first_name': 'firstName',
  'contact.last_name': 'lastName',
  'contact.phone': 'phone',
  'contact.role_title': 'roleTitle',
  'company.company_name': 'companyName',
  'company.website': 'website',
  'company.description': 'description',
  'company.registered_address.line1': 'regLine1',
  'company.registered_address.line2': 'regLine2',
  'company.registered_address.sub_district': 'regSubDistrict',
  'company.registered_address.city': 'regCity',
  'company.registered_address.province': 'regProvince',
  'company.registered_address.postal_code': 'regPostalCode',
  'company.billing_address.line1': 'billLine1',
  'company.billing_address.line2': 'billLine2',
  'company.billing_address.sub_district': 'billSubDistrict',
  'company.billing_address.city': 'billCity',
  'company.billing_address.province': 'billProvince',
  'company.billing_address.postal_code': 'billPostalCode',
  'company.billing_address.country': 'billCountry',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PortalChangeRequestFormProps {
  readonly initialValues: ChangeRequestFormValues;
  readonly canProposeCompanyFields: boolean;
  /** The caller's own pending request, when one exists (the form starts from its values — US5 AS5). */
  readonly pending: ChangeRequestView | null;
  readonly privacyNoticeHref: string;
  /** US3 — the decided request being resubmitted (reason shown above the form). */
  readonly resubmitOf?: ChangeRequestView | null;
}

type StatusKind = 'nothing_to_submit' | 'already_pending' | 'rate_limited' | null;

export function PortalChangeRequestForm({
  initialValues,
  canProposeCompanyFields,
  pending,
  privacyNoticeHref,
  resubmitOf = null,
}: PortalChangeRequestFormProps) {
  const t = useTranslations('portal.changeRequests.form');
  const tStatus = useTranslations('portal.changeRequests.status');
  const tErrors = useTranslations('portal.changeRequests.errors');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; retryAt?: string }>({ kind: null });
  const statusId = useId();

  const schema = useMemo(
    () => buildSchema(tv as Translator, (k) => t(k), canProposeCompanyFields),
    [tv, t, canProposeCompanyFields],
  );
  const form = useForm<ChangeRequestFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
  });
  const { errors } = form.formState;

  const onSubmit = async (values: ChangeRequestFormValues) => {
    setSubmitting(true);
    setStatus({ kind: null });
    try {
      const res = await fetch('/api/portal/change-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(buildProposalBody(values, canProposeCompanyFields)),
      });
      const data = (await res.json().catch(() => null)) as
        | { outcome?: string; error?: string; issues?: Array<{ path?: unknown }>; retryAfterSeconds?: number }
        | null;

      if (res.ok) {
        if (data?.outcome === 'submitted') {
          toast.success(tStatus('submitted'));
          router.push('/portal/profile');
          return;
        }
        if (data?.outcome === 'already_pending') {
          setStatus({ kind: 'already_pending' });
          return;
        }
        setStatus({ kind: 'nothing_to_submit' });
        return;
      }

      if (res.status === 422 && data?.error === 'validation_error' && Array.isArray(data.issues)) {
        let focused = false;
        for (const issue of data.issues) {
          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
          const field = PATH_TO_FIELD[path];
          if (field) {
            form.setError(field, { type: 'server', message: tErrors('field') });
            if (!focused) {
              form.setFocus(field);
              focused = true;
            }
          }
        }
        if (!focused) toast.error(tErrors('validation'));
        return;
      }
      if (res.status === 429) {
        const seconds = typeof data?.retryAfterSeconds === 'number' ? data.retryAfterSeconds : 3600;
        const retryAt = new Date(Date.now() + seconds * 1000).toLocaleTimeString();
        setStatus({ kind: 'rate_limited', retryAt });
        return;
      }
      if (res.status === 409 && data?.error === 'approval_not_required') {
        toast.info(tStatus('approvalNotRequired'));
        router.refresh();
        return;
      }
      const code = data?.error;
      toast.error(
        code === 'member_archived'
          ? tErrors('archived')
          : code === 'forbidden' || code === 'company_fields_require_primary'
            ? tErrors('forbidden')
            : tErrors('generic'),
      );
    } catch {
      toast.error(tErrors('generic'));
    } finally {
      setSubmitting(false);
    }
  };

  function field(name: Path<ChangeRequestFormValues>, label: string, opts: { required?: boolean; type?: string; autoComplete?: string } = {}) {
    const error = errors[name];
    const errorId = `${name}-error`;
    return (
      <div>
        <Label htmlFor={name}>
          {label} {opts.required ? <RequiredMark /> : null}
        </Label>
        <Input
          id={name}
          type={opts.type ?? 'text'}
          autoComplete={opts.autoComplete}
          aria-required={opts.required ? 'true' : undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          {...form.register(name)}
        />
        {error ? (
          <p id={errorId} role="alert" className="mt-1 text-caption text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>
    );
  }

  const statusMessage =
    status.kind === 'nothing_to_submit'
      ? tStatus('nothingToSubmit')
      : status.kind === 'already_pending'
        ? tStatus('alreadyPending')
        : status.kind === 'rate_limited'
          ? tStatus('rateLimited', { retryAt: status.retryAt ?? '' })
          : '';

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} method="post" noValidate data-testid="change-request-form">
      <div className="space-y-6">
        {resubmitOf && resubmitOf.decisionReason ? (
          <InlineAlert tone="warning" role="status" data-testid="resubmit-reason">
            <p className="font-medium">{t('resubmitTitle')}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{resubmitOf.decisionReason}</p>
          </InlineAlert>
        ) : null}

        {pending ? (
          <p className="text-sm text-muted-foreground" data-testid="pending-hint">
            {t('pendingHint')}
          </p>
        ) : null}

        <Card>
          <CardHeader>
            <h2 className="font-heading text-base font-medium leading-snug">{t('contactSection')}</h2>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {field('firstName', t('fields.firstName'), { required: true, autoComplete: 'given-name' })}
            {field('lastName', t('fields.lastName'), { required: true, autoComplete: 'family-name' })}
            {field('phone', t('fields.phone'), { type: 'tel', autoComplete: 'tel' })}
            {field('roleTitle', t('fields.roleTitle'), { autoComplete: 'organization-title' })}
          </CardContent>
        </Card>

        {canProposeCompanyFields ? (
          <>
            <Card>
              <CardHeader>
                <h2 className="font-heading text-base font-medium leading-snug">{t('companySection')}</h2>
              </CardHeader>
              <CardContent className="grid gap-4">
                {field('companyName', t('fields.companyName'), { required: true, autoComplete: 'organization' })}
                {field('website', t('fields.website'), { type: 'url', autoComplete: 'url' })}
                <div>
                  <Label htmlFor="description">{t('fields.description')}</Label>
                  <Controller
                    control={form.control}
                    name="description"
                    render={({ field: f }) => (
                      <Textarea
                        id="description"
                        rows={4}
                        aria-invalid={Boolean(errors.description)}
                        aria-describedby={errors.description ? 'description-error description-count' : 'description-count'}
                        {...f}
                      />
                    )}
                  />
                  {errors.description ? (
                    <p id="description-error" role="alert" className="mt-1 text-caption text-destructive">
                      {errors.description.message}
                    </p>
                  ) : null}
                  <p id="description-count" className="mt-1 text-caption text-muted-foreground">
                    {form.watch('description')?.length ?? 0}/2000
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="font-heading text-base font-medium leading-snug">{t('registeredAddressSection')}</h2>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {field('regLine1', t('fields.line1'), { autoComplete: 'address-line1' })}
                {field('regLine2', t('fields.line2'), { autoComplete: 'address-line2' })}
                {field('regSubDistrict', t('fields.subDistrict'))}
                {field('regCity', t('fields.city'), { autoComplete: 'address-level2' })}
                {field('regProvince', t('fields.province'), { autoComplete: 'address-level1' })}
                {field('regPostalCode', t('fields.postalCode'), { autoComplete: 'postal-code' })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <h2 className="font-heading text-base font-medium leading-snug">{t('billingAddressSection')}</h2>
                <p className="text-caption text-muted-foreground">{t('billingAddressHint')}</p>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {field('billLine1', t('fields.line1'))}
                {field('billLine2', t('fields.line2'))}
                {field('billSubDistrict', t('fields.subDistrict'))}
                {field('billCity', t('fields.city'))}
                {field('billProvince', t('fields.province'))}
                {field('billPostalCode', t('fields.postalCode'))}
                {field('billCountry', t('fields.country'), { autoComplete: 'country' })}
              </CardContent>
            </Card>
          </>
        ) : (
          <InlineAlert tone="neutral" role="note" data-testid="secondary-note">
            {t('secondaryNote')}
          </InlineAlert>
        )}

        {/* FR-010 — GDPR Art. 13 / PDPA § 23 notice */}
        <p className="text-caption text-muted-foreground" data-testid="review-notice">
          {t('notice')}{' '}
          <a href={privacyNoticeHref} className="text-primary underline-offset-4 hover:underline" target="_blank" rel="noreferrer">
            {t('privacyLink')}
          </a>
        </p>

        {/* FR-034 — outcome messages announced through a live region, not a toast */}
        <div id={statusId} role="status" aria-live="polite" className={statusMessage ? 'text-sm' : 'sr-only'} data-testid="submit-status">
          {statusMessage ? <InlineAlert tone={status.kind === 'rate_limited' ? 'warning' : 'info'} role="none">{statusMessage}</InlineAlert> : null}
        </div>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push('/portal/profile')}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                {t('submitting')}
              </>
            ) : (
              t('submit')
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
