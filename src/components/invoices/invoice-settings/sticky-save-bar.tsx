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
      edgeBelow="sm"
      // The app's marker for a viewport ActionBar: globals.css keeps a focused
      // field clear of it by this class, not AURA's modifier.
      // `invoice-settings-actions`: how the buttons share the bar (globals.css).
      className="chamber-viewport-actionbar invoice-settings-actions"
      label={t('stickyBar.label')}
      status={t('stickyBar.unsaved')}
    >
      {/* PR #697 review (maintainer, 30 Oct): Discard sits beside Save, as
          Cancel does on every form bar and as the board draws it (it was
          the start slot, which AURA puts at the far left, UX review M5). On
          a phone Discard takes a third and Save two thirds (globals.css).
          088 FR-036 (44px on phones): the ActionBar sizes its Buttons below
          640px since AURA 5.54, as on every other save bar. */}
      <Button type="button" variant="secondary" disabled={submitting || discardDisabled} onClick={onDiscard}>
        {t('stickyBar.discard')}
      </Button>
      <Button type="submit" loading={submitting}>
        {exists ? t('actions.save') : t('actions.create')}
      </Button>
    </ActionBar>
  );
}
