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
 * `role="status"` "withdrawn" message (the live region announces it) AND
 * refreshes the server tree, so /portal/edit's form + hint stop describing
 * a request that no longer exists (review round 1, UX C2); a 404 is read by
 * its BODY (PR-3 polish, silent S-4), and only the two codes the withdraw
 * ROUTE itself answers are silent: flat `no_pending_request` = decided or
 * withdrawn meanwhile (the "gone" message + the same refresh, so the profile
 * shows whatever landed), flat `not_found` = the platform flag turned off
 * between the render and the click (render nothing and refresh — the flag-off
 * page drops the banner anyway, and nothing failed). EVERY other 404 is the
 * error arm (PR-3 review A1): the NESTED `{ error: { code: 'not_found' } }`
 * that `requireMemberContext` answers for an unlinked member / contact, an
 * unparsable body, an unknown string. Those used to take the silent arm — the
 * banner disappeared, `router.refresh()` repainted it from the server, and the
 * person watched their click do nothing. A 503 (READ_ONLY_MODE) has
 * its own copy; any other failure stays inline in the same live region (no
 * toast — the banner IS the status surface). Focus after the dialog closes
 * goes through the shared `useDialogFinalFocus` (trigger, else the page
 * landmark — the shell's own rule, UX C3).
 */
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ClockIcon } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';
import { AuraAlert } from '@/components/shell/aura-markup';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { useDialogFinalFocus } from '@/components/shell/reason-confirmation-dialog';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { readProblemCode } from '@/lib/http/read-only-refusal';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { ChangeRequestDiffTable } from './change-request-diff-table';

export interface PendingRequestBannerProps {
  readonly request: ChangeRequestView;
  /** Show the "edit your request" link (hidden on the edit page itself). */
  readonly showEditLink?: boolean;
}

/** `hidden` — a 404 the server cannot explain (the flag-off race): render nothing, let the refresh decide. */
type WithdrawResult = 'withdrawn' | 'gone' | 'hidden' | null;
type WithdrawFailure = 'error' | 'read_only' | null;

export function PendingRequestBanner({ request, showEditLink = true }: PendingRequestBannerProps) {
  const t = useTranslations('portal.changeRequests.pending');
  const tw = useTranslations('portal.changeRequests.withdraw');
  const locale = useLocale();
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // set before the banner is replaced, so the dialog's close lands on the landmark
  const closedViaSuccessRef = useRef(false);
  const finalFocus = useDialogFinalFocus(triggerRef, undefined, closedViaSuccessRef);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<WithdrawResult>(null);
  const [failed, setFailed] = useState<WithdrawFailure>(null);
  const [busy, startTransition] = useTransition();
  const submittedAt = formatLocalisedDate(request.submittedAt, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  async function withdraw(): Promise<void> {
    setFailed(null);
    try {
      const res = await fetch('/api/portal/change-requests/current', { method: 'DELETE' });
      if (res.ok) {
        closedViaSuccessRef.current = true;
        setResult('withdrawn');
        startTransition(() => router.refresh());
        return;
      }
      if (res.status === 404) {
        // The body says WHICH 404 this is, and only the two the withdraw route
        // itself can answer are silent (PR-3 review A1):
        //   - flat `no_pending_request` → decided or withdrawn under us: say
        //     so, and let the refresh show what landed;
        //   - flat `not_found` → the route's own flag-off race: render
        //     nothing, the refreshed page drops the banner anyway.
        // Anything else — the NESTED `{ error: { code: 'not_found' } }`
        // `requireMemberContext` answers when the member / contact is not
        // linked under this user, an unparsable body, an unknown string —
        // falls through to the same handling as a 5xx. It used to land in the
        // silent arm: the banner vanished, `router.refresh()` repainted it
        // from the server, and the person saw their click do nothing.
        const body: unknown = await res.json().catch(() => null);
        const problem = readProblemCode(body);
        // FLAT is the discriminator, not the string: the route answers its own
        // codes flat, `requireMemberContext` answers `not_found` NESTED, and
        // the two spell it identically while meaning opposite things.
        if (problem?.shape === 'flat' && (problem.code === 'no_pending_request' || problem.code === 'not_found')) {
          closedViaSuccessRef.current = true;
          setResult(problem.code === 'no_pending_request' ? 'gone' : 'hidden');
          startTransition(() => router.refresh());
          return;
        }
        console.error('[pending-request-banner] withdraw: unexplained 404', { status: res.status, code: problem?.code ?? null });
        setFailed('error');
        return;
      }
      setFailed(res.status === 503 ? 'read_only' : 'error');
    } catch (e) {
      console.error('[pending-request-banner] withdraw failed', e);
      setFailed('error');
    }
  }

  if (result === 'hidden') return null;
  if (result !== null) {
    return (
      <AuraAlert tone={result === 'withdrawn' ? 'success' : 'info'} role="status" data-testid="withdraw-result">
        {result === 'withdrawn' ? tw('done') : tw('gone')}
      </AuraAlert>
    );
  }

  // AURA Alert markup (spec 122 US3): the helper, not AURA's `Alert`, because
  // the banner needs its own role, test id and clock icon — AURA's takes none.
  return (
    <AuraAlert
      tone="info"
      role="status"
      icon={ClockIcon}
      title={t('title')}
      data-testid="pending-request-banner"
      action={
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={triggerRef}
            type="button"
            variant="secondary"
            icon="rotate-ccw"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            data-testid="withdraw-request"
          >
            {tw('button')}
          </Button>
          {showEditLink ? (
            <Link
              href="/portal/edit"
              className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
            >
              {t('editLink')}
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        <p>{t('body', { submittedAt })}</p>
        <ChangeRequestDiffTable
          fields={request.fields}
          className="bg-[var(--aura-bg-surface)] text-[var(--aura-fg-primary)]"
        />
        {failed !== null ? (
          <p className="font-medium text-[var(--aura-fg-danger)]" data-testid="withdraw-error">
            {failed === 'read_only' ? tw('readOnly') : tw('error')}
          </p>
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
        finalFocus={finalFocus}
      />
    </AuraAlert>
  );
}
