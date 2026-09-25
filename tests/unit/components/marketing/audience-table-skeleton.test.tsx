/**
 * 108 PR-D review cycle 11 (UX H5, a11y 9 / L4) — the audience skeleton is
 * shaped like the REAL table: 44-px row pitch (`--table-row-height`), a
 * 44-px header band, and the 8-column shape by default (admin / super_admin /
 * marketing — the common case; the read-only manager is the exception).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AudienceTableSkeleton } from '@/app/(staff)/admin/marketing/audience/_components/audience-table-skeleton';
import { AUDIENCE_MIN_WIDTH } from '@/app/(staff)/admin/marketing/audience/_components/audience-table';

afterEach(() => cleanup());

describe('AudienceTableSkeleton — shape (cycle 11)', () => {
  it('defaults to the 7-column (switch) shape', () => {
    const { container } = render(<AudienceTableSkeleton />);
    const header = container.querySelector('[data-slot="skeleton-header"]');
    expect(header?.children).toHaveLength(7);
  });

  it('read-only viewers get 6 columns', () => {
    const { container } = render(<AudienceTableSkeleton withSwitch={false} />);
    const header = container.querySelector('[data-slot="skeleton-header"]');
    expect(header?.children).toHaveLength(6);
  });

  it('rows and header use the table row-height token (no CLS when the table lands)', () => {
    const { container } = render(<AudienceTableSkeleton />);
    const header = container.querySelector('[data-slot="skeleton-header"]');
    expect(header?.className).toContain('h-[var(--table-row-height)]');
    const rows = container.querySelectorAll('[data-slot="skeleton-row"]');
    expect(rows).toHaveLength(15);
    for (const r of rows) expect(r.className).toContain('h-[var(--table-row-height)]');
  });
});

describe('AudienceTableSkeleton — matches the real table box (cycle 14)', () => {
  it('the body is w-full with a min-width, not a fixed width', () => {
    const { container } = render(<AudienceTableSkeleton />);
    const body = container.querySelector<HTMLElement>('[data-slot="skeleton-body"]');
    expect(body).not.toBeNull();
    expect(body!.className).toContain('w-full');
    expect(body!.style.minWidth).toMatch(/px$/);
    expect(body!.style.width).toBe('');
  });

  it.each([true, false])('withSwitch=%s → same min-width as the real table (no jump when it lands)', (withSwitch) => {
    const skeleton = render(<AudienceTableSkeleton withSwitch={withSwitch} />);
    const body = skeleton.container.querySelector<HTMLElement>('[data-slot="skeleton-body"]');
    const expected = withSwitch ? AUDIENCE_MIN_WIDTH.withSwitch : AUDIENCE_MIN_WIDTH.readOnly;
    expect(body!.style.minWidth).toBe(`${expected}px`);
  });

  it('the Contact track flexes like the real table’s width-less <col>', () => {
    const { container } = render(<AudienceTableSkeleton />);
    const header = container.querySelector<HTMLElement>('[data-slot="skeleton-header"]');
    expect(header!.style.gridTemplateColumns.startsWith('minmax(')).toBe(true);
  });
});
