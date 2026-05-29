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
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MemberForm, type MemberFormValues, type PlanOption } from './member-form';
import {
  BundleChangeWarningDialog,
  type BundleChangePayload,
} from './bundle-change-warning-dialog';
import {
  OverrideReasonDialog,
  type OverrideReasonResult,
} from './override-reason-dialog';

type MemberInitialValues = {
  readonly memberId: string;
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly country: string;
  readonly taxId: string | null;
  readonly website: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly foundedYear: number | null;
  readonly turnoverThb: number | null;
  readonly planId: string;
  readonly planYear: number;
  readonly registrationDate: string;
};

type Props = {
  readonly member: MemberInitialValues;
  readonly plans: readonly PlanOption[];
  readonly primaryContact: {
    readonly contactId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly phone: string | null;
    readonly roleTitle: string | null;
    readonly preferredLanguage: 'en' | 'th' | 'sv';
  };
};

import { uuid } from '@/lib/uuid';

export function EditMemberClient({ member, plans, primaryContact }: Props) {
  const t = useTranslations('admin.members.edit');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [bundleState, setBundleState] = useState<BundleChangePayload | null>(null);
  const [overrideState, setOverrideState] = useState<{ message: string } | null>(
    null,
  );
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
      toast.error(t('errors.emailTaken'));
    } else if (res.status === 404) {
      toast.error(t('errors.contactNotFound'));
    } else if (
      res.status === 400 &&
      code === 'validation_error' &&
      body?.error?.details?.type === 'invalid_phone'
    ) {
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
      setOverrideState({ message: JSON.stringify(body.error?.details ?? {}) });
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
    if (res.status === 400) {
      toast.error(t('errors.validation'));
      return;
    }
    toast.error(t('errors.generic'));
  };

  const planChanged = (values: MemberFormValues): boolean =>
    values.plan_id !== member.planId || values.plan_year !== member.planYear;

  const fieldPayload = (values: MemberFormValues): Record<string, unknown> => ({
    company_name: values.company_name.trim(),
    legal_entity_type: values.legal_entity_type?.trim() || null,
    country: values.country.toUpperCase(),
    tax_id: values.tax_id?.trim() || null,
    website: values.website?.trim() || null,
    description: values.description?.trim() || null,
    address_line1: values.address_line1?.trim() || null,
    address_line2: values.address_line2?.trim() || null,
    city: values.city?.trim() || null,
    province: values.province?.trim() || null,
    postal_code: values.postal_code?.trim() || null,
    // `values.notes` is already `string | null` after the form's zod
    // transform (round-3 N-I4). Safe to trim only when string.
    notes: values.notes ? values.notes.trim() || null : null,
    founded_year:
      typeof values.founded_year === 'number' ? values.founded_year : null,
    turnover_thb:
      typeof values.turnover_thb === 'number' ? values.turnover_thb : null,
  });

  /**
   * Non-email primary-contact patch — only the fields that actually
   * changed. Sending the full set would needlessly re-validate untouched
   * fields server-side (e.g. editing just the role would re-run the
   * strict E.164 phone check on the unchanged phone).
   */
  const contactFieldPayload = (
    values: MemberFormValues,
  ): Record<string, unknown> => {
    const c = values.primary_contact;
    const body: Record<string, unknown> = {};
    if (c.first_name.trim() !== primaryContact.firstName)
      body.first_name = c.first_name.trim();
    if (c.last_name.trim() !== primaryContact.lastName)
      body.last_name = c.last_name.trim();
    if ((c.phone?.trim() || null) !== (primaryContact.phone ?? null))
      body.phone = c.phone?.trim() || null;
    if ((c.role_title?.trim() || null) !== (primaryContact.roleTitle ?? null))
      body.role_title = c.role_title?.trim() || null;
    if (c.preferred_language !== primaryContact.preferredLanguage)
      body.preferred_language = c.preferred_language;
    return body;
  };

  /** True when any non-email primary-contact field changed. */
  const contactFieldsChanged = (values: MemberFormValues): boolean => {
    const c = values.primary_contact;
    return (
      c.first_name.trim() !== primaryContact.firstName ||
      c.last_name.trim() !== primaryContact.lastName ||
      (c.phone?.trim() || null) !== (primaryContact.phone ?? null) ||
      (c.role_title?.trim() || null) !== (primaryContact.roleTitle ?? null) ||
      c.preferred_language !== primaryContact.preferredLanguage
    );
  };

  /** True when the primary-contact email changed (constrained server-side). */
  const contactEmailChanged = (values: MemberFormValues): boolean =>
    values.primary_contact.email.trim() !== primaryContact.email;

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
    setSubmitting(true);
    try {
      // Each mutation is a SEPARATE request with its own idempotency key.
      // Order: member-company fields → contact fields → contact email →
      // plan change LAST (plan change may pop bundle/override dialogs that
      // re-submit only the plan payload, so the other edits must already
      // be persisted by then).

      // 1. Member-company field updates.
      if (hasFieldDiff(values, member)) {
        idemKeyRef.current = uuid();
        const fieldRes = await patch(fieldPayload(values));
        if (!fieldRes.ok) {
          await handleResponse(fieldRes);
          return;
        }
      }

      // 2. Primary-contact non-email fields (name / phone / role /
      //    language). Previously dropped — the form rendered these inputs
      //    but never sent them anywhere.
      if (contactFieldsChanged(values)) {
        const res = await patchContact(contactFieldPayload(values));
        if (!(await handleContactResponse(res))) return;
      }

      // 3. Primary-contact email change — constrained path (succeeds only
      //    when the contact is linked to a portal user; otherwise 409
      //    not_supported, surfaced via handleContactResponse).
      if (contactEmailChanged(values)) {
        const res = await patchContact({
          email: values.primary_contact.email.trim(),
          locale: values.primary_contact.preferred_language,
        });
        if (!(await handleContactResponse(res))) return;
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

function hasFieldDiff(
  values: MemberFormValues,
  member: MemberInitialValues,
): boolean {
  return (
    values.company_name.trim() !== member.companyName ||
    (values.country?.toUpperCase() ?? '') !== member.country ||
    (values.legal_entity_type?.trim() ?? null) !== (member.legalEntityType ?? null) ||
    (values.tax_id?.trim() ?? null) !== (member.taxId ?? null) ||
    (values.website?.trim() || null) !== (member.website ?? null) ||
    (values.address_line1?.trim() || null) !== (member.addressLine1 ?? null) ||
    (values.address_line2?.trim() || null) !== (member.addressLine2 ?? null) ||
    (values.city?.trim() || null) !== (member.city ?? null) ||
    (values.province?.trim() || null) !== (member.province ?? null) ||
    (values.postal_code?.trim() || null) !== (member.postalCode ?? null) ||
    // Round-3 N-I5: use `|| null` consistently so empty string is treated
    // the same way as the fieldPayload builder (line 137) — otherwise the
    // diff says "changed" but the payload sends `null` (no-op PATCH).
    (values.description?.trim() || null) !== (member.description ?? null) ||
    (values.notes ? values.notes.trim() || null : null) !== (member.notes ?? null) ||
    (typeof values.founded_year === 'number' ? values.founded_year : null) !==
      (member.foundedYear ?? null) ||
    (typeof values.turnover_thb === 'number' ? values.turnover_thb : null) !==
      (member.turnoverThb ?? null)
  );
}
