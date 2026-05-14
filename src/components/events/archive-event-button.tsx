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
import { Button, buttonVariants } from '@/components/ui/button';
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
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={pending}
            type="button"
            aria-busy={pending}
          />
        }
      >
        <Archive aria-hidden="true" data-icon="inline-start" />
        <span>{t('archiveCta')}</span>
        {pending && (
          <Loader2
            aria-hidden="true"
            className="size-3 animate-spin"
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
          {/* CRIT-3 fix (wave-5): destructive variant on the
              confirmation button. Archive is irreversible
              (no in-product un-archive in v1) — visual hierarchy
              must communicate severity. Mirrors the F3
              `archive-member-button.tsx:132` precedent. */}
          <AlertDialogAction
            onClick={handleConfirm}
            className={buttonVariants({ variant: 'destructive' })}
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
