/**
 * Spec 122 (2026-10-15, AURA #146; UX review) — a list's own Clear button can
 * sit inside AURA's phone Filters sheet, where pressing it unmounts it. The
 * search the bar would normally focus is behind the modal sheet, so focus
 * goes to the sheet's Done instead (as AURA's own sheet Clear all does).
 *
 * Call it first in the Clear handler, while the pressed button still has
 * focus; it returns null outside the sheet.
 */
export function filterSheetDoneButton(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const sheet = document.activeElement?.closest('.aura-filterbar__sheet');
  if (!sheet) return null;
  const buttons = sheet.querySelectorAll<HTMLElement>('.aura-dialog__foot button');
  return buttons[buttons.length - 1] ?? null;
}
