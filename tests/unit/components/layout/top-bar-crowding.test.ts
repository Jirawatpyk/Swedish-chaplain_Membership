/**
 * The staff top bar's row measurement (PR #530 follow-up). jsdom has no
 * layout, so each item's box is stubbed.
 */
import { describe, expect, it } from 'vitest';
import { measureRow } from '@/components/layout/top-bar-crowding';

function item(top: number, height: number, width: number): HTMLElement {
  const el = document.createElement('span');
  el.style.display = 'inline-flex';
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, width, left: 0, right: width, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function row(children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div');
  el.append(...children);
  document.body.append(el);
  return el;
}

describe('measureRow', () => {
  // A 36px search button, a 40px avatar and a 44px pill, centred on one line:
  // their tops differ, but they are one row (desktop measured as crowded).
  it('does not call centred controls of different heights a wrap', () => {
    const r = row([item(10, 36, 36), item(8, 40, 64), item(6, 44, 60)]);
    expect(measureRow(r, null, null, 0).wraps).toBe(false);
  });

  it('calls it a wrap when a control starts below another one\'s bottom', () => {
    const r = row([item(10, 88, 88), item(10, 88, 100), item(102, 88, 88)]);
    expect(measureRow(r, null, null, 0).wraps).toBe(true);
  });
});
