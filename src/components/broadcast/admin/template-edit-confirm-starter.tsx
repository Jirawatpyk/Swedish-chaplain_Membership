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
 * a11y (post-R3.5 + R4.1):
 *   - Outer `<section role="region" aria-labelledby="...">` keeps the
 *     banner reachable via F6 / landmark-navigation in screen readers
 *     even before any state change.
 *   - Inner `<div role="status" aria-live="polite">` announces the
 *     dismiss-state transition (banner removal) without interrupting
 *     focus. Static role="status" on the outer element is silently
 *     dropped by NVDA + VoiceOver, hence the wrapper split.
 *   - Title text uses explicit `text-foreground` to override inherited
 *     `text-warning-foreground` (calibrated for filled `bg-warning`,
 *     not the lighter `bg-warning-surface` used here).
 *   - Dismiss button uses `text-foreground` + `ring-ring` (R4.1 C-2)
 *     for ≥4.5:1 contrast on `bg-warning-surface` — `text-warning`
 *     on that surface measured ~2.6:1 (fails WCAG SC 1.4.3).
 *   - Dismiss button carries `aria-label` (close + template name).
 *   - On dismiss the component `return null`s (NOT hidden with the
 *     HTML `hidden` attribute); re-render after localStorage reset
 *     restores the banner because `useState` reads localStorage on
 *     mount.
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
    <section
      role="region"
      aria-labelledby="starter-edit-banner-title"
      className="mb-4 rounded-md border border-warning/30 bg-warning-surface p-4 text-sm"
    >
      {/* R3.5 M-14 — outer <section role="region" aria-labelledby>
          makes the static-mount banner reachable via F6/landmark
          navigation. role="status" + aria-live="polite" on the inner
          dismissal-state container so SR users get a separate
          announcement when content changes (dismissed=true → hidden).
          Pre-R3.5 the banner was only announced via role="status" on
          mount, which NVDA + VoiceOver drop for static content. */}
      {/* R4.3 M-2 — explicit block wrapper instead of
          `className="contents"`. See sibling stale-draft-banner.tsx
          for the WebKit < 17.4 rationale. */}
      <div role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          {/* R3.1 C-1 — explicit text-foreground on title overrides
              inherited text-warning-foreground (calibrated for filled
              bg-warning, not bg-warning-surface). Body uses muted-fg
              which sits on bg-warning-surface at AA contrast. */}
          <p
            id="starter-edit-banner-title"
            className="font-medium text-foreground"
          >
            {t('starterEditBannerTitle')}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t('starterEditBannerBody')}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-foreground hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('starterEditBannerDismiss', { name: templateName })}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      </div>
    </section>
  );
}
