/**
 * Archive event button (F6 Phase 6 wave-4 / FR-019a).
 *
 * Admin-only destructive action rendered alongside the category-toggle
 * buttons in the event-detail header. Hidden when the event is
 * already archived.
 *
 * Behaviour:
 *   - AlertDialog confirmation with the FR-019a quota-impact body
 *     ("All counted partnership + cultural tickets will be credited
 *      back to their members. Archived events are quota-neutral for
 *      future webhook deliveries.")
 *   - Confirm → POST `/api/admin/events/{eventId}/archive` with empty
 *     body
 *   - Success → toast with `registrationsAffected` count +
 *     `router.refresh()` so the header re-renders with the Archived
 *     badge AND the toggle buttons disappear
 *   - 409 already_archived → toast info (race against another admin)
 *   - Other error → generic error toast
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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

interface ArchiveResponse {
  readonly registrationsAffected: number;
  readonly quotaReversals: {
    readonly partnership: number;
    readonly cultural: number;
  };
}

interface ArchiveEventButtonProps {
  readonly eventId: string;
}

async function postArchive(
  eventId: string,
): Promise<
  | { ok: true; data: ArchiveResponse }
  | { ok: false; status: number; title?: string }
> {
  const res = await fetch(`/api/admin/events/${eventId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.ok) {
    const data = (await res.json()) as ArchiveResponse;
    return { ok: true, data };
  }
  let body: { title?: string } = {};
  try {
    body = (await res.json()) as { title?: string };
  } catch {
    // No JSON body
  }
  return { ok: false, status: res.status, ...body };
}

export function ArchiveEventButton({ eventId }: ArchiveEventButtonProps) {
  const t = useTranslations('admin.events.detail.archive');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // CRIT-5 fix (wave-5): keep the dialog OPEN while the POST is
  // in-flight so focus stays trapped inside the dialog AlertDialog
  // (focus restoration to a `disabled` trigger button is undefined-
  // behavior across Base UI / Radix). The dialog closes via the
  // `setOpen(false)` call AFTER the request resolves (in either
  // success / 409 / error branch). The trigger button itself is
  // disabled (pending=true) so a second user-click cannot re-open
  // the dialog while one POST is mid-flight.
  function handleConfirm() {
    startTransition(async () => {
      const result = await postArchive(eventId);
      setOpen(false);
      if (result.ok) {
        toast.success(t('successTitle'), {
          description: t('successDescription', {
            count: result.data.registrationsAffected,
          }),
        });
        router.refresh();
      } else if (result.status === 409) {
        toast.info(t('alreadyArchivedTitle'), {
          description: t('alreadyArchivedDescription'),
        });
        router.refresh();
      } else {
        toast.error(t('errorTitle'), {
          description:
            (typeof result.title === 'string' && result.title) ||
            t('errorDescription'),
        });
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // NEW-I1 fix (wave-6): guard re-open during in-flight POST
        // here instead of disabling the trigger button. Keeps the
        // trigger focusable so focus-return after dialog close
        // (during pending) doesn't fall through to document.body
        // (WCAG 2.4.3 violation under disabled-trigger fallback).
        if (pending) return;
        setOpen(next);
      }}
    >
      {/* NEW-I3 fix (wave-6): SR loading announcement via sr-only
          role="status" aria-live. `aria-busy` on a `disabled` button
          is an ARIA antipattern — JAWS/NVDA skip the announcement on
          inert elements. A dedicated live region gives SR users a
          coherent "processing …" cue. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? t('loading') : ''}
      </span>
      <AlertDialogTrigger
        render={
          <Button
            variant="destructive-outline"
            aria-disabled={pending}
            type="button"
          />
        }
      >
        <Archive aria-hidden="true" data-icon="inline-start" />
        <span>{t('archiveCta')}</span>
        {pending && (
          <Loader2
            aria-hidden="true"
            className="animate-spin"
            data-icon="inline-end"
          />
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* CRIT-3 fix (wave-5): Cancel autoFocus per ux-standards
              §6.2 — focus starts on the safe action so an
              accidental Enter does not archive. */}
          <AlertDialogCancel autoFocus>{t('cancel')}</AlertDialogCancel>
          {/* CRIT-3 fix (wave-5) + NEW-C1 fix (wave-6): solid
              destructive bg + foreground tokens for ~12:1 contrast
              in BOTH light and dark mode. The tonal `text-destructive`
              variant (oklch coral on muted bg) measured ~4.0:1 in
              dark mode — below WCAG AA 4.5:1 for normal text.
              Archive is irreversible (no in-product un-archive in
              v1) so visual hierarchy MUST clearly communicate
              severity. The solid red bg + white text is the
              project-standard destructive treatment.
              **NEW-C2 fix (wave-6)**: `disabled={pending}` prevents
              double-click race that would POST duplicate archive
              requests → duplicate audit log rows for one user
              action. */}
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
