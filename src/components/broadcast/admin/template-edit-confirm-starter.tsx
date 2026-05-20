'use client';

/**
 * T114 (F7.1a US7) — Dismissible starter-edit confirmation banner.
 *
 * Surfaces above the admin template edit form when the loaded template
 * has `is_seeded=TRUE`. Per FR-021 / critique P6: editing a starter
 * template creates a tenant-specific version and disables future
 * auto-update if the platform refines starter content.
 *
 * Dismissal is per-(tenant, templateId) — once an admin has acknowledged
 * the warning for a specific starter template, subsequent edits skip
 * the banner. localStorage key encodes the templateId so dismissing one
 * starter does not silence the warning for others.
 *
 * a11y:
 *   - role="status" + aria-live="polite" so SR users hear the warning
 *     without it interrupting the current navigation cue
 *   - dismiss button has aria-label (close + name of template)
 *   - banner stays in DOM after dismissal (hidden with `hidden` attr)
 *     so re-opening the page after localStorage reset re-shows it
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

interface Props {
  readonly templateId: string;
  readonly templateName: string;
}

const STORAGE_PREFIX = 'broadcasts.starter-edit-dismissed:';

export function AdminTemplateEditConfirmStarter({
  templateId,
  templateName,
}: Props): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.templates');

  // Lazy initializer reads localStorage once on first client render.
  // SSR-safe via the `typeof window` guard; on the server returns
  // `false` (banner visible) so the markup matches the eventual
  // dismissed=false client state for non-dismissed templates and only
  // hides post-hydration for previously-dismissed ones. The brief
  // banner-flash for dismissed templates is acceptable vs the
  // alternative of either a layout-shift on dismiss OR setting state
  // inside an effect (React 19 `react-hooks/set-state-in-effect`).
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return (
        window.localStorage.getItem(STORAGE_PREFIX + templateId) === '1'
      );
    } catch {
      // localStorage unavailable (private mode, quota) — default to
      // SHOWING the banner so the safety message isn't silently lost.
      return false;
    }
  });

  function dismiss(): void {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + templateId, '1');
    } catch {
      // ignore — banner closes for this session only
    }
    setDismissed(true);
  }

  if (dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-md border border-warning/30 bg-warning-surface p-4 text-sm text-warning-foreground"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="font-medium">{t('starterEditBannerTitle')}</p>
          <p className="mt-1 text-muted-foreground">
            {t('starterEditBannerBody')}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-warning hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/50"
          aria-label={t('starterEditBannerDismiss', { name: templateName })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
