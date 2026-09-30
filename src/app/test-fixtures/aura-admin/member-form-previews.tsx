'use client';

/**
 * Spec 122 US5b-2 (T580) — the member form's dialogs opened over the preview
 * edit form, for board screenshots (`Admin-member-plan-change`; the other three
 * have no board). Client-only: the dialogs take handlers, which a server page
 * cannot pass. Nothing here reaches the API. Every value is invented.
 */
import { useState } from 'react';
import { PlanChangeConfirmDialog } from '@/components/members/plan-change-confirm-dialog';
import { BundleChangeWarningDialog } from '@/components/members/bundle-change-warning-dialog';
import { OverrideReasonDialog } from '@/components/members/override-reason-dialog';
import { SoftDuplicateDialog } from '@/components/members/soft-duplicate-dialog';

export function MemberFormDialogPreview({ dialog }: { readonly dialog: string }) {
  const [open, setOpen] = useState(true);
  const noop = () => undefined;
  if (dialog === 'plan-change') {
    return (
      <PlanChangeConfirmDialog
        open={open}
        onOpenChange={setOpen}
        submitting={false}
        onConfirm={noop}
        summary={{
          oldPlanId: 'large',
          oldPlanYear: 2026,
          newPlanId: 'premium',
          newPlanYear: 2026,
          oldPlanLabel: 'Large Corporate — 2026',
          newPlanLabel: 'Premium Corporate — 2026',
          oldFeeMinorUnits: 2_600_000,
          newFeeMinorUnits: 3_600_000,
          currencyCode: 'THB',
          yearOnly: false,
        }}
      />
    );
  }
  if (dialog === 'bundle') {
    return (
      <BundleChangeWarningDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={noop}
        payload={{
          oldBundleCorporatePlanId: 'large',
          newBundleCorporatePlanId: 'premium',
          oldBundleLabel: 'Large Corporate — 2026',
          newBundleLabel: 'Premium Corporate — 2026',
          oldPlanId: 'diamond',
          oldPlanYear: 2026,
        }}
      />
    );
  }
  if (dialog === 'override') {
    return (
      <OverrideReasonDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={noop}
        warningMessage="Turnover 180,000,000 THB is above the plan maximum of 100,000,000 THB."
      />
    );
  }
  if (dialog === 'duplicate') {
    return (
      <SoftDuplicateDialog
        open={open}
        onOpenChange={setOpen}
        onProceed={noop}
        existing={{ member_id: '00000000-0000-4000-8000-000000000003', company_name: 'Siam Nordic Trading Co., Ltd.' }}
      />
    );
  }
  return null;
}
