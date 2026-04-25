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

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ClockIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

const COUNTDOWN_SECONDS = 60;

export interface HardCapPromptProps {
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}

export function HardCapPrompt({ onContinue, onCancel }: HardCapPromptProps) {
  const t = useTranslations('portal.payment.hardCap');
  const [remaining, setRemaining] = useState<number>(COUNTDOWN_SECONDS);
  const interruptedRef = useRef<boolean>(false);
  // WCAG 2.4.3 Focus Order: alertdialog must receive focus on mount so
  // keyboard + SR users land on the decision target without a stray
  // Tab press (audit 2026-04-25 finding #14).
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueButtonRef.current?.focus();
  }, []);

  // Ticker: decrement once per second.
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (interruptedRef.current) {
          clearInterval(timer);
          return prev;
        }
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Dispatch onCancel when countdown hits zero (separate effect so
  // parent setState is NOT invoked from inside a setState updater —
  // same pattern the ConfirmationPanel uses).
  useEffect(() => {
    if (remaining !== 0 || interruptedRef.current) return;
    onCancel();
  }, [remaining, onCancel]);

  return (
    <section
      role="alertdialog"
      aria-modal="true"
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
          interruptedRef.current = true;
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
        {[30, 10, 5, 1].includes(remaining)
          ? t('autoCancelCountdown', { seconds: remaining })
          : ''}
      </p>
    </section>
  );
}

export default HardCapPrompt;
