'use client';

/**
 * Spec 122 US8c-2 (T857) — the invoice settings save bar on AURA `ActionBar`
 * (board `Admin-invoice-settings`: "You have unsaved changes · Discard · Save
 * settings"). It renders only while the form is dirty. A viewport ActionBar
 * sticks to the bottom of the screen while its parent (the form's content
 * column, whose last child it is) is on screen, and stays in the flow at the
 * column's end, so it never covers the last section.
 *
 * Save never calls `fetch`: the form passes `requestSubmit()`, which re-enters
 * the form's own `handleSubmit` and its guards. Discard (maintainer, 3 Oct)
 * resets the form in the browser and sends nothing.
 */
import { useTranslations } from 'next-intl';
import { ActionBar, Button } from '@jirawatpyk/aura-react';

export function StickySaveBar({
  visible,
  submitting,
  onSave,
  onDiscard,
  discardDisabled = false,
}: {
  readonly visible: boolean;
  readonly submitting: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  /** While the saved values are on their way back, or a logo upload runs. */
  readonly discardDisabled?: boolean;
}) {
  const t = useTranslations('admin.invoiceSettings');
  if (!visible) return null;
  return (
    <ActionBar
      // The app's marker for a viewport ActionBar: globals.css keeps a focused
      // field clear of it by this class, not AURA's modifier.
      className="chamber-viewport-actionbar"
      label={t('stickyBar.label')}
      status={t('stickyBar.unsaved')}
    >
      <Button type="button" variant="secondary" className="min-h-11" disabled={submitting || discardDisabled} onClick={onDiscard}>
        {t('stickyBar.discard')}
      </Button>
      {/* 088 FR-036 — 44px at every width, also in the compact staff density. */}
      <Button type="button" className="min-h-11" loading={submitting} onClick={onSave}>
        {t('actions.save')}
      </Button>
    </ActionBar>
  );
}
