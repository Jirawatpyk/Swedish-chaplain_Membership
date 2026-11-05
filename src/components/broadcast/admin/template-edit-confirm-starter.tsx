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
 * a11y (PR O, on AURA):
 *   - A `<section aria-labelledby>` keeps the banner a landmark (F6 /
 *     landmark navigation, R3.5).
 *   - The banner is AURA's warning Alert as a `note`, named by its title:
 *     it is on the page from mount, so it is not a live region (a status
 *     mounted with its text is not announced anyway, review L1).
 *   - The dismiss is our own IconButton, labelled with the template's name,
 *     placed top right beside the Alert (AURA's `onDismiss` button is
 *     always "Dismiss": stand-in until AURA #196).
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

  // PR O — AURA's Alert in the warning tone. The dismiss follows it in the
  // reading order (title, body, dismiss) and sits top right, where AURA's
  // own close button would be.
  return (
    <section aria-labelledby="starter-edit-banner-title" className="relative mb-4">
      <Alert
        tone="warning"
        role="note"
        titleId="starter-edit-banner-title"
        title={t('starterEditBannerTitle')}
        className="pe-12"
      >
        {t('starterEditBannerBody')}
      </Alert>
      {/* stand-in until AURA #196: AURA's `onDismiss` can't take this label. */}
      <IconButton
        icon="x"
        variant="ghost"
        touchHeight
        className="absolute end-1 top-1"
        label={t('starterEditBannerDismiss', { name: templateName })}
        onClick={dismiss}
      />
    </section>
  );
}
