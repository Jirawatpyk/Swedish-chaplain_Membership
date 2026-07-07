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
 *   2. "Erase all N" — an AlertDialog (mandatory reason textarea, mirroring the
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
import { Eraser, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

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
  // matchCount to 0 → the whole AlertDialog (trigger included) unmounts, so Base
  // UI cannot restore focus to the trigger and focus would fall to <body>.
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

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={handleSearch}
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
          <Label htmlFor="erase-by-email-input">{t('searchLabel')}</Label>
          <Input
            id="erase-by-email-input"
            ref={searchInputRef}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={queryEmail}
            onChange={(e) => setQueryEmail(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="min-h-11"
          />
        </div>
        <Button type="submit" variant="outline" className="min-h-11">
          <Search aria-hidden="true" data-icon="inline-start" />
          {t('searchSubmit')}
        </Button>
      </form>

      {canEraseAll ? (
        <div className="flex justify-end">
          <AlertDialog
            open={open}
            onOpenChange={(next) => {
              if (pending) return;
              setOpen(next);
              if (!next) setReasonText('');
            }}
          >
            <span role="status" aria-live="polite" className="sr-only">
              {pending ? t('loading') : ''}
            </span>
            <AlertDialogTrigger
              render={
                <Button
                  variant="destructive-outline"
                  size="sm"
                  aria-disabled={pending}
                  type="button"
                  className="min-h-11"
                  data-testid="erase-all-by-email-button"
                />
              }
            >
              <Eraser aria-hidden="true" data-icon="inline-start" />
              <span>{t('eraseAllCta', { count: matchCount })}</span>
              {pending && (
                <Loader2
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-end"
                />
              )}
            </AlertDialogTrigger>
            <AlertDialogContent finalFocus={searchInputRef}>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('eraseAllConfirmTitle', { count: matchCount })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('eraseAllConfirmBody', { count: matchCount })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="mt-2 flex flex-col gap-2">
                <Label htmlFor="erase-by-email-reason">{t('reasonLabel')}</Label>
                <Textarea
                  id="erase-by-email-reason"
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  placeholder={t('reasonPlaceholder')}
                  maxLength={500}
                  rows={4}
                  disabled={pending}
                  aria-invalid={!reasonValid && reasonText.length > 0}
                  aria-describedby="erase-by-email-reason-hint"
                />
                <p
                  id="erase-by-email-reason-hint"
                  className="text-caption text-muted-foreground"
                >
                  {t('reasonHint', { remaining: 500 - reasonText.length })}
                </p>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel autoFocus>{t('cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleEraseAll}
                  disabled={pending || !reasonValid}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
                >
                  {t('confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
    </div>
  );
}
