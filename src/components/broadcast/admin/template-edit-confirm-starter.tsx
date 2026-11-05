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
import { Alert, IconButton } from '@jirawatpyk/aura-react';

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

  // PR O — AURA's Alert in the warning tone, a polite status named by its
  // title (it should not interrupt). The section keeps the banner a landmark
  // (R3.5 M-14). The dismiss stays our own IconButton because its label
  // names the template, which AURA's `onDismiss` button ("Dismiss") cannot
  // (handoff addendum 97, #196).
  return (
    <section aria-labelledby="starter-edit-banner-title" className="mb-4">
      <Alert
        tone="warning"
        role="status"
        titleId="starter-edit-banner-title"
        title={t('starterEditBannerTitle')}
        action={
          <IconButton
            icon="x"
            variant="ghost"
            touchHeight
            label={t('starterEditBannerDismiss', { name: templateName })}
            onClick={dismiss}
          />
        }
      >
        {t('starterEditBannerBody')}
      </Alert>
    </section>
  );
}
