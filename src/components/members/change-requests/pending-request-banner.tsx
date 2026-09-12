'use client';

/**
 * F114 — "Pending review" banner (US1 AS1, FR-010; T042) with the withdraw
 * control (US5 AS1, FR-009; T089). Rendered on /portal/profile and
 * /portal/edit while the caller's OWN request is pending. `role="status"` so
 * the state is announced without stealing focus; the submission time goes
 * through `formatLocalisedDate` (BE display-only for th-TH); the proposed vs
 * current values reuse the shared diff table.
 *
 * Withdraw: "Withdraw request" opens the shared `ConfirmationDialog` in the
 * NON-destructive tier (nothing was applied, so nothing is destroyed — the
 * request simply stops being reviewed; ux-standards § 6), focus on Cancel,
 * `finalFocus` back to the trigger. Confirm calls
 * `DELETE /api/portal/change-requests/current`; a 200 swaps the banner for a
 * `role="status"` "withdrawn" message (the live region announces it; the
 * server state catches up on the next navigation); a 404 means the request
 * was decided or withdrawn meanwhile — the "gone" message + a server refresh
 * so the profile shows whatever landed; a failure stays inline in the same
 * live region (no toast — the banner IS the status surface).
 */
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ClockIcon, Undo2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineAlert } from '@/components/ui/inline-alert';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface PendingRequestBannerProps {
  readonly request: ChangeRequestView;
  /** Show the "edit your request" link (hidden on the edit page itself). */
  readonly showEditLink?: boolean;
}

type WithdrawResult = 'withdrawn' | 'gone' | null;

export function PendingRequestBanner({ request, showEditLink = true }: PendingRequestBannerProps) {
  const t = useTranslations('portal.changeRequests.pending');
  const tw = useTranslations('portal.changeRequests.withdraw');
  const locale = useLocale();
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<WithdrawResult>(null);
  const [failed, setFailed] = useState(false);
  const [busy, startTransition] = useTransition();
  const submittedAt = formatLocalisedDate(request.submittedAt, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  async function withdraw(): Promise<void> {
    setFailed(false);
    try {
      const res = await fetch('/api/portal/change-requests/current', { method: 'DELETE' });
      if (res.ok) {
        setResult('withdrawn');
        return;
      }
      if (res.status === 404) {
        // decided or withdrawn under us — let the server say what landed
        setResult('gone');
        startTransition(() => router.refresh());
        return;
      }
      setFailed(true);
    } catch (e) {
      console.error('[pending-request-banner] withdraw failed', e);
      setFailed(true);
    }
  }

  if (result !== null) {
    return (
      <InlineAlert tone={result === 'withdrawn' ? 'success' : 'info'} role="status" data-testid="withdraw-result">
        <p className="text-sm">{result === 'withdrawn' ? tw('done') : tw('gone')}</p>
      </InlineAlert>
    );
  }

  return (
    <InlineAlert tone="info" role="status" className="space-y-3" data-testid="pending-request-banner">
      <div className="flex items-start gap-2">
        <ClockIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">{t('title')}</p>
          <p className="text-sm">{t('body', { submittedAt })}</p>
        </div>
      </div>
      <ChangeRequestDiffTable fields={request.fields} className="bg-background text-foreground" />
      {failed ? (
        <p className="text-sm font-medium text-destructive" data-testid="withdraw-error">
          {tw('error')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
          data-testid="withdraw-request"
        >
          <Undo2Icon className="mr-1 h-4 w-4" aria-hidden="true" />
          {tw('button')}
        </Button>
        {showEditLink ? (
          <Link href="/portal/edit" className="text-sm text-primary underline-offset-4 hover:underline">
            {t('editLink')}
          </Link>
        ) : null}
      </div>
      <ConfirmationDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tw('title')}
        description={tw('description')}
        confirmLabel={tw('confirm')}
        cancelLabel={tw('cancel')}
        onConfirm={withdraw}
        // the trigger survives every close path except a successful withdraw,
        // where the whole banner is replaced — land on the page landmark then
        finalFocus={() => triggerRef.current ?? document.getElementById('main-content')}
      />
    </InlineAlert>
  );
}
