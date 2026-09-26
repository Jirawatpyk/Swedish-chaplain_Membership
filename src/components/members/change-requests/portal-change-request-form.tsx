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
 *   - 320 px: single column; sections are AURA cards with a real `<h2>`
 *     title (no radio / checkbox groups here, so no fieldset is needed).
 *   - Spec 122 US3: AURA fields; `FormErrorSummary` after a failed submit
 *     (client or server field errors — it takes focus and links to each
 *     field, so the form no longer calls `setFocus`); Cancel + Submit in an
 *     `ActionBar` that reads "Unsaved changes" while the form is dirty.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Controller, useForm, type Path } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import { ActionBar, Button, FormErrorSummary, TextField, Textarea } from '@jirawatpyk/aura-react';
import { AuraAlert, AuraCard } from '@/components/shell/aura-markup';
import { boundedText, requiredText, type Translator } from '@/lib/zod-i18n';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
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

/**
 * The billing group is ONE unit — the schema's `superRefine` and the labels'
 * `billTouched` must read the same seven fields, so they read this list.
 */
const BILLING_GROUP_FIELDS = ['billLine1', 'billLine2', 'billSubDistrict', 'billCity', 'billProvince', 'billPostalCode', 'billCountry'] as const;

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
  }).superRefine((v, ctx) => {
    // the billing group is ONE unit: any line ⇒ line1 + city + postal code + country
    if (!BILLING_GROUP_FIELDS.some((k) => v[k].trim() !== '')) return;
    for (const key of ['billLine1', 'billCity', 'billPostalCode', 'billCountry'] as const) {
      if (v[key].trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: tf('errors.billingIncomplete') });
    }
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
  /** The TENANT's privacy notice URL; null when unset — the notice text still renders, the link does not (never a dead link). */
  readonly privacyNoticeHref: string | null;
  /** US3 — the decided request being resubmitted (reason shown above the form). */
  readonly resubmitOf?: ChangeRequestView | null;
}

type StatusKind = 'nothing_to_submit' | 'already_pending' | 'already_pending_unchanged' | 'rate_limited' | 'read_only' | null;

export function PortalChangeRequestForm({
  initialValues,
  canProposeCompanyFields,
  pending,
  privacyNoticeHref,
  resubmitOf = null,
}: PortalChangeRequestFormProps) {
  const t = useTranslations('portal.changeRequests.form');
  const tStatus = useTranslations('portal.changeRequests.status');
  const tReplaced = useTranslations('portal.changeRequests.replaced');
  const tErrors = useTranslations('portal.changeRequests.errors');
  const tv = useTranslations('shared.validation');
  const tc = useTranslations('common');
  const locale = useLocale();
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
    // the error summary takes focus after a failed submit, not the field
    shouldFocusError: false,
  });
  const { errors, submitCount, isDirty } = form.formState;

  /**
   * PER RULE (PR-1 review, UX M12): the server refuses what the client schema
   * let through — its phone parser is stricter, a website scheme, a length
   * bound, the country code — and the member must learn WHICH rule, not
   * "check this value". Ordered: the most specific rule wins.
   */
  function serverIssueMessage(
    field: Path<ChangeRequestFormValues>,
    issue: { readonly message: string; readonly code: unknown; readonly maximum: unknown },
  ): string {
    const { message, code, maximum } = issue;
    if (message === 'billing_address_incomplete') return t('errors.billingIncomplete');
    if (message.startsWith('invalid phone')) return t('errors.phone');
    if (message === 'website scheme not allowed' || (code === 'invalid_string' && field === 'website')) return t('errors.website');
    if (field === 'billCountry') return t('errors.country');
    if (code === 'too_big' && typeof maximum === 'number') return tv('tooLong', { max: maximum });
    if (code === 'too_small') return tv('required');
    return tErrors('field');
  }

  /**
   * ONE `Idempotency-Key` per submission ATTEMPT SEQUENCE (T122, post-ship
   * review #3). A key minted per ATTEMPT made the header decorative: a
   * double-click or a retry after a dropped response reached the server as two
   * distinct requests, and the second one REPLACED the first (the
   * one-pending-per-submitter rule) while burning another of the member's ten
   * daily submissions.
   *
   * Minted lazily (never during render, so a StrictMode remount just mints on
   * first use) and kept ONLY for the arms the route leaves retryable: a 429
   * (either bucket) and any 5xx — those release the reservation (T121) and
   * evaluate the retry afresh — plus a network drop, where nothing came back
   * at all. EVERY other response ends the sequence, because the route
   * REMEMBERS its answer under the key (`mapRefusal`: the 2xx bodies, the
   * validation 422, 403 `forbidden` / `company_fields_require_primary` /
   * `member_archived`, 404 `not_found`), and a remembered key answers a
   * CHANGED body with 422 `idempotency-key-reused` — so a member who fixed
   * what the refusal named would have been stuck until they reloaded (seam
   * pass 2026-09-16, finding #1). A 422 `idempotency-key-reused` is terminal
   * for the same reason in reverse: that key is already burnt.
   */
  const idempotencyKeyRef = useRef<string | null>(null);
  const takeIdempotencyKey = (): string => {
    idempotencyKeyRef.current ??= crypto.randomUUID();
    return idempotencyKeyRef.current;
  };
  const endAttemptSequence = (): void => {
    idempotencyKeyRef.current = null;
  };
  /** The two arms the route leaves retryable under the SAME key (T121): the 429s and every 5xx. */
  const keySurvives = (status: number): boolean => status === 429 || status >= 500;

  const onSubmit = async (values: ChangeRequestFormValues) => {
    setSubmitting(true);
    setStatus({ kind: null });
    try {
      const res = await fetch('/api/portal/change-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': takeIdempotencyKey() },
        body: JSON.stringify(buildProposalBody(values, canProposeCompanyFields)),
      });
      const data = (await res.json().catch(() => null)) as
        | { outcome?: string; unchanged?: boolean; replaced?: string | null; error?: string; issues?: Array<{ path?: unknown }>; retryAfterSeconds?: number }
        | null;

      // ONE decision for the whole response table: anything the route can
      // REMEMBER under this key ends the attempt sequence, so the member's
      // next (changed) body travels under a fresh key instead of reading back
      // as `idempotency-key-reused`. Only the retryable arms keep it.
      if (!keySurvives(res.status)) endAttemptSequence();

      if (res.ok) {
        if (data?.outcome === 'submitted') {
          // US5 AS2: a resubmit REPLACED the earlier pending request — say so
          toast.success(typeof data.replaced === 'string' ? tReplaced('status') : tStatus('submitted'));
          router.push('/portal/profile');
          return;
        }
        if (data?.outcome === 'already_pending') {
          // `unchanged`: the member typed the RECORD's values back while a
          // different proposal is pending — "these changes are awaiting
          // review" would be a lie (round 7, code R1)
          setStatus({ kind: data.unchanged === true ? 'already_pending_unchanged' : 'already_pending' });
          return;
        }
        if (data?.outcome === 'nothing_to_submit') {
          setStatus({ kind: 'nothing_to_submit' });
          return;
        }
        // a 2xx whose body is not one of the three outcomes (an interstitial,
        // a truncated stream) must not be announced as "nothing to submit" —
        // the request may well exist (round 5, silent-failure #4)
        toast.error(tErrors('generic'));
        return;
      }

      // The write freeze (either envelope): refused before the route ran, so
      // nothing was stored. Inline like the other outcomes, not a generic
      // toast — the values stay in the form and the key survives (`keySurvives`
      // keeps it for every 5xx), so the retry is the same attempt.
      if (isReadOnlyRefusal(res.status, data)) {
        setStatus({ kind: 'read_only' });
        return;
      }
      if (res.status === 422 && data?.error === 'validation_error' && Array.isArray(data.issues)) {
        // The error summary lists every mapped field and takes focus.
        let mapped = false;
        for (const issue of data.issues) {
          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
          const field = PATH_TO_FIELD[path];
          if (field) {
            const raw = (issue as { message?: unknown }).message;
            const message = serverIssueMessage(field, {
              message: typeof raw === 'string' ? raw : '',
              code: (issue as { code?: unknown }).code,
              maximum: (issue as { maximum?: unknown }).maximum,
            });
            form.setError(field, { type: 'server', message });
            mapped = true;
          }
        }
        if (!mapped) toast.error(tErrors('validation'));
        return;
      }
      if (res.status === 429) {
        // date + time in the app locale / Asia/Bangkok — the window is a
        // rolling 24 h, so a bare clock time was wrong by up to a day
        // (review: UX I5); no retry hint at all when the server sent none
        const seconds = typeof data?.retryAfterSeconds === 'number' ? data.retryAfterSeconds : null;
        const retryAt =
          seconds === null
            ? undefined
            : formatLocalisedDate(new Date(Date.now() + seconds * 1000).toISOString(), locale, { dateStyle: 'medium', timeStyle: 'short' });
        setStatus(retryAt === undefined ? { kind: 'rate_limited' } : { kind: 'rate_limited', retryAt });
        return;
      }
      if (res.status === 409 && data?.error === 'approval_not_required') {
        toast.info(tStatus('approvalNotRequired'));
        router.refresh();
        return;
      }
      const code = data?.error;
      if (code === 'member_archived') toast.error(tErrors('archived'));
      else if (code === 'forbidden' || code === 'company_fields_require_primary') toast.error(tErrors('forbidden'));
      else toast.error(tErrors('generic'));
    } catch (e) {
      // a client-side bug in this block must not be indistinguishable from a
      // network drop (round 6, silent-failure #12)
      console.error('[change-request-form] submit failed', e);
      toast.error(tErrors('generic'));
    } finally {
      setSubmitting(false);
    }
  };

  function field(name: Path<ChangeRequestFormValues>, label: string, opts: { required?: boolean; type?: string; autoComplete?: string } = {}) {
    return (
      <TextField
        id={name}
        label={label}
        type={opts.type ?? 'text'}
        autoComplete={opts.autoComplete}
        required={opts.required}
        error={errors[name]?.message}
        {...form.register(name)}
      />
    );
  }

  // the billing group is ONE unit (the schema's superRefine): once any line
  // is filled, line 1 / city / postal code / country are required — say so on
  // the labels, not only in the error (PR-1 review, UX M11)
  const billTouched = BILLING_GROUP_FIELDS.some((k) => (form.watch(k) ?? '').trim() !== '');

  function statusMessageOf(s: { kind: StatusKind; retryAt?: string }): string {
    switch (s.kind) {
      case 'nothing_to_submit':
        return tStatus('nothingToSubmit');
      case 'already_pending':
        return tStatus('alreadyPending');
      case 'already_pending_unchanged':
        return tStatus('alreadyPendingUnchanged');
      case 'rate_limited':
        // no retry hint at all when the server sent none
        return s.retryAt ? tStatus('rateLimited', { retryAt: s.retryAt }) : tStatus('rateLimitedGeneric');
      case 'read_only':
        return tStatus('readOnly');
      case null:
        return '';
      default: {
        const _exhaustive: never = s.kind;
        void _exhaustive;
        return '';
      }
    }
  }
  const statusMessage = statusMessageOf(status);

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} method="post" noValidate aria-describedby="cr-required-fields-note" data-testid="change-request-form">
      <div className="space-y-6">
        <p className="text-sm text-[var(--aura-fg-secondary)]" id="cr-required-fields-note">
          {t('requiredNote')}
        </p>
        <FormErrorSummary errors={errors} focusKey={submitCount} />
        {resubmitOf && resubmitOf.decisionReason ? (
          <AuraAlert tone="warning" role="status" title={t('resubmitTitle')} data-testid="resubmit-reason">
            <p className="whitespace-pre-wrap break-words">{resubmitOf.decisionReason}</p>
          </AuraAlert>
        ) : null}

        {pending ? (
          <AuraAlert tone="warning" role="none" data-testid="pending-hint">
            {t('pendingHint')}
          </AuraAlert>
        ) : null}

        <AuraCard title={t('contactSection')} titleId="cr-contact-heading" headingLevel={2}>
          <div className="grid gap-4 sm:grid-cols-2">
            {field('firstName', t('fields.firstName'), { required: true, autoComplete: 'given-name' })}
            {field('lastName', t('fields.lastName'), { required: true, autoComplete: 'family-name' })}
            {field('phone', t('fields.phone'), { type: 'tel', autoComplete: 'tel' })}
            {field('roleTitle', t('fields.roleTitle'), { autoComplete: 'organization-title' })}
          </div>
        </AuraCard>

        {canProposeCompanyFields ? (
          <>
            <AuraCard title={t('companySection')} titleId="cr-company-heading" headingLevel={2}>
              <div className="grid gap-4">
                {field('companyName', t('fields.companyName'), { required: true, autoComplete: 'organization' })}
                {field('website', t('fields.website'), { type: 'url', autoComplete: 'url' })}
                <div>
                  <Controller
                    control={form.control}
                    name="description"
                    render={({ field: f }) => (
                      <Textarea
                        id="description"
                        label={t('fields.description')}
                        rows={4}
                        error={errors.description?.message}
                        aria-describedby="description-count"
                        {...f}
                      />
                    )}
                  />
                  <p id="description-count" className="mt-1 text-right text-xs text-[var(--aura-fg-secondary)]">
                    {form.watch('description')?.length ?? 0}/2000
                  </p>
                </div>
              </div>
            </AuraCard>

            <AuraCard title={t('registeredAddressSection')} titleId="cr-registered-heading" headingLevel={2}>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('regLine1', t('fields.line1'), { autoComplete: 'address-line1' })}
                {field('regLine2', t('fields.line2'), { autoComplete: 'address-line2' })}
                {field('regSubDistrict', t('fields.subDistrict'))}
                {field('regCity', t('fields.city'), { autoComplete: 'address-level2' })}
                {field('regProvince', t('fields.province'), { autoComplete: 'address-level1' })}
                {field('regPostalCode', t('fields.postalCode'), { autoComplete: 'postal-code' })}
              </div>
            </AuraCard>

            <AuraCard
              title={t('billingAddressSection')}
              titleId="cr-billing-heading"
              description={t('billingAddressHint')}
              headingLevel={2}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {field('billLine1', t('fields.line1'), { required: billTouched })}
                {field('billLine2', t('fields.line2'))}
                {field('billSubDistrict', t('fields.subDistrict'))}
                {field('billCity', t('fields.city'), { required: billTouched })}
                {field('billProvince', t('fields.province'))}
                {field('billPostalCode', t('fields.postalCode'), { required: billTouched })}
                {field('billCountry', t('fields.country'), { autoComplete: 'country', required: billTouched })}
              </div>
            </AuraCard>
          </>
        ) : (
          <AuraAlert tone="info" role="note" data-testid="secondary-note">
            {t('secondaryNote')}
          </AuraAlert>
        )}

        {/* FR-010 — GDPR Art. 13 / PDPA § 23 notice */}
        <p className="text-xs text-[var(--aura-fg-secondary)]" data-testid="review-notice">
          {t('notice')}
          {privacyNoticeHref ? (
            <>
              {' '}
              <a
                href={privacyNoticeHref}
                className="text-[var(--aura-fg-accent)] underline underline-offset-4 hover:text-[var(--aura-fg-primary)]"
                target="_blank"
                rel="noreferrer"
              >
                {t('privacyLink')}
              </a>
            </>
          ) : null}
        </p>

        {/* FR-034 — outcome messages announced through a live region, not a toast */}
        <div id={statusId} role="status" aria-live="polite" className={statusMessage ? 'text-sm' : 'sr-only'} data-testid="submit-status">
          {statusMessage ? (
            <AuraAlert tone={status.kind === 'rate_limited' || status.kind === 'read_only' ? 'warning' : 'info'} role="none">
              {statusMessage}
            </AuraAlert>
          ) : null}
        </div>

        {/* Cancel before Submit (ux-standards § 11.1), in the ActionBar. */}
        <ActionBar status={isDirty ? tc('unsavedStatus') : null}>
          <Button type="button" variant="secondary" onClick={() => router.push('/portal/profile')}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={submitting}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </ActionBar>
      </div>
    </form>
  );
}
