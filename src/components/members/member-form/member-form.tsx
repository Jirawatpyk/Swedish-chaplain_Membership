'use client';

/**
 * T053 — Member creation form (composition root).
 *
 * Decomposed from a single 1,116-line file into `member-form/` (PR-B task 4,
 * pure move — see `schema.ts`, `use-member-form-errors.ts`, `field-error.tsx`,
 * `sections/*`). This file now only owns: `useForm`, the server-field-error
 * effect, the error summary, the section list, and the footer.
 *
 * Spec compliance:
 *   - **FR-035 tri-part required indicator**: every required field gets
 *     (a) `aria-required="true"` programmatic + `required` attribute,
 *     (b) visible red asterisk in the label,
 *     (c) a form-top note "* fields are required".
 *     All three are present — a11y test (T053a) asserts the combination.
 *   - **FR-036 autocomplete attrs**: `given-name` / `family-name` on
 *     contact first/last name, `email`, `tel` on phone, `organization`
 *     on company name, `url` on website.
 *   - **FR-037 page title**: enforced by the parent Server Component via
 *     `generateMetadata`.
 *   - **Thai Alumni DOB gate**: `date_of_birth` field visible only when
 *     the selected plan is flagged as Thai Alumni (`max_member_age` set).
 *     Deferred to a simpler heuristic for B.2.b — shown whenever the
 *     plan metadata carries a max age; US3 can refine.
 *   - **Submit path**: delegates to the `onSubmit` callback provided by
 *     the parent client wrapper, which handles API call + dialog
 *     confirmations + redirect.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormErrorSummary } from '@/components/ui/form-error-summary';
import { type Translator } from '@/lib/zod-i18n';
import {
  buildMemberFormSchema,
  type MemberFormValues,
  type ResolvedServerFieldError,
  type PlanOption,
} from './schema';
import { useMemberFormErrors } from './use-member-form-errors';
import { CompanySection } from './sections/company-section';
import { MembershipSection } from './sections/membership-section';
import { AddressSection } from './sections/address-section';
import { TaxBranchSection } from './sections/tax-branch-section';
import { ContactFields } from './sections/contact-fields';
import { SecondaryContactSection } from './sections/secondary-contact-section';

type Props = {
  readonly plans: readonly PlanOption[];
  readonly defaultPlanYear: number;
  readonly onSubmit: (values: MemberFormValues) => Promise<void> | void;
  readonly submitting: boolean;
  readonly onCancel?: () => void;
  /** When set, pre-fills the form from these values (edit mode). */
  readonly initialValues?: Partial<MemberFormValues>;
  /** 'create' (default) or 'edit' — switches submit/submitting labels. */
  readonly mode?: 'create' | 'edit';
  /**
   * A server-rejected field (POST 400/409) to surface inline: highlights +
   * focuses the input and shows `message` under it, instead of a generic
   * toast with nothing marked. Each new object reference re-applies the error.
   */
  readonly serverFieldError?: ResolvedServerFieldError | null;
};

export function MemberForm({
  plans,
  defaultPlanYear,
  onSubmit,
  submitting,
  onCancel,
  initialValues,
  mode = 'create',
  serverFieldError,
}: Props) {
  // Shared copy (section headers, required note, field labels) lives
  // under `admin.members.create.*` since it's identical for create +
  // edit. Only the submit button + submitting label differ per mode —
  // those resolve via `submitLabel` / `submittingLabel` below.
  const t = useTranslations('admin.members.create');
  const tEdit = useTranslations('admin.members.edit');
  const tf = useTranslations('admin.members.create.fields');
  const tv = useTranslations('shared.validation');
  const submitLabel = mode === 'edit' ? tEdit('submit') : t('submit');
  const submittingLabel =
    mode === 'edit' ? tEdit('submitting') : t('submitting');
  const cancelLabel = mode === 'edit' ? tEdit('cancel') : t('cancel');

  // Track the selected plan in local state (not RHF `watch`) so the schema can
  // be rebuilt with the conditional-DOB requirement BEFORE useForm consumes the
  // resolver — avoids the watch()→useForm circular dependency.
  const [planId, setPlanId] = useState<string>(initialValues?.plan_id ?? '');
  const selectedPlan = plans.find((p) => p.plan_id === planId);
  const needsDob = Boolean(selectedPlan?.requires_date_of_birth);

  // Build the zod schema with the active-locale field-error translator + the
  // conditional DOB requirement. `tf` is stable per locale render (next-intl);
  // the memo re-runs on a locale switch or when the plan toggles DOB-required.
  const schema = useMemo(
    () =>
      buildMemberFormSchema(
        tf as (key: string) => string,
        tv as Translator,
        needsDob,
        mode,
      ),
    [tf, tv, needsDob, mode],
  );

  const methods = useForm<MemberFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      country: initialValues?.country ?? 'TH',
      plan_year: initialValues?.plan_year ?? defaultPlanYear,
      ...(initialValues ?? {}),
      primary_contact: {
        preferred_language: 'en',
        ...(initialValues?.primary_contact ?? {}),
      },
    } as MemberFormValues,
  });
  const {
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = methods;

  // PR-B task 9 — beforeunload unsaved-changes guard (docs/ux-patterns.md
  // § 4.2 names "member edit" explicitly; PR-B roughly doubled this form's
  // size, so losing ~40 filled fields to a stray tab-close/refresh is a
  // real, expensive failure). Clone of the broadcasts compose-form /
  // issue-invoice-form guard. Active only when RHF's own dirty-tracking
  // has diverged from the initial values AND we're not mid-submit (the
  // post-submit redirect would false-trigger the prompt). `isDirty` is
  // read here (component top level, via formState destructuring) rather
  // than inside the effect — react-hook-form's `formState` is a Proxy that
  // only subscribes to fields actually read during render; reading it only
  // inside the effect body would silently never update. Note: App Router
  // exposes no clean SPA route-change interception, so this covers tab
  // close / hard nav / refresh only, not in-app navigation.
  useEffect(() => {
    const dirty = !submitting && isDirty;
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string and show their own copy;
      // preventDefault + returnValue is the cross-browser invocation pattern.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [submitting, isDirty]);

  // 088 US3 (FR-008) — the head-office toggle drives the conditional 5-digit
  // branch_code input (rendered on the EDIT form only). Local state so the
  // conditional field mounts/unmounts without a RHF `watch()` dependency loop.
  const [isHeadOffice, setIsHeadOffice] = useState<boolean>(
    initialValues?.is_head_office ?? true,
  );

  // 059 / PR-A Task 3b — the ONE piece of state shared between two SIBLING
  // sections: CompanySection's entity-type Select (seeds is_vat_registered)
  // and TaxBranchSection's is_vat_registered Checkbox (marks itself
  // hand-touched). A `useRef` — not lifted `useState` — is deliberate:
  // flipping it must never cause a re-render, and it must survive for the
  // form's whole lifetime without being reset by anything. See
  // `resolve-vat-seed.ts` for the read side and tax-branch-section.tsx's
  // `onCheckedChange` for the write side.
  const vatManuallyTouchedRef = useRef(false);

  // Surface a server-rejected field (email-in-use, bad tax-id checksum, …)
  // inline: highlight + focus the originating input per WCAG 3.3.1 instead of
  // the old generic toast with nothing marked. A new `serverFieldError` object
  // reference (one per failed submit) re-runs this even for the same field.
  //
  // INVARIANT: this only SETS an error, never clears it. Two separate
  // mechanisms keep that safe: (1) a `type:'server'` error is removed by RHF's
  // resolver re-running on the next submit (every submit runs the resolver; the
  // field then passes its own zod rule) — this is what actually clears the
  // highlight; (2) the parent resets serverFieldError to null at the start of
  // each submit purely so this effect does not RE-APPLY a stale error (the
  // effect early-returns on null). Nulling the prop does not itself clear the
  // RHF error. If a future caller nulls it expecting the highlight to vanish
  // WITHOUT a resubmit (a "dismiss" affordance), add a clearErrors() here.
  useEffect(() => {
    if (!serverFieldError) return;
    setError(
      serverFieldError.field,
      { type: 'server', message: serverFieldError.message },
      { shouldFocus: true },
    );
  }, [serverFieldError, setError]);

  const summaryItems = useMemberFormErrors({
    errors,
    needsDob,
    mode,
    isHeadOffice,
    tf: tf as (key: string) => string,
    secondaryContactLabel: t('sections.secondaryContact'),
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSubmit)} method="post" noValidate className="flex flex-col gap-[var(--page-section-gap)]">
        {/* FR-035 part (c): form-top required fields note */}
        <p className="text-sm text-muted-foreground" id="required-fields-note">
          {t('requiredNote')}
        </p>

        {/* Summary only when MORE THAN ONE error (ux-standards § 11.3); a single
          * error is already covered by its inline field message + RHF focus. */}
        <FormErrorSummary
          title={t('errorSummaryTitle')}
          items={summaryItems.length > 1 ? summaryItems : []}
          autoFocus={false}
        />

        <CompanySection mode={mode} vatManuallyTouchedRef={vatManuallyTouchedRef} />
        <MembershipSection plans={plans} mode={mode} onPlanIdChange={setPlanId} />
        <AddressSection mode={mode} />

        {/* 059 / PR-A — rendered on CREATE as well as edit (it used to be
            edit-only). `is_vat_registered` is what makes the buyer's
            "สำนักงานใหญ่ / สาขาที่ NNNNN" line print (ประกาศอธิบดีฯ 199), and with
            the section hidden at create there was NO path — not this form, not
            the bulk importer — that could set it when the member was created.
            Every member was born a non-registrant and had to be edited
            afterwards to become one, which is exactly how the original defect
            (no member ever received the line) would have quietly returned.

            The head-office / branch controls inside the section reveal
            themselves only once the VAT box is ticked, so a natural person
            still never sees them. */}
        <TaxBranchSection
          mode={mode}
          isHeadOffice={isHeadOffice}
          onIsHeadOfficeChange={setIsHeadOffice}
          vatManuallyTouchedRef={vatManuallyTouchedRef}
        />

        {/* --- Primary contact section --- */}
        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-2 text-base font-semibold">
            {t('sections.primaryContact')}
          </legend>
          <ContactFields
            prefix="primary_contact"
            idPrefix="contact"
            showDateOfBirth={needsDob}
            required
          />
        </fieldset>

        {/* --- Secondary contact — CREATE only (PR-B task 8) --- */}
        {mode === 'create' && <SecondaryContactSection />}

        <div className="flex items-center justify-end gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              {cancelLabel}
            </Button>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {submitting ? submittingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
