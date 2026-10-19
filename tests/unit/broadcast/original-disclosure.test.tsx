// @vitest-environment jsdom
/**
 * Spec 122 US12c-1 (maintainer, 19 Oct — board `Admin-eblast-design-mobile`):
 * where the version and the member's original stack (below `lg`), the original
 * folds into a disclosure so the version stays near the top. It is ONE
 * `<details>` at every width — open from `lg`, where its summary is hidden —
 * so the original's sandboxed preview frame is mounted once and never remounts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OriginalDisclosure } from '@/components/broadcast/admin/original-disclosure';

function at(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

describe('OriginalDisclosure', () => {
  afterEach(() => at(1024));

  it('on a phone the original is folded under its summary', () => {
    at(390);
    const { container } = render(
      <OriginalDisclosure summary="Member's original">
        <div data-testid="original-card" />
      </OriginalDisclosure>,
    );
    const details = container.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(screen.getByText("Member's original").tagName).toBe('SUMMARY');
    expect(details.contains(screen.getByTestId('original-card'))).toBe(true);
  });

  it('from lg it is open, with the summary hidden, and the card rendered once', () => {
    at(1440);
    const { container } = render(
      <OriginalDisclosure summary="Member's original">
        <div data-testid="original-card" />
      </OriginalDisclosure>,
    );
    const details = container.querySelector('details')!;
    expect(details.open).toBe(true);
    expect(container.querySelector('summary')!.className).toContain('lg:hidden');
    expect(screen.getAllByTestId('original-card')).toHaveLength(1);
  });
});
