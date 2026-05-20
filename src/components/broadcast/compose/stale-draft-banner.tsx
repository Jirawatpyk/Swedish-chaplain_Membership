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
 * @internal R4.4 L-6 — currently HEADLESS (no production caller).
 * Retained because the F7.1b draft-resume work will wire it into the
 * member compose flow; deleting now would force re-implementation
 * from scratch + lose the R3.5 / R4.1 / R4.3 a11y + WCAG fixes
 * already baked in. Track follow-up wiring under F7.1b backlog.
 *
 * a11y (post-R3.5 + R4.1):
 *   - Outer `<section role="region" aria-labelledby="...">` keeps the
 *     banner reachable via F6 / landmark-navigation in screen readers.
 *   - Inner `<div role="status" aria-live="polite">` announces stale-
 *     draft warnings without interrupting focus.
 *   - Refresh button carries `aria-busy={refreshing}` so SR users hear
 *     the in-flight state during the snapshot re-run.
 *   - Title uses `text-foreground` (overrides inherited
 *     `text-warning-foreground`) and dismiss button uses
 *     `text-foreground` + `ring-ring` (R4.1 C-2) for ≥4.5:1 contrast
 *     on `bg-warning-surface`.
 *   - Dismiss button carries `aria-label` (close + template name).
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
    <section
      role="region"
      aria-labelledby="stale-draft-banner-title"
      className="mb-4 rounded-md border border-warning/30 bg-warning-surface p-4 text-sm"
    >
      {/* R3.5 M-14 — outer landmark + inner status. See template-
          edit-confirm-starter.tsx for the rationale. */}
      {/* R4.3 M-2 — explicit block wrapper instead of
          `className="contents"`. WebKit < 17.4 has known layout bugs
          on `display: contents` boxes with role+aria-live attached;
          the wrapper now participates in normal flow which keeps
          announcements reliable across all evergreen browsers. */}
      <div role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          {/* R3.1 C-1 — explicit text-foreground on title overrides
              inherited text-warning-foreground (calibrated for filled
              bg-warning, not bg-warning-surface). */}
          <p
            id="stale-draft-banner-title"
            className="font-medium text-foreground"
          >
            {t('title')}
          </p>
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
          className="shrink-0 rounded-md p-1 text-foreground hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={t('dismissAria', { templateName })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      </div>
    </section>
  );
}
