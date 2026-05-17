/**
 * Erase attendee PII dialog (F6 Phase 10 T112 / FR-032a).
 *
 * Admin-only destructive action rendered inside the event-detail
 * attendee-table actions column. Hidden when the row is already
 * pseudonymised (which can never be erased — retention purge already
 * removed the PII, and re-erasure is a no-op idempotent path that
 * doesn't need a UI surface).
 *
 * Behaviour:
 *   - AlertDialog confirmation with the FR-032a body explaining what
 *     erasure means: PII removed permanently, quota credit-backed,
 *     audit trail retained for compliance.
 *   - Required reasonText textarea (1-500 chars) for DPO traceability.
 *   - Confirm → POST /api/admin/events/{eventId}/registrations/{rid}/erase
 *     with { reasonText }.
 *   - Success → toast with quota credit-back counts + router.refresh().
 *   - 409 event_path_mismatch → error toast (likely race / stale UI).
 *   - 200 alreadyErased=true → info toast ("Already erased").
 *
 * Mirrors `archive-event-button.tsx` for AlertDialog patterns + WCAG
 * 2.1 AA focus management (Cancel autoFocus, in-flight focus trap via
 * setOpen guard, sr-only role=status live region for SR pending cue).
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eraser, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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

interface EraseResponse {
  readonly alreadyErased: boolean;
  readonly quotaReversals: {
    readonly partnership: number;
    readonly cultural: number;
  };
}

interface ErasePiiDialogProps {
  readonly eventId: string;
  readonly registrationId: string;
  /** Attendee name for context in the confirmation body. */
  readonly attendeeName: string;
}

async function postErase(
  eventId: string,
  registrationId: string,
  reasonText: string,
): Promise<
  | { ok: true; data: EraseResponse }
  | { ok: false; status: number; title?: string; detail?: string }
> {
  const res = await fetch(
    `/api/admin/events/${eventId}/registrations/${registrationId}/erase`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasonText }),
    },
  );
  if (res.ok) {
    const data = (await res.json()) as EraseResponse;
    return { ok: true, data };
  }
  let body: { title?: string; detail?: string } = {};
  try {
    body = (await res.json()) as { title?: string; detail?: string };
  } catch {
    // empty body
  }
  return { ok: false, status: res.status, ...body };
}

export function ErasePiiDialog({
  eventId,
  registrationId,
  attendeeName,
}: ErasePiiDialogProps) {
  const t = useTranslations('admin.events.detail.erase');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reasonText, setReasonText] = useState('');

  const reasonValid = reasonText.trim().length > 0 && reasonText.length <= 500;

  function handleConfirm() {
    if (!reasonValid) return;
    startTransition(async () => {
      const result = await postErase(eventId, registrationId, reasonText.trim());
      setOpen(false);
      setReasonText('');
      if (result.ok) {
        if (result.data.alreadyErased) {
          toast.info(t('alreadyErasedTitle'), {
            description: t('alreadyErasedDescription'),
          });
        } else {
          toast.success(t('successTitle'), {
            description: t('successDescription', {
              partnership: result.data.quotaReversals.partnership,
              cultural: result.data.quotaReversals.cultural,
            }),
          });
        }
        router.refresh();
      } else if (result.status === 409) {
        toast.error(t('pathMismatchTitle'), {
          description: t('pathMismatchDescription'),
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
        if (pending) return;
        setOpen(next);
        if (!next) {
          setReasonText('');
        }
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
            aria-label={t('triggerAriaLabel', { attendeeName })}
            type="button"
            data-testid={`erase-pii-button-${registrationId}`}
          />
        }
      >
        <Eraser aria-hidden="true" data-icon="inline-start" />
        <span>{t('triggerCta')}</span>
        {pending && (
          <Loader2
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
            data-icon="inline-end"
          />
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('confirmBody', { attendeeName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-2 flex flex-col gap-2">
          <Label htmlFor={`erase-reason-${registrationId}`}>
            {t('reasonLabel')}
          </Label>
          <Textarea
            id={`erase-reason-${registrationId}`}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            maxLength={500}
            rows={4}
            disabled={pending}
            aria-invalid={!reasonValid && reasonText.length > 0}
            aria-describedby={`erase-reason-hint-${registrationId}`}
          />
          <p
            id={`erase-reason-hint-${registrationId}`}
            className="text-caption text-muted-foreground"
          >
            {t('reasonHint', { remaining: 500 - reasonText.length })}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending || !reasonValid}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
          >
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
