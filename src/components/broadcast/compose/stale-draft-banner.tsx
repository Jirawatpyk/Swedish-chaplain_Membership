'use client';

/**
 * T117 (F7.1a US7) — Stale draft banner.
 *
 * Per critique E5 + FR-019: when a member loaded a draft >30 days
 * old and the template they snapshotted from has been edited since,
 * surface a banner offering to refresh from the current template
 * version. Re-runs snapshotTemplateToDraft → overwrites the draft
 * body + subject with the latest template content.
 *
 * STANDALONE COMPONENT — the parent consumer page decides WHEN to
 * mount it based on draft.created_at + template.updated_at + 30-day
 * threshold. The draft-load flow at /portal/broadcasts/new doesn't
 * exist in F7.1a (members compose fresh drafts only); the consumer
 * wiring lands at F7.1b when draft-resume is added.
 *
 * UX:
 *   - Sticky-style banner above the compose form
 *   - Title + body explaining the staleness
 *   - "Refresh from current" primary button → fires onRefresh()
 *     callback (parent calls POST /api/member/broadcasts/draft/[id]/
 *     snapshot-template)
 *   - Dismiss button (X) → fires onDismiss() callback (parent can
 *     persist localStorage flag if needed)
 *
 * a11y:
 *   - role="status" + aria-live="polite" so SR users hear the
 *     banner on mount without interrupting
 *   - Dismiss button has aria-label
 *   - Refresh button shows pending state via aria-busy when
 *     `refreshing=true`
 */
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  readonly templateName: string;
  /** True when the parent has fired onRefresh and is awaiting the result. */
  readonly refreshing?: boolean;
  readonly onRefresh: () => void;
  readonly onDismiss: () => void;
}

export function ComposeStaleDraftBanner({
  templateName,
  refreshing = false,
  onRefresh,
  onDismiss,
}: Props): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.staleDraftBanner');

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="font-medium">{t('title')}</p>
          <p className="mt-1 text-muted-foreground">
            {t('body', { templateName })}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              {refreshing ? t('refreshingButton') : t('refreshButton')}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={refreshing}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-amber-100 disabled:opacity-50"
          aria-label={t('dismissAria', { templateName })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
