/**
 * Spec 122 US1 — the top bar's search button opens the command palette
 * through this window event, the same way `swecham:open-idle-warning` reaches
 * the idle dialog: the palette is mounted once by the layout, far from the
 * button, and neither should import the other.
 */
export const OPEN_COMMAND_PALETTE_EVENT = 'swecham:open-command-palette';

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
