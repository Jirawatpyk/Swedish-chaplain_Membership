'use client';

/**
 * F8 Phase 4 Wave I2 · Task 7 — client-safe email preview strip for a
 * single `(tierBucket, offsetDays)` schedule step (spec §5.2, §5.5).
 *
 * Client-bundle-safe by construction: imports only
 * `@/modules/renewals/client` (pure domain constants) — never the
 * infrastructure `copy.ts`, which pulls in the full 3-locale email-copy
 * matrix and is server-only. Importing that here would (a) drag Node-only
 * server code into the browser bundle and risk `check:bundle-budgets`,
 * and (b) violate Clean Architecture layering (Presentation →
 * Infrastructure directly, skipping Application).
 *
 * Scope: this shows WHETHER a message exists for the given timing. It
 * does NOT render the full subject/body copy — that would require a
 * server action to read the infrastructure copy matrix, deferred per
 * spec §9.
 *
 * I4 follow-up fix (`.superpowers/sdd/followup-reminder-uxwave-brief.md`)
 * — the not-covered branch used to be a `<p role="status">` and the
 * covered branch a plain `<div>` with NO role; toggling between them
 * (every timing change) unmounted/remounted the live region, so some
 * screen readers never announced the swap. ONE always-present
 * `role="status"` container now carries both states — only the TEXT
 * inside changes.
 *
 * I6 follow-up fix — the covered-state copy used to read "Email that
 * will be sent", implying a real body preview that spec §9 explicitly
 * defers, and it repeated the plain-language timing sentence a THIRD
 * time (already shown on the StepCard header Badge and the "Send
 * timing" dropdown trigger via `timingSentence`). The reworded heading
 * states the fact without over-promising or re-echoing text already
 * visible elsewhere on the same card.
 */
import { useTranslations } from 'next-intl';
import { TIER_REMINDER_OFFSETS, offsetKeyFromDays } from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';
import { cn } from '@/lib/utils';

export interface EmailPreviewProps {
  readonly tierBucket: TierBucket;
  readonly offsetDays: number;
}

export function EmailPreview({ tierBucket, offsetDays }: EmailPreviewProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const key = offsetKeyFromDays(offsetDays);
  const covered = (TIER_REMINDER_OFFSETS[tierBucket] as readonly string[]).includes(key);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mt-2 rounded-md px-3 py-2 text-xs',
        covered ? 'bg-muted/50 text-muted-foreground' : 'bg-destructive/10 text-destructive',
      )}
    >
      {covered ? t('stepCard.preview.heading') : t('stepCard.preview.noCopyWarning')}
    </div>
  );
}
