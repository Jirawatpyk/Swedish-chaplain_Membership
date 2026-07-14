'use client';

/**
 * T052 — Client wrapper for the /admin/members/new page.
 *
 * Owns:
 *   - Idempotency-Key generation (one per form instance — regenerated on
 *     successful 201 to avoid replay on next submit).
 *   - Form submit → POST /api/members with 4 branches:
 *       201 → toast success → redirect to detail page
 *       409 soft_duplicate → show SoftDuplicateDialog; on Proceed,
 *         re-submit with confirm_soft_duplicate=true
 *       422 turnover/age/startup warning → show OverrideReasonDialog;
 *         on confirm, re-submit with override_reason_{code,note}
 *       anything else → sonner toast with localized error message
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  MemberForm,
  type MemberFormValues,
  type PlanOption,
  type ResolvedServerFieldError,
} from './member-form';
import { mapMemberCreateServerError } from './member-create-error-map';
import {
  OverrideReasonDialog,
  type OverrideReasonResult,
} from './override-reason-dialog';
import { formatOverrideWarning } from './override-warning-message';
import { SoftDuplicateDialog } from './soft-duplicate-dialog';

type Props = {
  readonly plans: readonly PlanOption[];
  readonly defaultPlanYear: number;
};

type SoftDupState = {
  readonly existing: { readonly member_id: string; readonly company_name: string };
};

type OverrideState = {
  readonly message: string;
};

import { uuid } from '@/lib/uuid';

function toPayload(
  values: MemberFormValues,
  opts: {
    confirmSoftDuplicate?: boolean;
    overrideReason?: OverrideReasonResult | null;
  } = {},
) {
  const payload: Record<string, unknown> = {
    company_name: values.company_name.trim(),
    legal_entity_type: values.legal_entity_type?.trim() || null,
    country: values.country.toUpperCase(),
    tax_id: values.tax_id?.trim() || null,
    // 059 / PR-A — the §86/4 discriminator (ประกาศอธิบดีฯ 199). Without this key
    // the checkbox was dead state: `createMemberSchema` has accepted the field
    // since migration 0246, but the payload never sent it, so every member was
    // created a NON-registrant no matter what the admin ticked — and, with the
    // importer also not writing it, NO path could make a member a registrant at
    // birth. That is how "no member ever receives the branch line" would have
    // quietly come back.
    //
    // `is_head_office` / `branch_code` are deliberately NOT sent: the repo's
    // create `.values()` does not write them either (they take the DB defaults,
    // head-office/NULL), so creating a member directly as a BRANCH has never
    // been supported. That stays an edit-only operation — widening the create
    // write-surface is not this branch's business.
    is_vat_registered: values.is_vat_registered === true,
    website: values.website?.trim() || null,
    description: values.description?.trim() || null,
    notes: values.notes ? values.notes.trim() || null : null,
    address_line1: values.address_line1?.trim() || null,
    address_line2: values.address_line2?.trim() || null,
    city: values.city?.trim() || null,
    province: values.province?.trim() || null,
    postal_code: values.postal_code?.trim() || null,
    // PR-B task 6 — แขวง/ตำบล. TH-only in the UI; null for a non-TH address.
    sub_district: values.sub_district?.trim() || null,
    founded_year:
      typeof values.founded_year === 'number' ? values.founded_year : null,
    turnover_thb:
      typeof values.turnover_thb === 'number' ? values.turnover_thb : null,
    // PR-B task 7 — ทุนจดทะเบียน. A separate field from turnover_thb above.
    registered_capital_thb:
      typeof values.registered_capital_thb === 'number'
        ? values.registered_capital_thb
        : null,
    plan_id: values.plan_id,
    plan_year: values.plan_year,
    registration_date: values.registration_date || undefined,
    primary_contact: {
      first_name: values.primary_contact.first_name.trim(),
      last_name: values.primary_contact.last_name.trim(),
      email: values.primary_contact.email.trim(),
      phone: values.primary_contact.phone?.trim() || null,
      role_title: values.primary_contact.role_title?.trim() || null,
      preferred_language: values.primary_contact.preferred_language,
      date_of_birth: values.primary_contact.date_of_birth || null,
    },
  };
  // PR-B task 8 — optional secondary contact. Only present when the admin
  // clicked "+ Add a secondary contact" and filled it in — `secondary_contact`
  // is `undefined` on `values` otherwise (SecondaryContactSection clears the
  // whole sub-object on Remove, so a filled-then-removed contact never rides
  // along here).
  if (values.secondary_contact) {
    payload.secondary_contact = {
      first_name: values.secondary_contact.first_name.trim(),
      last_name: values.secondary_contact.last_name.trim(),
      email: values.secondary_contact.email.trim(),
      phone: values.secondary_contact.phone?.trim() || null,
      role_title: values.secondary_contact.role_title?.trim() || null,
      preferred_language: values.secondary_contact.preferred_language,
      // Task 8 (GDPR Art. 14) — the client zod schema already blocked submit
      // unless this was checked (schema.ts refine), so this is always `true`
      // here; forwarded so the server's own `z.literal(true)` gate (defense
      // in depth for a direct API call) sees it.
      art14_attested: values.secondary_contact.art14_attested,
    };
  }
  if (opts.confirmSoftDuplicate) payload.confirm_soft_duplicate = true;
  if (opts.overrideReason) {
    payload.override_reason_code = opts.overrideReason.code;
    payload.override_reason_note = opts.overrideReason.note;
  }
  return payload;
}

export function CreateMemberClient({ plans, defaultPlanYear }: Props) {
  const t = useTranslations('admin.members.create');
  const tOverride = useTranslations('admin.members.overrideReason');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [softDup, setSoftDup] = useState<SoftDupState | null>(null);
  const [override, setOverride] = useState<OverrideState | null>(null);
  const [serverFieldError, setServerFieldError] =
    useState<ResolvedServerFieldError | null>(null);
  const lastValuesRef = useRef<MemberFormValues | null>(null);
  const idemKeyRef = useRef<string>(uuid());

  const submit = async (
    payload: Record<string, unknown>,
  ): Promise<Response> => {
    return fetch('/api/members', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idemKeyRef.current,
      },
      body: JSON.stringify(payload),
    });
  };

  const handleCreated = (memberId: string) => {
    toast.success(t('success'));
    idemKeyRef.current = uuid();
    router.push(`/admin/members/${memberId}`);
  };

  const handleResponse = async (res: Response) => {
    if (res.status === 201) {
      const body = await res.json();
      handleCreated(body.member_id);
      return;
    }
    const body = await res.json().catch(() => ({}));
    // Bug-C fix: a failed attempt records this idempotency key against its
    // payload hash server-side, so the user's corrected retry would otherwise
    // keep returning `idempotency_conflict` (409) until a full page reload.
    // Refresh the key now so the next submit is a clean logical request. (The
    // soft-dup / override re-submit paths already mint their own key first.)
    idemKeyRef.current = uuid();
    if (res.status === 409 && body?.error?.code === 'soft_duplicate') {
      const details = body.error.details ?? {};
      setSoftDup({
        existing: {
          member_id: details.existingMemberId,
          company_name: details.existingCompanyName,
        },
      });
      return;
    }
    if (res.status === 422) {
      setOverride({
        message: formatOverrideWarning(body.error?.details, tOverride),
      });
      return;
    }
    // Field-attributable rejection (409 unique-email conflict, or 400 domain
    // validation: email format / Thai tax-id checksum / phone / country) — the
    // server names the field, so highlight + focus it and show its precise
    // message instead of the generic "fix the highlighted fields" toast that
    // marked nothing (UAT 2026-06-30).
    const fieldError = mapMemberCreateServerError(
      res.status,
      body?.error?.code,
      body?.error?.details?.type,
      body?.error?.details?.reason,
    );
    if (fieldError) {
      const message = t(fieldError.messageKey);
      setServerFieldError({ field: fieldError.field, message });
      toast.error(message);
      return;
    }
    // The selected plan was deactivated/deleted between page-load and submit —
    // retrying the same plan can never succeed, so say what to do.
    if (res.status === 404 && body?.error?.code === 'plan_not_found') {
      toast.error(t('errors.planUnavailable'));
      return;
    }
    // Idempotency reservation (Upstash) outage — surfaced as a retryable 503.
    if (res.status === 503) {
      toast.error(t('errors.serverBusy'));
      return;
    }
    if (res.status === 403) {
      toast.error(t('errors.forbidden'));
      return;
    }
    if (res.status === 400) {
      toast.error(t('errors.validation'));
      return;
    }
    toast.error(t('errors.generic'));
  };

  const onSubmit = async (values: MemberFormValues) => {
    lastValuesRef.current = values;
    setServerFieldError(null);
    setSubmitting(true);
    try {
      const res = await submit(toPayload(values));
      await handleResponse(res);
    } catch {
      // Network / unexpected failure (incl. a malformed 201 body whose
      // res.json() rejects) — without this the rejected promise surfaces no
      // user feedback. Matches edit-member-client's onSubmit.
      toast.error(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const onSoftDupProceed = async () => {
    if (!lastValuesRef.current) return;
    setSoftDup(null);
    setSubmitting(true);
    // Re-submit is a new logical request (different body — adds
    // confirm_soft_duplicate). Same key + different hash would collide
    // with the previous 409 response cached under this key and return
    // idempotency_conflict instead of the new outcome. Regenerate.
    idemKeyRef.current = uuid();
    try {
      const res = await submit(
        toPayload(lastValuesRef.current, { confirmSoftDuplicate: true }),
      );
      await handleResponse(res);
    } finally {
      setSubmitting(false);
    }
  };

  const onOverrideConfirm = async (result: OverrideReasonResult) => {
    if (!lastValuesRef.current) return;
    setOverride(null);
    setSubmitting(true);
    // Same rationale as onSoftDupProceed — new logical request payload.
    idemKeyRef.current = uuid();
    try {
      const res = await submit(
        toPayload(lastValuesRef.current, { overrideReason: result }),
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
        defaultPlanYear={defaultPlanYear}
        onSubmit={onSubmit}
        submitting={submitting}
        onCancel={() => router.push('/admin/members')}
        serverFieldError={serverFieldError}
      />

      <SoftDuplicateDialog
        open={softDup !== null}
        onOpenChange={(next) => {
          if (!next) setSoftDup(null);
        }}
        existing={softDup?.existing ?? null}
        onProceed={onSoftDupProceed}
      />

      <OverrideReasonDialog
        open={override !== null}
        onOpenChange={(next) => {
          if (!next) setOverride(null);
        }}
        warningMessage={override?.message ?? null}
        onConfirm={onOverrideConfirm}
      />
    </>
  );
}
