/**
 * T048 — E2E: F4 US6 Button cursor + disabled states.
 *
 * Iterates the /__test__/button-matrix fixture page and asserts:
 *   enabled  → cursor: pointer, opacity: 1
 *   disabled → cursor: not-allowed, opacity: 0.5
 */
import { expect, test } from './fixtures';

test.describe('F4 US6 — button cursor/disabled @layout', () => {
  test('every variant × size enforces cursor + opacity rules', async ({ page }) => {
    await page.goto('/__test__/button-matrix');

    const cells = page.locator('[data-testid="button-cell"]');
    const count = await cells.count();
    expect(count).toBeGreaterThan(90); // 6×8×2 = 96

    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      const state = await cell.getAttribute('data-state');
      const { cursor, opacity } = await cell.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { cursor: cs.cursor, opacity: cs.opacity };
      });

      if (state === 'disabled') {
        expect(cursor, `cell ${i} disabled cursor`).toBe('not-allowed');
        expect(parseFloat(opacity), `cell ${i} disabled opacity`).toBeCloseTo(0.5, 2);
      } else {
        expect(cursor, `cell ${i} enabled cursor`).toBe('pointer');
        expect(parseFloat(opacity), `cell ${i} enabled opacity`).toBeCloseTo(1, 2);
      }
    }
  });
});
