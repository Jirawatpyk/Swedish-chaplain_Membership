'use client';

/**
 * Spec 122 US8c-2 (T857) — the invoice settings save bar on AURA `ActionBar`
 * (board `Admin-invoice-settings`: "You have unsaved changes · Discard · Save
 * settings"). It renders only while the form is dirty. A viewport ActionBar
 * sticks to the bottom of the screen while its parent (the form's content
 * column, whose last child it is) is on screen, and stays in the flow at the
 * column's end, so it never covers the last section.
 *
 * Save is the form's submit button while the bar shows (maintainer, 3 Oct:
 * one Save — the form's own Save shows only while nothing has changed), so
 * Enter in a field submits too, and it re-enters the form's own
 * `handleSubmit` and its guards. Discard (maintainer, 3 Oct) resets the form
 * in the browser and sends nothing.
 *
 * Review 23 Oct (WCAG 2.4.11): the bar keeps its own measured height (and its
 * gap above the screen edge) clear below a focused field while it shows. On a
 * phone its status and buttons wrap to about 103px, more than the 5.5rem the
 * stylesheet keeps for every viewport bar, so a field slid under it.
 */
import { useTranslations } from 'next-intl';
import { ActionBar, Button } from '@jirawatpyk/aura-react';
import { useActionBarScrollPadding } from '@/hooks/use-action-bar-clearance';

const BAR_SELECTOR = '.chamber-viewport-actionbar';

export function StickySaveBar({
  visible,
  submitting,
  exists,
  onDiscard,
  discardDisabled = false,
}: {
  readonly visible: boolean;
  readonly submitting: boolean;
  /** False on a first-ever save: the button reads "Create settings". */
  readonly exists: boolean;
  readonly onDiscard: () => void;
  /** While the saved values are on their way back, or a logo upload runs. */
  readonly discardDisabled?: boolean;
}) {
  const t = useTranslations('admin.invoiceSettings');
  useActionBarScrollPadding(visible, BAR_SELECTOR);
  if (!visible) return null;
  return (
    <ActionBar
      // The app's marker for a viewport ActionBar: globals.css keeps a focused
      // field clear of it by this class, not AURA's modifier.
      className="chamber-viewport-actionbar"
      label={t('stickyBar.label')}
      status={t('stickyBar.unsaved')}
      // UX review M5: Discard sits in the start slot as a ghost button, away
      // from the primary Save, so a stray Enter on the wrong button is less likely.
      start={
        <Button type="button" variant="ghost" disabled={submitting || discardDisabled} onClick={onDiscard}>
          {t('stickyBar.discard')}
        </Button>
      }
    >
      {/* 088 FR-036 (44px on phones): the ActionBar sizes its Buttons below
          640px since AURA 5.54, as on every other save bar. */}
      <Button type="submit" loading={submitting}>
        {exists ? t('actions.save') : t('actions.create')}
      </Button>
    </ActionBar>
  );
}
