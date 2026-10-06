/**
 * Event category toggle buttons (F6 Phase 6 T088).
 *
 * Admin-only client component rendered inside the event-detail header
 * when the viewer is an admin (managers see read-only flags only,
 * matches FR-035 surface-level access matrix).
 *
 * Behaviour:
 *   - Two buttons: "Toggle Partner Benefit" + "Toggle Cultural Event"
 *   - Click → opens the shared confirmation dialog (AURA, spec 122 US9a
 *     T903) confirming the destructive impact
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
import { Award, Sparkles } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

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
  const [, startTransition] = useTransition();
  const [openDialog, setOpenDialog] = useState<'partner_benefit' | 'cultural_event' | null>(null);
  // CRIT-4 fix (wave-5): per-flag busy state so only the button being
  // processed shows it. Both buttons stay click-locked during ANY mid-flight
  // POST (prevents double-submit across flags).
  const [activeFlag, setActiveFlag] = useState<'partner_benefit' | 'cultural_event' | null>(null);

  // The shared dialog awaits this, keeps Confirm busy meanwhile and closes
  // once it resolves (CRIT-5: focus stays in the dialog during the POST).
  async function handleConfirm(flag: 'partner_benefit' | 'cultural_event', nextValue: boolean): Promise<void> {
    setActiveFlag(flag);
    const endpoint = flag === 'partner_benefit' ? 'toggle-partner-benefit' : 'toggle-cultural-event';
    const result = await postToggle(eventId, endpoint, nextValue);
    setActiveFlag(null);
    if (result.ok) {
      toast.success(t('successTitle'), {
        description: t('successDescription', { count: result.data.registrationsReevaluated }),
      });
      startTransition(() => router.refresh());
    } else if (result.status === 409) {
      toast.error(t('archivedTitle'), { description: t('archivedDescription') });
    } else {
      toast.error(t('errorTitle'), {
        description: (typeof result.title === 'string' && result.title) || t('errorDescription'),
      });
    }
  }

  const busy = activeFlag !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* NEW-I3 fix (wave-6): SR loading announcement — a dedicated live
          region beside the buttons gives a coherent "processing …" cue. */}
      <span role="status" aria-live="polite" className="sr-only">
        {activeFlag === 'partner_benefit'
          ? t('loadingPartnerBenefit')
          : activeFlag === 'cultural_event'
            ? t('loadingCulturalEvent')
            : ''}
      </span>
      <Button
        type="button"
        variant="secondary"
        icon={<Award aria-hidden />}
        touchHeight
        disabled={disabled}
        loading={activeFlag === 'partner_benefit'}
        // NEW-I1 (wave-6): the trigger stays focusable during a POST; a
        // re-open is refused instead.
        onClick={() => !busy && setOpenDialog('partner_benefit')}
      >
        {isPartnerBenefit ? t('unflagPartnerBenefit') : t('flagPartnerBenefit')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        icon={<Sparkles aria-hidden />}
        touchHeight
        disabled={disabled}
        loading={activeFlag === 'cultural_event'}
        onClick={() => !busy && setOpenDialog('cultural_event')}
      >
        {isCulturalEvent ? t('unflagCulturalEvent') : t('flagCulturalEvent')}
      </Button>
      <ConfirmationDialog
        open={openDialog === 'partner_benefit'}
        onOpenChange={(open) => {
          if (busy) return;
          setOpenDialog(open ? 'partner_benefit' : null);
        }}
        title={isPartnerBenefit ? t('confirmUnflagPartnerTitle') : t('confirmFlagPartnerTitle')}
        description={isPartnerBenefit ? t('confirmUnflagPartnerBody') : t('confirmFlagPartnerBody')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        destructive
        onConfirm={() => handleConfirm('partner_benefit', !isPartnerBenefit)}
      />
      <ConfirmationDialog
        open={openDialog === 'cultural_event'}
        onOpenChange={(open) => {
          if (busy) return;
          setOpenDialog(open ? 'cultural_event' : null);
        }}
        title={isCulturalEvent ? t('confirmUnflagCulturalTitle') : t('confirmFlagCulturalTitle')}
        description={isCulturalEvent ? t('confirmUnflagCulturalBody') : t('confirmFlagCulturalBody')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        destructive
        onConfirm={() => handleConfirm('cultural_event', !isCulturalEvent)}
      />
    </div>
  );
}
