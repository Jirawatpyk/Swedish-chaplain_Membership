'use client';

/**
 * F8 Phase 4 Wave I2 · Task 7 — client-safe email preview strip for a
 * single `(tierBucket, offsetDays)` schedule step (spec §5.2, §5.5).
 *
 * Client-bundle-safe by construction: imports only
 * `@/modules/renewals/client` (pure domain constants) and the sibling
 * `./format-offset` helper (pure, framework-free formatting logic) —
 * never the infrastructure `copy.ts`, which pulls in the full 3-locale
 * email-copy matrix and is server-only. Importing that here would (a)
 * drag Node-only server code into the browser bundle and risk
 * `check:bundle-budgets`, and (b) violate Clean Architecture layering
 * (Presentation → Infrastructure directly, skipping Application).
 *
 * Scope: this shows WHETHER a message exists for the given timing, plus
 * a localized one-line plain-language summary of the timing itself
 * (`timingSentence` from `./format-offset` — v2 rework Issue 4, shared
 * with the StepCard header badge, the "Send timing" dropdown, and
 * `ReminderTimeline`'s SR list). It does NOT render the full
 * subject/body copy — that would require a server action to read the
 * infrastructure copy matrix, deferred per spec §9.
 */
import { useTranslations } from 'next-intl';
import { TIER_REMINDER_OFFSETS, offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';
import { timingSentence } from './format-offset';

export interface EmailPreviewProps {
  readonly tierBucket: TierBucket;
  readonly offsetDays: number;
}

export function EmailPreview({ tierBucket, offsetDays }: EmailPreviewProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const key = offsetKeyFromDays(offsetDays);
  const covered = (TIER_REMINDER_OFFSETS[tierBucket] as readonly string[]).includes(key);

  if (!covered) {
    return (
      <p role="status" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {t('stepCard.preview.noCopyWarning')}
      </p>
    );
  }

  // v2 rework Issue 4 — plain language ("30 days before renewal"), not
  // the cryptic "T-30" form.
  const sentence = timingSentence(offsetDays, t);

  return (
    <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium">{t('stepCard.preview.heading')}:</span> {sentence}
    </div>
  );
}
