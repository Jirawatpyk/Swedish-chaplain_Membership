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
import { Archive } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

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
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  // CRIT-5 (wave-5): the shared dialog stays OPEN while the POST is in
  // flight (focus trapped inside, Confirm busy, so no duplicate archive or
  // audit row) and closes once this resolves, in every branch.
  async function handleConfirm(): Promise<void> {
    setPending(true);
    let result: Awaited<ReturnType<typeof postArchive>>;
    try {
      result = await postArchive(eventId);
    } catch {
      // A thrown POST (offline, DNS) gets the generic error toast; pending
      // always clears, or the dialog — which refuses to close while pending —
      // would be stuck open (US9a review, WCAG 2.1.2).
      toast.error(t('errorTitle'), { description: t('errorDescription') });
      return;
    } finally {
      setPending(false);
    }
    if (result.ok) {
      toast.success(t('successTitle'), {
        description: t('successDescription', { count: result.data.registrationsAffected }),
      });
      startTransition(() => router.refresh());
    } else if (result.status === 409) {
      toast.info(t('alreadyArchivedTitle'), { description: t('alreadyArchivedDescription') });
      startTransition(() => router.refresh());
    } else {
      toast.error(t('errorTitle'), {
        description: (typeof result.title === 'string' && result.title) || t('errorDescription'),
      });
    }
  }

  return (
    <>
      {/* NEW-I3 fix (wave-6): SR loading announcement. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? t('loading') : ''}
      </span>
      {/* Archive is irreversible in v1: a danger button, and Cancel takes the
          dialog's first focus (ux-standards § 6.2, CRIT-3). */}
      <Button
        type="button"
        variant="danger-secondary"
        icon={<Archive aria-hidden />}
        touchHeight
        loading={pending}
        // NEW-I1 (wave-6): the trigger stays focusable during a POST.
        onClick={() => !pending && setOpen(true)}
      >
        {t('archiveCta')}
      </Button>
      <ConfirmationDialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
        }}
        title={t('confirmTitle')}
        description={t('confirmBody')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        destructive
        onConfirm={handleConfirm}
      />
    </>
  );
}
