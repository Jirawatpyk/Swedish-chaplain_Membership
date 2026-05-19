/**
 * Event category toggle buttons (F6 Phase 6 T088).
 *
 * Admin-only client component rendered inside the event-detail header
 * when the viewer is an admin (managers see read-only flags only,
 * matches FR-035 surface-level access matrix).
 *
 * Behaviour:
 *   - Two buttons: "Toggle Partner Benefit" + "Toggle Cultural Event"
 *   - Click → opens `AlertDialog` confirming the destructive impact
 *     (quota re-evaluation across all matched paid registrations)
 *   - Confirm → POST to /api/admin/events/{eventId}/toggle-{flag}
 *     with `{ newValue: !currentValue }`
 *   - Success → toast with `registrationsReevaluated` count + router
 *     refresh so the header re-renders with the new flag state
 *   - 409 archived → distinct toast
 *   - Other error → generic error toast
 *
 * Buttons are disabled while the request is in-flight to prevent
 * double-submission.
 */
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Award, Sparkles, Loader2 } from 'lucide-react';
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

interface ToggleResponse {
  readonly registrationsReevaluated: number;
  readonly previousValue: boolean;
  readonly nextValue: boolean;
}

interface EventCategoryTogglesProps {
  readonly eventId: string;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
  /** Disable both toggles when the event is archived. */
  readonly disabled?: boolean;
}

async function postToggle(
  eventId: string,
  endpoint: 'toggle-partner-benefit' | 'toggle-cultural-event',
  newValue: boolean,
): Promise<
  | { ok: true; data: ToggleResponse }
  | { ok: false; status: number; title?: string; detail?: unknown }
> {
  const res = await fetch(`/api/admin/events/${eventId}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newValue }),
  });
  if (res.ok) {
    const data = (await res.json()) as ToggleResponse;
    return { ok: true, data };
  }
  let body: { title?: string; detail?: unknown } = {};
  try {
    body = (await res.json()) as { title?: string; detail?: unknown };
  } catch {
    // No JSON body
  }
  return { ok: false, status: res.status, ...body };
}

export function EventCategoryToggles({
  eventId,
  isPartnerBenefit,
  isCulturalEvent,
  disabled = false,
}: EventCategoryTogglesProps) {
  const t = useTranslations('admin.events.detail.toggles');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openDialog, setOpenDialog] = useState<
    'partner_benefit' | 'cultural_event' | null
  >(null);
  // CRIT-4 fix (wave-5): per-flag spinner state so Loader2 renders
  // ONLY on the button being processed. Previously the shared
  // `pending` from `useTransition` ran both spinners simultaneously
  // even though only one POST was in flight (WCAG 4.1.3 Status
  // Messages violation — SR announced "busy" on the inactive flag).
  // `disabled={disabled || pending}` stays unified so both buttons
  // are click-locked during ANY mid-flight POST (prevents double-
  // submit across flags).
  const [activeFlag, setActiveFlag] = useState<
    'partner_benefit' | 'cultural_event' | null
  >(null);

  function handleConfirm(
    flag: 'partner_benefit' | 'cultural_event',
    nextValue: boolean,
  ) {
    setActiveFlag(flag);
    startTransition(async () => {
      const endpoint =
        flag === 'partner_benefit'
          ? 'toggle-partner-benefit'
          : 'toggle-cultural-event';
      const result = await postToggle(eventId, endpoint, nextValue);
      // CRIT-5 mirror fix (wave-5): close dialog AFTER the POST
      // resolves so focus stays trapped inside the dialog during
      // in-flight state. Trigger button is disabled via
      // `disabled || pending` so a second click cannot reopen.
      setOpenDialog(null);
      setActiveFlag(null);
      if (result.ok) {
        toast.success(t('successTitle'), {
          description: t('successDescription', {
            count: result.data.registrationsReevaluated,
          }),
        });
        router.refresh();
      } else if (result.status === 409) {
        toast.error(t('archivedTitle'), {
          description: t('archivedDescription'),
        });
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
    <div className="flex flex-wrap items-center gap-2">
      {/* NEW-I3 fix (wave-6): SR loading announcement via sr-only
          role="status" aria-live. `aria-busy` on a `disabled` button
          is an ARIA antipattern — JAWS/NVDA skip the announcement on
          inert elements. A dedicated live region adjacent to the
          buttons gives SR users a coherent "processing …" cue. */}
      <span role="status" aria-live="polite" className="sr-only">
        {activeFlag === 'partner_benefit'
          ? t('loadingPartnerBenefit')
          : activeFlag === 'cultural_event'
            ? t('loadingCulturalEvent')
            : ''}
      </span>
      <AlertDialog
        open={openDialog === 'partner_benefit'}
        onOpenChange={(open) => {
          // NEW-I1 fix (wave-6): guard re-open during in-flight POST
          // here instead of disabling the trigger button. Keeping the
          // trigger focus-able prevents the focus-return-to-disabled
          // bug when the dialog closes while `pending === true`
          // (WCAG 2.4.3 Focus Visible). The `disabled` prop from the
          // parent (parent passes `disabled={!event.archivedAt}`) is
          // still honoured — only the pending-derived disable is moved
          // here.
          if (pending) return;
          setOpenDialog(open ? 'partner_benefit' : null);
        }}
      >
        <AlertDialogTrigger
          render={
            <Button
              variant={isPartnerBenefit ? 'secondary' : 'outline'}
              disabled={disabled}
              aria-disabled={pending}
              type="button"
            />
          }
        >
          <Award aria-hidden="true" data-icon="inline-start" />
          <span>
            {isPartnerBenefit
              ? t('unflagPartnerBenefit')
              : t('flagPartnerBenefit')}
          </span>
          {activeFlag === 'partner_benefit' && (
            <Loader2
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-end"
            />
          )}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPartnerBenefit
                ? t('confirmUnflagPartnerTitle')
                : t('confirmFlagPartnerTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPartnerBenefit
                ? t('confirmUnflagPartnerBody')
                : t('confirmFlagPartnerBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                handleConfirm('partner_benefit', !isPartnerBenefit)
              }
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
            >
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={openDialog === 'cultural_event'}
        onOpenChange={(open) => {
          if (pending) return; // NEW-I1 — see partner_benefit sibling
          setOpenDialog(open ? 'cultural_event' : null);
        }}
      >
        <AlertDialogTrigger
          render={
            <Button
              variant={isCulturalEvent ? 'secondary' : 'outline'}
              disabled={disabled}
              aria-disabled={pending}
              type="button"
            />
          }
        >
          <Sparkles aria-hidden="true" data-icon="inline-start" />
          <span>
            {isCulturalEvent
              ? t('unflagCulturalEvent')
              : t('flagCulturalEvent')}
          </span>
          {activeFlag === 'cultural_event' && (
            <Loader2
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-end"
            />
          )}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isCulturalEvent
                ? t('confirmUnflagCulturalTitle')
                : t('confirmFlagCulturalTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCulturalEvent
                ? t('confirmUnflagCulturalBody')
                : t('confirmFlagCulturalBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                handleConfirm('cultural_event', !isCulturalEvent)
              }
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
            >
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
