'use client';

/**
 * F8 Phase 4 Wave I2 · Task 7 — client-safe email preview strip for a
 * single `(tierBucket, offsetDays)` schedule step (spec §5.2, §5.5).
 *
 * Client-bundle-safe by construction: imports ONLY
 * `@/modules/renewals/client` (pure domain constants) — never the
 * infrastructure `copy.ts`, which pulls in the full 3-locale email-copy
 * matrix and is server-only. Importing that here would (a) drag
 * Node-only server code into the browser bundle and risk
 * `check:bundle-budgets`, and (b) violate Clean Architecture layering
 * (Presentation → Infrastructure directly, skipping Application).
 *
 * Scope: this shows WHETHER a message exists for the given timing, plus
 * a localized one-line summary of the timing itself (reusing the
 * existing `stepCard.offsetDay.*` sentence fragments already used by
 * `ReminderTimeline`). It does NOT render the full subject/body copy —
 * that would require a server action to read the infrastructure copy
 * matrix, deferred per spec §9.
 */
import { useTranslations } from 'next-intl';
import { TIER_REMINDER_OFFSETS, offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';

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

  const sentence =
    offsetDays === 0
      ? t('stepCard.offsetDay.exact')
      : offsetDays < 0
        ? t('stepCard.offsetDay.before', { days: Math.abs(offsetDays) })
        : t('stepCard.offsetDay.after', { days: offsetDays });

  return (
    <div className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium">{t('stepCard.preview.heading')}:</span> {sentence}
    </div>
  );
}
