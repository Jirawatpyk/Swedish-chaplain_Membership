/**
 * T058 — Invoice draft form (F4, Pattern C — spec-correct).
 *
 * Spec (US1 header): "Admin staff pick a member, CONFIRM the
 * membership tier and period, and the system generates a draft
 * invoice". "Confirm" — not "pick". The tier comes from the member's
 * F3 record, not an independent form field.
 *
 * UX:
 *  - Member picker is a cmdk-backed searchable combobox (scales to
 *    hundreds of members).
 *  - Plan + Plan-year are READ-ONLY and derived from the selected
 *    member's F3 record. To invoice for a different tier, admin MUST
 *    first go to `/admin/members/[id]/edit` and run the F3
 *    `changePlan` use case (which emits `member_plan_changed` audit
 *    with an override_reason). Keeping invoice issuance and plan
 *    change as separate flows preserves audit clarity and prevents
 *    admins from silently billing for a tier that doesn't match
 *    the member's subscription state.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { SearchableCombobox } from './searchable-combobox';
import type { ComboboxOption } from './searchable-combobox';

export type MemberOption = {
  readonly memberId: string;
  readonly label: string;
  readonly currentPlanId: string;
  readonly currentPlanYear: number;
};

export type PlanOption = {
  readonly planId: string;
  readonly label: string;
  readonly annualFeeMinorUnits: number;
};

function formatSatang(satang: number): string {
  const whole = Math.floor(satang / 100);
  const rem = satang % 100;
  // N11 — explicit 'en-US' pins thousand-separator output. FR-005.
  return `${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

export function CreateDraftForm({
  members,
  plans,
  initialMemberId,
}: {
  readonly members: readonly MemberOption[];
  readonly plans: readonly PlanOption[];
  /**
   * Pre-fill the member picker from a `?memberId=` deep-link (e.g.
   * "New invoice" CTA on the F3 member detail page). Falls back to
   * empty when missing / not in the active-members list (archived
   * members won't appear here — FR-037 rejects issue on archived).
   */
  readonly initialMemberId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.form');
  const tPicker = useTranslations('admin.invoices.form.memberPicker');
  const tPlan = useTranslations('admin.invoices.form.planInfo');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [memberId, setMemberId] = useState(() => {
    if (!initialMemberId) return '';
    return members.some((m) => m.memberId === initialMemberId)
      ? initialMemberId
      : '';
  });
  const selectedMember = members.find((m) => m.memberId === memberId);

  const memberOptions: ComboboxOption[] = useMemo(
    () => members.map((m) => ({ value: m.memberId, label: m.label })),
    [members],
  );

  // Derived from selected member — never a form state.
  const planId = selectedMember?.currentPlanId ?? '';
  const planYear = selectedMember?.currentPlanYear ?? new Date().getFullYear();
  const selectedPlan = plans.find((p) => p.planId === planId);

  const noMembers = members.length === 0;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!memberId || !planId) {
      toast.error(t('errors.create_failed'));
      return;
    }
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          plan_id: planId,
          plan_year: planYear,
          auto_email_on_issue: null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        toast.error(t('errors.create_failed'), {
          description: code
            ? t('errors.codeFallback', { code })
            : t('errors.unknown'),
        });
        return;
      }
      const data = (await res.json()) as { invoice_id: string };
      toast.success(t('success.created'));
      router.push(`/admin/invoices/${data.invoice_id}`);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <div>
        <Label htmlFor="memberId">{t('fields.memberId')}</Label>
        <SearchableCombobox
          id="memberId"
          options={memberOptions}
          value={memberId}
          onChange={setMemberId}
          placeholder={noMembers ? tPicker('noActiveMembers') : tPicker('placeholder')}
          searchPlaceholder={tPicker('search')}
          emptyMessage={tPicker('empty')}
          ariaLabel={t('fields.memberId')}
          disabled={noMembers}
        />
      </div>

      {selectedMember && (
        <div className="rounded-md border bg-muted/30 p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{t('fields.planId')}</div>
              <div className="text-base font-medium">
                {selectedPlan?.label ?? planId}
                <span className="ml-2 text-sm text-muted-foreground">/ {planYear}</span>
              </div>
              {selectedPlan && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {tPlan('annualFee', {
                    amount: formatSatang(selectedPlan.annualFeeMinorUnits),
                  })}
                </div>
              )}
            </div>
            <Link
              href={`/admin/members/${memberId}/edit`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {tPlan('changePlan')}
            </Link>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3">
        <Button type="submit" disabled={pending || noMembers || !memberId || !selectedPlan}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
