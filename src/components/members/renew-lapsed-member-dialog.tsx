/**
 * F8-completion Slice 3 · Task 3.2 — `RenewLapsedMemberDialog`.
 *
 * Admin-only "Renew / reactivate this member" confirmation dialog,
 * surfaced on the admin member-detail Renewal & Health card for a LAPSED
 * member (no active cycle — status `lapsed | cancelled | null`). On
 * confirm it POSTs to `/api/admin/members/[id]/renew` which creates a
 * fresh `awaiting_payment` renewal cycle + issues a §86/4 renewal invoice
 * the member then pays.
 *
 * Mirrors `outreach-dialog.tsx`'s fetch + toast + `router.refresh()`
 * pattern. Explicit copy ("this creates a renewal invoice for the member
 * to pay"). `role="alertdialog"` + focus-on-Cancel per ux-standards § 4
 * (a side-effecting confirmation).
 *
 * RBAC: the trigger is rendered ONLY for admins by the parent card
 * (managers never see the affordance — no broken button); the route
 * enforces admin-only server-side regardless.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useSupersedeWarningToast } from '@/components/invoices/use-supersede-warning-toast';

export interface RenewLapsedMemberDialogProps {
  readonly memberId: string;
}

export function RenewLapsedMemberDialog({
  memberId,
}: RenewLapsedMemberDialogProps): React.ReactElement {
  const t = useTranslations('admin.members.detail.renewLapsed');
  const router = useRouter();
  const showSupersedeWarning = useSupersedeWarningToast();
  const [open, setOpen] = useState(false);

  // ConfirmationDialog shows the busy state, blocks a second click and starts
  // on Cancel; it closes only on success (a refusal keeps it open).
  const onConfirm = async (): Promise<void> => {
    try {
      const res = await fetch(
        `/api/admin/members/${encodeURIComponent(memberId)}/renew`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Confirmation-only body. The §86/4's price AND plan_year are
          // BOTH server-derived (L2, 068 security review) — the client
          // does not (and must not) influence a tax document's amount or
          // fiscal year.
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        let code = 'server_error';
        try {
          const errBody = (await res.json()) as { error?: { code?: string } };
          code = errBody.error?.code ?? code;
        } catch {
          /* ignore */
        }
        // 068 cluster D — next-intl's 2nd `t()` arg is interpolation VALUES,
        // not options; there is NO `fallback` option. A route code without a
        // `toast.error.*` key (rate_limited / invalid_body / invalid_input)
        // previously rendered the raw dotted key path + logged
        // MISSING_MESSAGE. Use `t.has(...)` to resolve a known code and fall
        // back to `server_error` for any unknown future code — cleanly, with
        // no MISSING_MESSAGE.
        const key = `toast.error.${code}`;
        toast.error(t('toast.failure'), {
          description: t.has(key) ? t(key) : t('toast.error.server_error'),
        });
        return;
      }
      toast.success(t('toast.success'));
      // 106-void-on-reissue follow-up — the reactivation bill was issued,
      // but the member's older unpaid bill may not have been auto-voided.
      showSupersedeWarning(await res.json().catch(() => null));
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(t('toast.failure'));
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        {t('trigger')}
      </Button>
      <ConfirmationDialog
        open={open}
        onOpenChange={setOpen}
        title={t('title')}
        description={t('description')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        closeOnConfirm={false}
        onConfirm={onConfirm}
      />
    </>
  );
}
