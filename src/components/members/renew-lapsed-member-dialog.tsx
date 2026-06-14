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
 * Mirrors `outreach-dialog.tsx`'s fetch + sonner toast + `router.refresh()`
 * pattern. Explicit copy ("this creates a renewal invoice for the member
 * to pay"). `role="alertdialog"` + focus-on-Cancel per ux-standards § 4
 * (a side-effecting confirmation).
 *
 * RBAC: the trigger is rendered ONLY for admins by the parent card
 * (managers never see the affordance — no broken button); the route
 * enforces admin-only server-side regardless.
 */
'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface RenewLapsedMemberDialogProps {
  readonly memberId: string;
}

export function RenewLapsedMemberDialog({
  memberId,
}: RenewLapsedMemberDialogProps): React.ReactElement {
  const t = useTranslations('admin.members.detail.renewLapsed');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const onConfirm = () => {
    startTransition(async () => {
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
        setOpen(false);
        router.refresh();
      } catch {
        toast.error(t('toast.failure'));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        {t('trigger')}
      </DialogTrigger>
      <DialogContent initialFocus={cancelRef} role="alertdialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? t('submitting') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
