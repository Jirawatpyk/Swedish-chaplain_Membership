'use client';

/**
 * <HardCapPrompt> — FR-028c "Are you still here?" prompt shown in
 * the drawer body after 30 minutes of open-time (`timeoutExceeded`
 * from `useIdleWarningSuppression`). The 30-min cap covers the
 * pathological case where a member walked away with a 3DS challenge
 * outstanding; without this, the F1 idle-timer is paused for the
 * whole duration and a member session can go indefinitely.
 *
 * 60-second countdown before auto-cancel:
 *   - member clicks Continue → `onContinue()` → parent re-arms the
 *     hook timer via `reset()` → prompt disappears → 30-min clock
 *     starts over.
 *   - countdown hits 0 → `onCancel()` → parent invokes the same
 *     stale-PI-cleanup path as an explicit close (POST /api/
 *     payments/{id}/cancel) and dismisses the drawer.
 *
 * ARIA-live (FR-028j): the prompt is rendered as `role="alertdialog"`
 * with `aria-live="assertive"` so SR users hear it immediately —
 * this is a decision-required surface, not ambient state.
 */

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ClockIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCountdownAutoDismiss } from '@/hooks/use-countdown-auto-dismiss';

const COUNTDOWN_SECONDS = 60;
// R2 F-7 (2026-04-27): module-level constant so we don't allocate a
// new array on every render of the per-second countdown. Mirrors the
// pattern in promptpay-panel.tsx and confirmation-panel.tsx.
const SR_THRESHOLDS: ReadonlyArray<number> = [30, 10, 5, 1];

export interface HardCapPromptProps {
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}

export function HardCapPrompt({ onContinue, onCancel }: HardCapPromptProps) {
  const t = useTranslations('portal.payment.hardCap');
  // WCAG 2.4.3 Focus Order: alertdialog must receive focus on mount so
  // keyboard + SR users land on the decision target without a stray
  // Tab press (audit 2026-04-25 finding #14).
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueButtonRef.current?.focus();
  }, []);

  // shared `useCountdownAutoDismiss` (deduplicated with
  // `<ConfirmationPanel>`). The hook's two-effect split also avoids
  // "Cannot update a component while rendering" when the cancel
  // dispatcher reaches into the parent <PaySheetInternal>'s setState.
  const { remaining, interrupt: interruptCountdown } = useCountdownAutoDismiss(
    COUNTDOWN_SECONDS,
    onCancel,
  );

  return (
    <section
      // R3 I-10: this <section> renders INSIDE Radix <Sheet> (which
      // already provides role="dialog" + aria-modal). Nesting another
      // alertdialog caused JAWS/NVDA to announce "dialog dialog" on
      // mount. Demote to role="alert" — the Sheet is the modality
      // anchor; the alert role still ensures the SR reads the body
      // when this prompt replaces the pay-sheet body.
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="pay-sheet-hard-cap-title"
      aria-describedby="pay-sheet-hard-cap-body"
      data-testid="pay-sheet-hard-cap-prompt"
      className="flex flex-col items-center gap-4 text-center"
    >
      <ClockIcon
        aria-hidden="true"
        className="size-12 text-muted-foreground"
      />
      <h3
        id="pay-sheet-hard-cap-title"
        className="text-h3 font-semibold text-foreground"
      >
        {t('title')}
      </h3>
      <p
        id="pay-sheet-hard-cap-body"
        className="text-body text-muted-foreground"
      >
        {t('body')}
      </p>
      <Button
        ref={continueButtonRef}
        type="button"
        variant="default"
        onClick={() => {
          interruptCountdown();
          onContinue();
        }}
        // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px tap target.
        className="w-full min-h-[44px]"
        data-testid="pay-sheet-hard-cap-continue"
      >
        {t('continue')}
      </Button>
      <p
        className="text-caption text-muted-foreground"
        aria-hidden="true"
        data-testid="pay-sheet-hard-cap-countdown"
      >
        {t('autoCancelCountdown', { seconds: remaining })}
      </p>
      {/* SR-only throttled announcement at 30 / 10 / 5 / 1 s */}
      <p
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="pay-sheet-hard-cap-countdown-sr"
      >
        {SR_THRESHOLDS.includes(remaining)
          ? t('autoCancelCountdown', { seconds: remaining })
          : ''}
      </p>
    </section>
  );
}

export default HardCapPrompt;
