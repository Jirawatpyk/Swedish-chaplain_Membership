/**
 * Unit tests for <BrandMark> — the real TSCC crown logo (three Swedish
 * crowns + Thai-flag brush strokes, referenced from /brand/tscc-mark.svg).
 *
 * Covers the contract every consuming surface relies on:
 *   - decorative by default (aria-hidden, no accessible name) so an adjacent
 *     wordmark isn't double-announced;
 *   - labelled + role="img" when a `title` is supplied (auth pages);
 *   - all three variants keep their viewBox (call-site sizing is unchanged)
 *     and embed the crown artwork via <image href>;
 *   - every variant carries the dark-theme white tile — the artwork's flag
 *     blue is 1.02:1 on dark surfaces and needs it to stay visible;
 *   - wordmark text still reverses via currentColor + root colour utilities,
 *     and the gold rule stays pinned to --brand-accent;
 *   - caller classes compose with the default colour utilities.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrandMark } from '@/components/shell/brand-mark';

afterEach(cleanup);

const MARK_SRC = '/brand/tscc-mark.svg';

describe('<BrandMark>', () => {
  it('is decorative by default (aria-hidden, no img role)', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
  });

  it('exposes an accessible image when titled', () => {
    const { container } = render(<BrandMark title="SweCham — staff" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('SweCham — staff');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('applies the default reversible colour utilities and composes caller classes', () => {
    const { container } = render(<BrandMark className="size-8 shrink-0" />);
    const cls = container.querySelector('svg')!.getAttribute('class') ?? '';
    expect(cls).toContain('text-[#0B2A4A]');
    expect(cls).toContain('dark:text-white');
    expect(cls).toContain('size-8');
    expect(cls).toContain('shrink-0');
  });

  it.each([
    ['mark', '0 0 104 96'],
    ['lockup', '0 0 516 120'],
    ['vertical', '0 0 330 248'],
  ] as const)('renders the %s variant around the crown artwork', (variant, viewBox) => {
    const { container } = render(<BrandMark variant={variant} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(viewBox);
    const image = svg.querySelector('image')!;
    expect(image).toBeTruthy();
    expect(image.getAttribute('href')).toBe(MARK_SRC);
  });

  it.each([['mark'], ['lockup'], ['vertical']] as const)(
    '%s variant carries the dark-theme white tile behind the crowns',
    (variant) => {
      const { container } = render(<BrandMark variant={variant} />);
      const tile = Array.from(container.querySelectorAll('rect')).find((r) =>
        (r.getAttribute('class') ?? '').includes('dark:opacity-100'),
      )!;
      expect(tile).toBeTruthy();
      expect((tile.getAttribute('class') ?? '')).toContain('fill-white');
      expect((tile.getAttribute('class') ?? '')).toContain('opacity-0');
    },
  );

  it('lockup + vertical keep the theme-reversing wordmark and the gold rule', () => {
    for (const variant of ['lockup', 'vertical'] as const) {
      const { container } = render(<BrandMark variant={variant} />);
      const texts = Array.from(container.querySelectorAll('text'));
      expect(texts.some((t) => t.textContent === 'SweCham')).toBe(true);
      expect(texts.some((t) => t.getAttribute('fill') === 'currentColor')).toBe(true);
      const gold = Array.from(container.querySelectorAll('rect')).find(
        (r) => r.getAttribute('fill') === 'var(--brand-accent)',
      );
      expect(gold).toBeTruthy();
      cleanup();
    }
  });

  it('the bare mark renders no wordmark text (adjacent text names the brand)', () => {
    const { container } = render(<BrandMark variant="mark" />);
    expect(container.querySelectorAll('text').length).toBe(0);
  });
});
