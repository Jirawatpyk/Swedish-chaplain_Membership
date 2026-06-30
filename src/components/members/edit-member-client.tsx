'use client';

/**
 * T094 — Edit member client wrapper.
 *
 * Composes MemberForm with PATCH semantics:
 *   - Detects plan change (new plan_id OR new plan_year)
 *   - Dispatches to PATCH /api/members/[memberId] with appropriate body:
 *       { new_plan_id, new_plan_year, confirm_bundle_change? } for plan
 *       changes, plain field patch otherwise.
 *   - Handles 409 bundle_change_requires_confirmation →
 *     BundleChangeWarningDialog → re-submit with confirm.
 *   - Handles 422 turnover/startup warnings → OverrideReasonDialog.
 *   - 200 → toast + redirect to detail page.
 */

import { useRef, useState } from 'react';
import type { Path } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MemberForm, type MemberFormValues, type PlanOption } from './member-form';
import { mapMemberCreateServerError } from './member-create-error-map';
import {
  BundleChangeWarningDialog,
  type BundleChangePayload,
} from './bundle-change-warning-dialog';
import {
  OverrideReasonDialog,
  type OverrideReasonResult,
} from './override-reason-dialog';
import { formatOverrideWarning } from './override-warning-message';
import {
  buildFieldPayload,
  buildContactPayload,
  hasFieldDiff,
  contactFieldsChanged as contactFieldsChangedPure,
  contactEmailChanged as contactEmailChangedPure,
  planChanged as planChangedPure,
  type MemberInitialValues,
  type EditablePrimaryContact,
} from './edit-member-payloads';

// MemberInitialValues + EditablePrimaryContact are defined alongside the
// pure payload builders in ./edit-member-payloads (imported above).

type Props = {
  readonly member: MemberInitialValues;
  readonly plans: readonly PlanOption[];
  readonly primaryContact: EditablePrimaryContact;
};

import { uuid } from '@/lib/uuid';

export function EditMemberClient({ member, plans, primaryContact }: Props) {
  const t = useTranslations('admin.members.edit');
  // mapMemberCreateServerError returns i18n keys relative to the
  // `admin.members.create` namespace (shared field-error vocabulary); resolve
  // them through this translator so the edit form reuses the same messages.
  const tCreate = useTranslations('admin.members.create');
  const tOverride = useTranslations('admin.members.overrideReason');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [bundleState, setBundleState] = useState<BundleChangePayload | null>(null);
  const [overrideState, setOverrideState] = useState<{ message: string } | null>(
    null,
  );
  const [serverFieldError, setServerFieldError] = useState<{
    readonly field: Path<MemberFormValues>;
    readonly message: string;
  } | null>(null);
  const lastValuesRef = useRef<MemberFormValues | null>(null);
  const idemKeyRef = useRef<string>(uuid());

  const patch = async (body: Record<string, unknown>): Promise<Response> => {
    return fetch(`/api/members/${member.memberId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idemKeyRef.current,
      },
      body: JSON.stringify(body),
    });
  };

  /**
   * PATCH the member's primary contact. The edit form exposes the primary
   * contact's name / phone / role / language / email, but those edits used
   * to be silently dropped — `fieldPayload` / `planPayload` only ever sent
   * member-company + plan fields to `PATCH /api/members/[memberId]`, and
   * `updateMemberSchema` (`.strict()`) carries no contact fields. The
   * contact endpoint + `updateContactFields` use case already exist; this
   * wires the form to actually call them. Each call gets a fresh
   * idempotency key.
   */
  const patchContact = async (
    body: Record<string, unknown>,
  ): Promise<Response> => {
    idemKeyRef.current = uuid();
    return fetch(
      `/api/members/${member.memberId}/contacts/${primaryContact.contactId}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idemKeyRef.current,
        },
        body: JSON.stringify(body),
      },
    );
  };

  /** Returns true on success; otherwise shows a localised toast. */
  const handleContactResponse = async (res: Response): Promise<boolean> => {
    if (res.ok) return true;
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code;
    if (res.status === 409 && code === 'not_supported') {
      toast.error(t('errors.emailChangeNotSupported'));
    } else if (res.status === 409 && code === 'conflict') {
      // Highlight the email input (parity with the create flow) on top of the
      // existing specific toast.
      setServerFieldError({
        field: 'primary_contact.email',
        message: t('errors.emailTaken'),
      });
      toast.error(t('errors.emailTaken'));
    } else if (res.status === 404) {
      toast.error(t('errors.contactNotFound'));
    } else if (
      res.status === 400 &&
      code === 'validation_error' &&
      body?.error?.details?.type === 'invalid_phone'
    ) {
      setServerFieldError({
        field: 'primary_contact.phone',
        message: t('errors.invalidPhone'),
      });
      toast.error(t('errors.invalidPhone'));
    } else if (res.status === 400) {
      toast.error(t('errors.validation'));
    } else {
      toast.error(t('errors.generic'));
    }
    return false;
  };

  const handleSuccess = () => {
    toast.success(t('success'));
    idemKeyRef.current = uuid();
    router.push(`/admin/members/${member.memberId}`);
    router.refresh();
  };

  const handleResponse = async (res: Response) => {
    if (res.ok) {
      handleSuccess();
      return;
    }
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code;
    if (res.status === 409 && code === 'bundle_change_requires_confirmation') {
      const details = body.error.details ?? {};
      setBundleState({
        oldBundleCorporatePlanId: details.oldBundleCorporatePlanId ?? null,
        newBundleCorporatePlanId: details.newBundleCorporatePlanId ?? null,
        oldPlanId: member.planId,
        oldPlanYear: member.planYear,
      });
      return;
    }
    if (res.status === 422) {
      setOverrideState({
        message: formatOverrideWarning(body.error?.details, tOverride),
      });
      return;
    }
    if (res.status === 403) {
      toast.error(t('errors.generic'));
      return;
    }
    if (res.status === 404) {
      toast.error(t('errors.notFound'));
      return;
    }
    // Field-attributable domain rejection (invalid tax-id checksum / country)
    // on the member-company PATCH — highlight + focus the field with its precise
    // message (parity with the create flow), instead of the generic toast that
    // marked nothing.
    const fieldError = mapMemberCreateServerError(
      res.status,
      code,
      body?.error?.details?.type,
    );
    if (fieldError) {
      const message = tCreate(fieldError.messageKey);
      setServerFieldError({ field: fieldError.field, message });
      toast.error(message);
      return;
    }
    if (res.status === 400) {
      toast.error(t('errors.validation'));
      return;
    }
    toast.error(t('errors.generic'));
  };

  // Thin wrappers that bind the captured `member` / `primaryContact` to the
  // pure builders in ./edit-member-payloads (unit-tested there).
  const planChanged = (values: MemberFormValues): boolean =>
    planChangedPure(values, member);

  const fieldPayload = (values: MemberFormValues): Record<string, unknown> =>
    buildFieldPayload(values);

  const contactFieldPayload = (
    values: MemberFormValues,
  ): Record<string, unknown> => buildContactPayload(values, primaryContact);

  const contactFieldsChanged = (values: MemberFormValues): boolean =>
    contactFieldsChangedPure(values, primaryContact);

  const contactEmailChanged = (values: MemberFormValues): boolean =>
    contactEmailChangedPure(values, primaryContact);

  const planPayload = (
    values: MemberFormValues,
    extras: {
      confirmBundle?: boolean;
      overrideReason?: OverrideReasonResult | null;
    } = {},
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      new_plan_id: values.plan_id,
      new_plan_year: values.plan_year,
    };
    if (extras.confirmBundle) body.confirm_bundle_change = true;
    if (extras.overrideReason) {
      body.override_reason_code = extras.overrideReason.code;
      body.override_reason_note = extras.overrideReason.note;
    }
    return body;
  };

  const onSubmit = async (values: MemberFormValues) => {
    lastValuesRef.current = values;
    setServerFieldError(null);
    setSubmitting(true);
    // Tracks whether an earlier request already persisted a mutation, so a
    // later-step failure can tell the admin "some changes were saved"
    // instead of leaving them to assume nothing landed.
    let savedSomething = false;
    // Shown when a later step fails after an earlier one already committed.
    const reportStepFailure = () => {
      if (savedSomething) toast.warning(t('errors.partialSave'));
    };
    try {
      // Each mutation is a SEPARATE request with its own idempotency key.
      // Order: member-company fields → contact fields → contact email →
      // plan change LAST (plan change may pop bundle/override dialogs that
      // re-submit only the plan payload, so the other edits must already
      // be persisted by then). These are NOT atomic across endpoints — the
      // partial-save warning + idempotent re-submit cover a mid-sequence
      // failure.

      // 1. Member-company field updates. (First step — a failure here means
      //    nothing has been persisted yet, so no partial-save warning.)
      if (hasFieldDiff(values, member)) {
        idemKeyRef.current = uuid();
        const fieldRes = await patch(fieldPayload(values));
        if (!fieldRes.ok) {
          await handleResponse(fieldRes);
          return;
        }
        savedSomething = true;
      }

      // 2. Primary-contact non-email fields (name / phone / role /
      //    language). Previously dropped — the form rendered these inputs
      //    but never sent them anywhere.
      if (contactFieldsChanged(values)) {
        const res = await patchContact(contactFieldPayload(values));
        if (!(await handleContactResponse(res))) {
          reportStepFailure();
          return;
        }
        savedSomething = true;
      }

      // 3. Primary-contact email change — constrained path (succeeds only
      //    when the contact is linked to a portal user; otherwise 409
      //    not_supported, surfaced via handleContactResponse).
      if (contactEmailChanged(values)) {
        const res = await patchContact({
          email: values.primary_contact.email.trim(),
          locale: values.primary_contact.preferred_language,
        });
        if (!(await handleContactResponse(res))) {
          reportStepFailure();
          return;
        }
        savedSomething = true;
      }

      // 4. Plan change last.
      if (planChanged(values)) {
        idemKeyRef.current = uuid();
        const res = await patch(planPayload(values));
        await handleResponse(res);
        return;
      }

      // All non-plan mutations succeeded (or nothing changed) → toast +
      // redirect to the detail page.
      handleSuccess();
    } catch {
      // Network / unexpected failure — without this the rejected fetch
      // would surface as an unhandled rejection with no user feedback.
      toast.error(t('errors.generic'));
      reportStepFailure();
    } finally {
      setSubmitting(false);
    }
  };

  const onBundleConfirm = async () => {
    if (!lastValuesRef.current) return;
    setBundleState(null);
    setSubmitting(true);
    try {
      idemKeyRef.current = uuid();
      const res = await patch(
        planPayload(lastValuesRef.current, { confirmBundle: true }),
      );
      await handleResponse(res);
    } finally {
      setSubmitting(false);
    }
  };

  const onOverrideConfirm = async (result: OverrideReasonResult) => {
    if (!lastValuesRef.current) return;
    setOverrideState(null);
    setSubmitting(true);
    try {
      idemKeyRef.current = uuid();
      const res = await patch(
        planPayload(lastValuesRef.current, { overrideReason: result }),
      );
      await handleResponse(res);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <MemberForm
        plans={plans}
        defaultPlanYear={member.planYear}
        initialValues={{
          company_name: member.companyName,
          legal_entity_type: member.legalEntityType ?? undefined,
          country: member.country,
          tax_id: member.taxId ?? undefined,
          website: member.website ?? undefined,
          description: member.description ?? undefined,
          address_line1: member.addressLine1 ?? undefined,
          address_line2: member.addressLine2 ?? undefined,
          city: member.city ?? undefined,
          province: member.province ?? undefined,
          postal_code: member.postalCode ?? undefined,
          // Round-4 R4-I3: the form schema now accepts `null` on input
          // (via `.nullable().optional()`) and transforms to `null` on
          // submit. Passing `member.notes` directly (string | null) is
          // safe — imperative `trigger('notes')` no longer fails.
          notes: member.notes,
          founded_year: member.foundedYear ?? undefined,
          turnover_thb: member.turnoverThb ?? undefined,
          plan_id: member.planId,
          plan_year: member.planYear,
          registration_date: member.registrationDate,
          primary_contact: {
            first_name: primaryContact.firstName,
            last_name: primaryContact.lastName,
            email: primaryContact.email,
            phone: primaryContact.phone ?? undefined,
            role_title: primaryContact.roleTitle ?? undefined,
            preferred_language: primaryContact.preferredLanguage,
          },
        }}
        onSubmit={onSubmit}
        submitting={submitting}
        onCancel={() => router.push(`/admin/members/${member.memberId}`)}
        mode="edit"
        serverFieldError={serverFieldError}
      />
      <BundleChangeWarningDialog
        open={bundleState !== null}
        onOpenChange={(next) => {
          if (!next) setBundleState(null);
        }}
        payload={bundleState}
        onConfirm={onBundleConfirm}
      />
      <OverrideReasonDialog
        open={overrideState !== null}
        onOpenChange={(next) => {
          if (!next) setOverrideState(null);
        }}
        warningMessage={overrideState?.message ?? null}
        onConfirm={onOverrideConfirm}
      />
    </>
  );
}
