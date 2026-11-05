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
 *   - A `<section aria-label>` (the title) keeps the banner a landmark (F6 /
 *     landmark navigation, R3.5) and is its one name: the Alert inside is
 *     `role="none"`, so the title is not read twice. It is on the page from
 *     mount, so it is not a live region.
 *   - The dismiss is our own IconButton, labelled with the template's name,
 *     placed top right beside the Alert (AURA's `onDismiss` button is
 *     always "Dismiss": stand-in until AURA #196).
 *   - On dismiss the component `return null`s (NOT hidden with the
 *     HTML `hidden` attribute); re-render after localStorage reset
 *     restores the banner because `useState` reads localStorage on
 *     mount.
 */
import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, IconButton } from '@jirawatpyk/aura-react';

interface Props {
  readonly templateId: string;
  readonly templateName: string;
}

const STORAGE_PREFIX = 'broadcasts.starter-edit-dismissed:';

function readDismissed(templateId: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + templateId) === '1';
  } catch {
    // localStorage unavailable (private mode, quota) — default to SHOWING
    // the banner so the safety message isn't silently lost.
    return false;
  }
}

function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

export function AdminTemplateEditConfirmStarter({
  templateId,
  templateName,
}: Props): React.ReactElement | null {
  const t = useTranslations('admin.broadcasts.templates');

  // The stored dismissal is read through useSyncExternalStore: the server
  // snapshot is `false` (banner shown), so hydration matches the server
  // markup, and the client then reads localStorage without a hydration
  // mismatch or a set-state-in-effect (PR O review). A storage event from
  // another tab updates it too.
  const storedDismissed = useSyncExternalStore(
    subscribeToStorage,
    () => readDismissed(templateId),
    () => false,
  );
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = storedDismissed || dismissedNow;

  function dismiss(): void {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + templateId, '1');
    } catch {
      // ignore — banner closes for this session only
    }
    setDismissedNow(true);
    // The button leaves the page with the banner: put focus on the main
    // region rather than let it fall back to <body> (WCAG 2.4.3).
    document.getElementById('main-content')?.focus();
  }

  if (dismissed) {
    return null;
  }

  // PR O — AURA's Alert in the warning tone. The dismiss follows it in the
  // reading order (title, body, dismiss) and sits top right, where AURA's
  // own close button would be.
  return (
    <section aria-label={t('starterEditBannerTitle')} className="relative mb-4">
      {/* role="none": the section is the one named landmark, so the title
          is read once (PR O review); the banner is on the page from mount,
          so it is not a live region. */}
      <Alert tone="warning" role="none" title={t('starterEditBannerTitle')} className="pe-12">
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
