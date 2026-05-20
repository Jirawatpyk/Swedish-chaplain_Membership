'use client';

/**
 * Stale draft banner (FR-019).
 *
 * Surfaces above the compose form when a member's draft is >30 days
 * old AND the source template has been edited since. `onRefresh` is
 * expected to re-run `snapshotTemplateToDraft` to overwrite the draft
 * body+subject with the latest template content; `onDismiss` lets the
 * consumer persist a localStorage suppress flag.
 *
 * Standalone reusable banner. Consumer wiring lands in F7.1b draft-
 * resume; today the component has no mount-point in production code.
 *
 * a11y: role="status" + aria-live="polite" (announce without
 * interrupting), aria-busy reflects refresh in-flight, dismiss button
 * carries aria-label.
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
      className="mb-4 rounded-md border border-warning/30 bg-warning-surface p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          {/* R3.1 C-1 — explicit text-foreground on title overrides
              inherited text-warning-foreground (calibrated for filled
              bg-warning, not bg-warning-surface). */}
          <p className="font-medium text-foreground">{t('title')}</p>
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
          className="shrink-0 rounded-md p-1 text-warning hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/50 disabled:opacity-50"
          aria-label={t('dismissAria', { templateName })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
