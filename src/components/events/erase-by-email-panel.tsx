/**
 * Erase-by-email panel (F6 remediation PR 2.2 / P4 / FR-032a).
 *
 * Client island rendered ABOVE the server-rendered results table on the
 * `/admin/events/erasure` page. Owns two interactions:
 *
 *   1. Search — an email input that pushes `?email=<normalised>` so the server
 *      component re-runs `runSearchAttendeesByEmail`. The email is normalised
 *      `.trim().toLowerCase()` client-side too (carry-forward #4) so the URL,
 *      the input echo, and the backend key all agree.
 *
 *   2. "Erase all N" — an AURA alertdialog (spec 122 US9b-1 T924; mandatory
 *      reason, no typed phrase), mirroring the
 *      per-registration `ErasePiiDialog` a11y pattern) that POSTs the bulk route
 *      `/api/admin/events/erasure`, then surfaces the tally toast. Carry-forward
 *      #3: when the backend reports `truncated` OR `failedCount > 0`, the toast
 *      is a WARNING with an explicit re-run prompt (there is NO reconciler —
 *      completeness depends on the admin re-driving the sweep). `router.refresh()`
 *      re-runs the server search so the table (and count) reflect the erasure.
 *
 * Only the per-row erase reuses the SHIPPED `ErasePiiDialog` (zero new per-row
 * erase code); this panel adds the bulk "erase all matches" affordance.
 */
'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eraser } from 'lucide-react';
import { Button, Dialog, TextField, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';

interface EraseByEmailResponse {
  readonly erasedCount: number;
  readonly alreadyErasedCount: number;
  readonly failedCount: number;
  readonly truncated: boolean;
}

interface EraseByEmailPanelProps {
  /** The NORMALISED email currently being searched (`''` when none). */
  readonly email: string;
  /** Number of matching registrations rendered below (0 when none / empty). */
  readonly matchCount: number;
}

const ERASE_ROUTE = '/api/admin/events/erasure';

async function postEraseAll(
  email: string,
  reasonText: string,
): Promise<
  | { ok: true; data: EraseByEmailResponse }
  | { ok: false; status: number }
> {
  const res = await fetch(ERASE_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, reasonText }),
  });
  if (res.ok) {
    const data = (await res.json()) as EraseByEmailResponse;
    return { ok: true, data };
  }
  return { ok: false, status: res.status };
}

export function EraseByEmailPanel({ email, matchCount }: EraseByEmailPanelProps) {
  const t = useTranslations('admin.events.erasure');
  const router = useRouter();
  const [queryEmail, setQueryEmail] = useState(email);
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reasonText, setReasonText] = useState('');
  // WCAG 2.4.3 — after a successful "Erase all", router.refresh() drops
  // matchCount to 0 → the whole dialog (trigger included) unmounts, so focus
  // cannot return to the trigger and would fall to <body>.
  // finalFocus targets the ALWAYS-MOUNTED search input instead so focus lands on
  // a predictable, still-present element (F7-A11Y-1 finalFocus pattern).
  const searchInputRef = useRef<HTMLInputElement>(null);

  const reasonValid = reasonText.trim().length > 0 && reasonText.length <= 500;
  const canEraseAll = email.length > 0 && matchCount > 0;

  function handleSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // carry-forward #4 — normalise client-side so the URL, the echoed input,
    // and the backend enumeration key all agree.
    const normalised = queryEmail.trim().toLowerCase();
    if (normalised.length === 0) {
      router.push('/admin/events/erasure');
      return;
    }
    router.push(`/admin/events/erasure?email=${encodeURIComponent(normalised)}`);
  }

  function handleEraseAll() {
    if (!reasonValid || !canEraseAll) return;
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof postEraseAll>>;
      try {
        result = await postEraseAll(email, reasonText.trim());
      } catch {
        setOpen(false);
        setReasonText('');
        toast.error(t('errorTitle'), { description: t('errorDescription') });
        return;
      }
      setOpen(false);
      setReasonText('');
      if (!result.ok) {
        toast.error(t('errorTitle'), { description: t('errorDescription') });
        return;
      }
      const { erasedCount, alreadyErasedCount, failedCount, truncated } =
        result.data;
      const summary = t('successSummary', {
        erased: erasedCount,
        alreadyErased: alreadyErasedCount,
        failed: failedCount,
      });
      // carry-forward #3 — a capped (truncated) or partially-failed pass is
      // INCOMPLETE: surface it as a warning with an explicit re-run prompt.
      if (truncated || failedCount > 0) {
        const reRun = truncated
          ? t('truncatedToast')
          : t('failedToast', { failed: failedCount });
        toast.warning(t('partialTitle'), {
          description: `${summary} ${reRun}`,
        });
      } else {
        toast.success(t('successTitle'), { description: summary });
      }
      router.refresh();
    });
  }

  function close() {
    // Never close while the POST is in flight (Cancel, Escape, the scrim).
    if (pending) return;
    setOpen(false);
    setReasonText('');
  }

  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]">
      <form
        onSubmit={handleSearch}
        role="search"
        className="flex flex-wrap items-end gap-[var(--aura-space-3)]"
      >
        <div className="min-w-[16rem] flex-1">
          <TextField
            id="erase-by-email-input"
            ref={searchInputRef}
            label={t('searchLabel')}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={queryEmail}
            onChange={(e) => setQueryEmail(e.target.value)}
            placeholder={t('searchPlaceholder')}
            touchHeight
          />
        </div>
        <Button type="submit" variant="secondary" icon="search" touchHeight>
          {t('searchSubmit')}
        </Button>
      </form>

      {canEraseAll ? (
        <div className="flex justify-end">
          <span role="status" aria-live="polite" className="sr-only">
            {pending ? t('loading') : ''}
          </span>
          <Dialog
            role="alertdialog"
            open={open}
            onOpen={() => setOpen(true)}
            onClose={close}
            dismissible={!pending}
            finalFocus={searchInputRef}
            trigger={
              <Button
                variant="danger-secondary"
                touchHeight
                type="button"
                icon={<Eraser aria-hidden="true" />}
                loading={pending}
                aria-disabled={pending}
                data-testid="erase-all-by-email-button"
              >
                {t('eraseAllCta', { count: matchCount })}
              </Button>
            }
            title={t('eraseAllConfirmTitle', { count: matchCount })}
            description={t('eraseAllConfirmBody', { count: matchCount })}
            footer={
              <>
                <Button variant="secondary" data-autofocus disabled={pending} onClick={close}>
                  {t('cancel')}
                </Button>
                {/* Reachable but refused until the reason is valid (AURA #102). */}
                <Button
                  variant="danger"
                  icon={<Eraser aria-hidden="true" />}
                  loading={pending}
                  aria-disabled={!reasonValid || undefined}
                  aria-describedby={reasonValid ? undefined : 'erase-by-email-reason-hint'}
                  onClick={handleEraseAll}
                >
                  {t('confirm')}
                </Button>
              </>
            }
          >
            <Textarea
              id="erase-by-email-reason"
              label={t('reasonLabel')}
              hint={<span id="erase-by-email-reason-hint">{t('reasonHint', { remaining: 500 - reasonText.length })}</span>}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              maxLength={500}
              rows={4}
              disabled={pending}
            />
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
