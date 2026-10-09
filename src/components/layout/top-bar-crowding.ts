/**
 * PR #530 follow-up — when the staff top bar's controls cannot fit one row
 * (a 393px phone at 200% text: the 44px controls double to 88px) the language
 * pill leaves the bar and its choice moves into the account menu, so the bar
 * stays one row instead of two (~185px, sticky). At normal text size the pill
 * stays in the bar.
 */

export interface RowMeasure {
  /** The controls sit on more than one line. */
  readonly wraps: boolean;
  /** The row's own width. */
  readonly rowWidth: number;
  /** The width one line needs with the language pill in it. */
  readonly neededWithPill: number;
}

/**
 * Crowded as soon as the row wraps. Once crowded the pill is gone and the row
 * fits, so it un-crowds only when the row has room for the pill again;
 * comparing against the width without it would flip back and forth.
 */
export function nextCrowded(wasCrowded: boolean, m: RowMeasure): boolean {
  if (!wasCrowded) return m.wraps;
  return m.wraps || m.rowWidth < m.neededWithPill;
}

/** The row's flex items: `display: contents` wrappers count as their children, hidden ones not at all. */
export function flexItems(row: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of Array.from(row.children) as HTMLElement[]) {
    const display = getComputedStyle(child).display;
    if (display === 'none') continue;
    if (display === 'contents') items.push(...flexItems(child));
    else items.push(child);
  }
  return items;
}

/**
 * Measures the row. `brand` is the brand box, counted at its min width (it is
 * flex-1 and takes whatever is left); `pillWidth` is the pill's width from
 * when it was last shown, added when it is hidden.
 */
export function measureRow(row: HTMLElement, brand: HTMLElement | null, pill: HTMLElement | null, pillWidth: number): RowMeasure {
  const items = flexItems(row);
  // Centred controls of different heights have different tops on one line;
  // it is a wrap only when one starts below another one's bottom.
  const boxes = items.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
  const wraps = boxes.length > 1 && Math.max(...boxes.map((r) => r.top)) >= Math.min(...boxes.map((r) => r.bottom)) - 1;
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  let needed = 0;
  for (const el of items) {
    needed += el === brand ? parseFloat(getComputedStyle(el).minWidth) || 0 : el.getBoundingClientRect().width;
  }
  const pillShown = pill !== null && items.includes(pill);
  const count = items.length + (pillShown ? 0 : 1);
  needed += (pillShown ? 0 : pillWidth) + gap * Math.max(0, count - 1);
  return { wraps, rowWidth: row.clientWidth, neededWithPill: needed };
}

/**
 * The same decision from the first paint, before anything is measured: the
 * server renders the pill, so at 200% text the bar drew two rows and then
 * jumped to one. In a media query `em` follows the text size, so this matches
 * a 393px phone at about 190% text and up (393 / 16 / 1.9 ≈ 12.9em), not at
 * 100% (24.6em) or 175% (14.04em, where the row still fits). The class hides
 * the pill with no JS; the account menu reads the same query.
 */
export const HUGE_TEXT_QUERY = '(max-width: 14em)';
export const HUGE_TEXT_HIDDEN_CLASS = '[@media(max-width:14em)]:hidden';

