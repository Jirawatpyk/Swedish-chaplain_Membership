/**
 * True for a plain left click: no modifier and the main button. A modified
 * click opens another tab or window, so a page-link handler leaves it to the
 * browser (pager focus, #775).
 */
export function isPlainClick(e: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly button: number;
}): boolean {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}
