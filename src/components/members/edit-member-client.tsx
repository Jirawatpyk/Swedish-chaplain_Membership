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
    notes: values.notes?.trim() || null,
    founded_year:
      typeof values.founded_year === 'number' ? values.founded_year : null,
    turnover_thb:
      typeof values.turnover_thb === 'number' ? values.turnover_thb : null,
  });

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
      if (planChanged(values)) {
        // Plan change is a SEPARATE request from field updates. Field
        // edits first (if any), then plan change. The idempotency layer
        // handles each with its own key.
        const fieldChanged = hasFieldDiff(values, member);
        if (fieldChanged) {
          idemKeyRef.current = uuid();
          const fieldRes = await patch(fieldPayload(values));
          if (!fieldRes.ok) {
            await handleResponse(fieldRes);
            return;
          }
        }
        idemKeyRef.current = uuid();
        const res = await patch(planPayload(values));
        await handleResponse(res);
      } else {
        const res = await patch(fieldPayload(values));
        await handleResponse(res);
      }
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
          notes: member.notes ?? undefined,
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
    (values.description?.trim() ?? null) !== (member.description ?? null) ||
    (values.notes?.trim() || null) !== (member.notes ?? null) ||
    (typeof values.founded_year === 'number' ? values.founded_year : null) !==
      (member.foundedYear ?? null) ||
    (typeof values.turnover_thb === 'number' ? values.turnover_thb : null) !==
      (member.turnoverThb ?? null)
  );
}
